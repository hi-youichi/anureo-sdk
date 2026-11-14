// Owns native interaction capacity, expiry, settlement and response replay.
import { createHash } from "node:crypto";
import { assertInteractionResponse, type InteractionRequested, type InteractionResponse, type InteractionResult } from "@anureo/protocol";
import { HarnessSdkError, sdkError } from "../errors";
import { waitForRequest } from "../request";
import type { NativeInteractionResponder } from "../ports";

/**
 * Track native requests, settle their answers and retain bounded response replay state.
 * Session uses this SDK implementation helper and supplies publication and privacy hooks.
 * Direct consumers own those integrations and should await cancelAll with a teardown reason
 * when releasing a session. The registry owns request expiry and native response wait timers.
 */
export class InteractionRegistry {
  /**
   * Configure settlement publication and synchronous pre-response checks without starting native
   * work. Session supplies a publisher that aborts the host handler and awaits publication of
   * interaction/resolved while observation is open. It also supplies SecretRedactor.rememberResponse
   * to register secrets before delivery. respond runs the check for every validated attempt, including
   * replays, and propagates a throw before delivery. Settlement awaits publication without a deadline.
   */
  constructor(
    private readonly publish: (result: InteractionResult) => Promise<void>,
    private readonly limits: {
      /** Pending and settling capacity. Admission trims resolved records at maxPending + 1024. */
      maxPending: number;
      /** Interaction lifetime in milliseconds, shortened by an earlier request expiresAt. */
      timeoutMs: number;
      /** Native response/cancellation wait in milliseconds, defaulting to 30,000. Native work can continue after timeout. */
      responseTimeoutMs?: number;
    },
    private readonly beforeResponse?: (request: InteractionRequested, response: InteractionResponse) => void,
  ) {}
  /**
   * Count requests that consume admission capacity in begin, including native delivery and
   * cancellation in flight. Capacity becomes available when a request is marked resolved.
   */
  get pendingCount(): number {
    return [...this.records.values()].filter((record) => record.state !== "resolved").length;
  }
  /**
   * List detached copies of actionable requests for manual answering. Cloning failures throw
   * without changing registry state. These copies retain native fields, so callers own projection
   * before exposing them to observers.
   */
  pending(): InteractionRequested[] {
    return [...this.records.values()]
      .filter((record) => record.state === "pending")
      .map((record) => structuredClone(record.request));
  }
  /**
   * Register a unique unexpired request and an unrefed expiry timer. Duplicate IDs, exhausted
   * capacity and invalid/elapsed lifetimes throw synchronously. A request-cloning failure rejects
   * the returned promise after the expiry timer is scheduled. On success, the promise resolves
   * with the answer after native delivery and result publication.
   * Cancellation and peer settlement reject it after publication is attempted. If native delivery
   * fails and publishing its unknown outcome also fails, this waiter stays unresolved; respond
   * rejects the publication failure instead.
   * Session.requestInteraction adopts this promise after publishing interaction/requested and
   * scheduling any host handler. Adapters supply the responder through that sink method and own
   * the native resources it uses.
   */
  begin(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (this.records.has(request.interactionId)) throw new HarnessSdkError("INTERACTION_ALREADY_EXISTS");
    if (this.pendingCount >= this.limits.maxPending) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Pending interaction limit exceeded");
    const ttl = interactionTtl(request, this.limits.timeoutMs);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new HarnessSdkError("INTERACTION_EXPIRED");
    this.evictOldestResolvedRecord();
    const result = new Promise<InteractionResponse>((resolve, reject) => {
      // Expiry has no caller to receive cancellation failure. Settlement owns the request waiter.
      const timer = setTimeout(() => { void this.cancel(request.interactionId, "timeout", "expired").catch(() => {}); }, ttl);
      timer.unref?.();
      this.records.set(request.interactionId, { request: structuredClone(request), responder, state: "pending", timer, resolve, reject });
    });
    // An adapter can still attach its await after the event publication; retain rejection observation meanwhile.
    void result.catch(() => {});
    return result;
  }
  /**
   * Deliver an answer or replay the retained operation for the same request ID and serialized
   * response. Validation and the synchronous pre-response hook run before any replay or delivery.
   * Missing IDs reject with INTERACTION_EXPIRED. Conflicting answers to settling or resolved
   * requests reject with INTERACTION_ALREADY_RESOLVED. The operation clears expiry, retains
   * capacity during native delivery, and settles after the publication it initiates. If another
   * settlement wins during delivery, late native success rejects with RESULT_UNKNOWN.
   * Session.invokeRequest returns the promise for manual requests. Session.startInteractionHandler
   * awaits it for automatic answers and attempts handler_failed cancellation on rejection while
   * its signal remains active.
   */
  async respond(id: string, requestId: string, response: InteractionResponse): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    assertInteractionResponse(record.request, response);
    this.beforeResponse?.(record.request, response);
    const fingerprint = responseFingerprint(response);
    const replay = record.responseReplay;
    if (replay && replay.requestId === requestId && replay.fingerprint === fingerprint) {
      return replay.operation;
    }
    if (record.state !== "pending") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    // The responder can reenter synchronously. Mark the request settling before invoking it.
    startSettlement(record);
    const operation = this.deliverResponse({ id, record, response });
    record.responseReplay = { requestId, fingerprint, operation };
    return operation;
  }
  /**
   * Cancel or expire an unresolved request, notifying native once when pending. The reason and
   * outcome both default to "cancelled". Missing IDs reject with INTERACTION_EXPIRED. Resolved IDs
   * and in-flight settlement with reason "cancelled" reject with INTERACTION_ALREADY_RESOLVED.
   * Other reasons mark in-flight settlement unknown without another native call. Native notification
   * failure or timeout also changes the outcome to unknown.
   * Await publication, reject begin's waiter with INTERACTION_CANCELLED or RESULT_UNKNOWN, and
   * return the outcome. If publication fails, the cancellation caller receives that failure and
   * the original waiter still receives its lifecycle error. Session.invokeRequest returns this
   * promise for manual cancellation. Session.startInteractionHandler and the expiry timer observe
   * and suppress its rejection. cancelAll collects its outcome during teardown.
   */
  async cancel(id: string, reason = "cancelled", outcome: CancellationOutcome = "cancelled"): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    if (record.state === "resolved") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    if (record.state === "pending") return this.cancelPending({ id, record, reason, outcome });
    if (reason === "cancelled") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    record.state = "resolved";
    clearTimeout(record.timer);
    const result: InteractionResult = { interactionId: id, outcome: "unknown", reason };
    await this.publishRejectedSettlement({ record, result, error: endedInFlight() });
    return result;
  }
  /**
   * Attempt concurrent cancellation of unresolved interactions, optionally limited to turnId; await
   * every attempt and suppress individual failures. Session.fail, Session.finishClose and
   * Session.dispose await this before releasing the backend. Use a reason other than "cancelled"
   * to settle in-flight requests. The literal reason "connection_lost" requests an unknown outcome.
   */
  async cancelAll(reason: string, turnId?: string): Promise<void> {
    const ids = [...this.records]
      .filter(([, record]) => record.state !== "resolved" && (turnId === undefined || record.request.turnId === turnId))
      .map(([id]) => id);
    const outcome = reason === "connection_lost" ? "unknown" : "cancelled";
    await Promise.allSettled(ids.map((id) => this.cancel(id, reason, outcome)));
  }
  /**
   * Publish native-side settlement without calling the responder; ignore unknown/resolved IDs
   * and reject the waiter even for responded because no value is supplied. Clear expiry and release
   * capacity before publication; publication failure rejects this call but still rejects the waiter.
   * An unknown outcome rejects the waiter with RESULT_UNKNOWN; other outcomes use INTERACTION_ALREADY_RESOLVED.
   * Session.resolveInteraction returns this promise to adapters reporting an already-settled native request.
   */
  async resolveExternally(result: InteractionResult): Promise<void> {
    const record = this.records.get(result.interactionId);
    if (!record || record.state === "resolved") return;
    record.state = "resolved";
    clearTimeout(record.timer);
    await this.publishRejectedSettlement({
      record, result,
      error: new HarnessSdkError(
        result.outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_ALREADY_RESOLVED",
        "Interaction was resolved by the native peer",
        false,
        result.outcome === "unknown",
      ),
    });
  }

  private readonly records = new Map<string, RecordState>();

  /**
   * begin calls after admission checks, before inserting a new request. At the replay bound, evict
   * only the oldest resolved record so unresolved native work and its capacity remain accounted for.
   * Duplicate checks run first: a retained ID cannot be reused by evicting its own replay guard.
   */
  private evictOldestResolvedRecord(): void {
    const atReplayLimit = this.records.size >= this.limits.maxPending + 1024;
    if (!atReplayLimit) return;
    for (const [id, record] of this.records) {
      if (record.state === "resolved") {
        this.records.delete(id);
        return;
      }
    }
  }

  /**
   * respond caches this operation after admission. Bound native delivery without retrying it, then
   * publish before resolving begin's waiter. If delivery succeeds after another settlement resolves
   * the record, reject with RESULT_UNKNOWN without publishing again. Normalize delivery/publication
   * failures for both callers. If publishing the unknown outcome itself fails, that failure escapes
   * before the original waiter is rejected. Cancellation uses publishRejectedSettlement's finally instead.
   */
  private async deliverResponse({ id, record, response }: {
    id: string; record: RecordState; response: InteractionResponse;
  }): Promise<InteractionResult> {
    try {
      await this.notifyNative(record, response);
      if (record.state === "resolved") throw endedInFlight();
      const result: InteractionResult = { interactionId: id, outcome: "responded" };
      // Release capacity before publication, but never release the waiter before publication finishes.
      record.state = "resolved";
      await this.publish(result);
      record.resolve(response);
      return result;
    } catch (cause) {
      // This also catches publication failures, not just responder failures.
      const error = sdkError(cause, "RESULT_UNKNOWN", true);
      if (record.state !== "resolved") {
        record.state = "resolved";
        await this.publish({ interactionId: id, outcome: "unknown", reason: error.code });
      }
      record.reject(error);
      throw error;
    }
  }
  /**
   * cancel calls only for an actionable record. Hold capacity and clear expiry before notifying native;
   * timeout or notification failure changes the requested outcome to unknown. Release capacity before
   * publication, then reject begin's waiter even if publication fails. Once started, this attempt
   * still publishes after its native wait, even if teardown or peer settlement has already published.
   */
  private async cancelPending({ id, record, reason, outcome }: {
    id: string; record: RecordState; reason: string; outcome: CancellationOutcome;
  }): Promise<InteractionResult> {
    startSettlement(record);
    try {
      await this.notifyNative(record, null, reason);
    } catch {
      outcome = "unknown";
    }
    record.state = "resolved";
    const result: InteractionResult = { interactionId: id, outcome, reason };
    const outcomeUnknown = outcome === "unknown";
    await this.publishRejectedSettlement({
      record, result,
      error: new HarnessSdkError(
        outcomeUnknown ? "RESULT_UNKNOWN" : "INTERACTION_CANCELLED",
        "Interaction is no longer actionable",
        false,
        outcomeUnknown,
      ),
    });
    return result;
  }
  /**
   * Wait for publication before rejecting begin's waiter with its lifecycle error. A publication
   * failure still reaches cancel, cancelPending or resolveExternally. Those callers clear expiry
   * and release capacity before entering this step.
   */
  private async publishRejectedSettlement({ record, result, error }: {
    record: RecordState; result: InteractionResult; error: HarnessSdkError;
  }): Promise<void> {
    try { await this.publish(result); }
    finally { record.reject(error); }
  }

  /**
   * Bound one invocation of the adapter's registered callback. deliverResponse supplies the answer
   * and cancelPending supplies null and a reason. Both await and classify native errors or timeout.
   * A timeout ends the registry's wait and keeps observing late rejection. The adapter still owns
   * completion and native resource cleanup.
   */
  private notifyNative(record: RecordState, ...args: Parameters<NativeInteractionResponder>): Promise<void> {
    return waitForRequest(() => record.responder(...args), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 });
  }
}

type CancellationOutcome = "cancelled" | "expired" | "unknown";

/** begin allocates this state; settlement retains it as a replay guard until later admission evicts it. */
interface RecordState {
  request: InteractionRequested;
  responder: NativeInteractionResponder;
  /** Settling includes response delivery and cancellation notification, both of which hold capacity. */
  state: "pending" | "settling" | "resolved";
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: InteractionResponse) => void;
  reject: (cause: unknown) => void;
  /** Matching retries reuse this operation, including a rejected result, until the record is evicted. */
  responseReplay?: { requestId: string; fingerprint: string; operation: Promise<InteractionResult> };
}

/** Hold admission capacity and clear expiry before respond or cancelPending invokes the adapter. */
function startSettlement(record: RecordState): void {
  record.state = "settling";
  clearTimeout(record.timer);
}

/** Share the unknown-outcome error between in-flight teardown and a superseded response delivery. */
function endedInFlight(): HarnessSdkError {
  return new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true);
}

/**
 * InteractionRegistry.begin uses the returned duration before allocating its expiry timer. Clamp a
 * nonempty request expiry to the configured interaction lifetime; omitted/empty expiry uses the full
 * lifetime. begin rejects a non-finite or non-positive result before allocating its timer.
 */
function interactionTtl(request: InteractionRequested, timeoutMs: number): number {
  return request.expiresAt ? Math.min(timeoutMs, new Date(request.expiresAt).getTime() - Date.now()) : timeoutMs;
}

/**
 * InteractionRegistry.respond stores and compares this fingerprint before deciding whether to replay
 * the response promise. Hash the serialized payload for replay detection; the request ID alone
 * cannot distinguish conflicting retries.
 */
function responseFingerprint(response: InteractionResponse): string {
  return createHash("sha256").update(JSON.stringify(response)).digest("hex");
}
