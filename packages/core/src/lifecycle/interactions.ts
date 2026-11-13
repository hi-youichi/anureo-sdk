// Owns bounded native interaction settlement and replay; must not run host handlers or project private content.
import { createHash } from "node:crypto";
import { assertInteractionResponse, type InteractionRequested, type InteractionResponse, type InteractionResult } from "@anureo/protocol";
import { HarnessSdkError, sdkError } from "../errors";
import { waitForRequest } from "../request";
import type { NativeInteractionResponder } from "../ports";

/** begin allocates this state; settlement retains it as a replay guard until later admission evicts it. */
interface RecordState {
  request: InteractionRequested;
  responder: NativeInteractionResponder;
  /** Settling includes response delivery and cancellation notification, both of which hold capacity. */
  state: "pending" | "settling" | "resolved";
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: InteractionResponse) => void;
  reject: (cause: unknown) => void;
  /** The request identity must match the payload fingerprint before a retry can reuse the operation. */
  responseRequestId?: string;
  responseFingerprint?: string;
  responseOperation?: Promise<InteractionResult>;
}
/**
 * InteractionRegistry.begin uses the returned duration before allocating its expiry timer. Clamp an
 * optional request expiry to the configured interaction lifetime; invalid or elapsed deadlines are
 * rejected by begin.
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

/**
 * Tracks native interactions for Session and direct registry consumers. Session supplies publication
 * and privacy hooks and owns automatic handlers; this registry owns expiry and bounded replay state.
 * Consumers must settle outstanding requests or call cancelAll when releasing their session.
 */
export class InteractionRegistry {
  private readonly records = new Map<string, RecordState>();
  /**
   * Session constructor supplies a publisher that aborts the host handler and awaits an
   * interaction/resolved event, plus a secret-registration check before native delivery. Configure
   * settlement publication and pre-response checks without starting native work. respond invokes the
   * check even on retries; its throw prevents delivery. Settlement awaits the publisher without a
   * deadline, so consumers must ensure it completes; responseTimeoutMs bounds only native calls.
   */
  constructor(
    private readonly publish: (result: InteractionResult) => Promise<void>,
    private readonly limits: { maxPending: number; timeoutMs: number; responseTimeoutMs?: number },
    private readonly beforeResponse?: (request: InteractionRequested, response: InteractionResponse) => void,
  ) {}
  /**
   * begin uses this count for admission. Count pending and settling requests so in-flight native work
   * continues to consume capacity; resolved replay guards do not.
   */
  get pendingCount(): number {
    return [...this.records.values()].filter((record) => record.state !== "resolved").length;
  }
  /**
   * Direct registry consumers can enumerate manually answerable requests without mutating replay
   * state. Return detached copies of actionable requests only; settling/resolved entries cannot accept
   * a new answer. Cloning failures throw without changing registry state.
   */
  pending(): InteractionRequested[] {
    return [...this.records.values()]
      .filter((record) => record.state === "pending")
      .map((record) => structuredClone(record.request));
  }
  /**
   * Session.requestInteraction returns this promise after publishing the request and scheduling any
   * host handler. Register a unique unexpired request and unrefed expiry timer; throw on
   * duplicates/capacity/expiry. The returned promise resolves only after native response and
   * publication. Other settlements reject it, subject to deliverResponse's publication-failure case.
   * The caller still owns requested-event publication and native callback resources.
   */
  begin(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (this.records.has(request.interactionId)) throw new HarnessSdkError("INTERACTION_ALREADY_EXISTS");
    if (this.pendingCount >= this.limits.maxPending) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Pending interaction limit exceeded");
    const ttl = interactionTtl(request, this.limits.timeoutMs);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new HarnessSdkError("INTERACTION_EXPIRED");
    // Resolved records are retained only as a bounded replay guard. Unresolved records are never evicted.
    if (this.records.size >= this.limits.maxPending + 1024) {
      for (const [id, record] of this.records) {
        if (record.state === "resolved") {
          this.records.delete(id);
          break;
        }
      }
    }
    const result = new Promise<InteractionResponse>((resolve, reject) => {
      /** The expiry timer invokes cancel; its failure is observed here while settlement owns the waiter. */
      const timer = setTimeout(() => { void this.cancel(request.interactionId, "timeout", "expired").catch(() => {}); }, ttl);
      timer.unref?.();
      this.records.set(request.interactionId, { request: structuredClone(request), responder, state: "pending", timer, resolve, reject });
    });
    // An adapter can still attach its await after the event publication; retain rejection observation meanwhile.
    void result.catch(() => {});
    return result;
  }
  /**
   * Session.executeRequest routes manual interaction/respond here; Session.startInteractionHandler
   * awaits it for automatic answers. Validate and run the supplied pre-response check before
   * replay checks or native delivery; only matching request IDs and serialized payloads reuse a cached
   * outcome, including failures. Reject missing, invalid or conflicting answers without native work.
   * Clear expiry and retain capacity before deliverResponse starts; return its result or rejection.
   */
  async respond(id: string, requestId: string, response: InteractionResponse): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    assertInteractionResponse(record.request, response);
    this.beforeResponse?.(record.request, response);
    const fingerprint = responseFingerprint(response);
    if (record.responseRequestId === requestId && record.responseFingerprint === fingerprint && record.responseOperation) {
      return record.responseOperation;
    }
    if (record.state !== "pending") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    record.state = "settling";
    record.responseRequestId = requestId;
    record.responseFingerprint = fingerprint;
    clearTimeout(record.timer);
    record.responseOperation = this.deliverResponse({ id, record, response });
    return record.responseOperation;
  }
  /**
   * respond caches this operation after admission. Bound native delivery without retrying it, then
   * publish before resolving begin's waiter. If delivery succeeds after another settlement resolves
   * the record, reject with RESULT_UNKNOWN without publishing again. Normalize delivery/publication failures for
   * both callers. If publishing the unknown outcome itself fails, that failure escapes before the
   * original waiter is rejected. Cancellation uses publishRejectedSettlement's finally instead.
   */
  private async deliverResponse({ id, record, response }: {
    id: string; record: RecordState; response: InteractionResponse;
  }): Promise<InteractionResult> {
    try {
      await waitForRequest(() => record.responder(response), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 });
      if (record.state === "resolved") throw new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true);
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
   * Session.executeRequest routes explicit cancellation here; startInteractionHandler uses it for
   * handler failures, begin registers an expiry callback, and cancelAll uses it during teardown.
   * Missing IDs reject INTERACTION_EXPIRED; resolved IDs reject INTERACTION_ALREADY_RESOLVED.
   * Cancel or expire an unresolved request, notifying native once when pending. Non-cancellation
   * during settling marks outcome unknown. Only the literal reason "cancelled" refuses an in-flight
   * settlement; custom reasons end it without another native call. Publish then reject begin's waiter,
   * even if publication fails; return the result or propagate that publication failure.
   */
  async cancel(id: string, reason = "cancelled", outcome: "cancelled" | "expired" | "unknown" = "cancelled"): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    if (record.state === "resolved") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    if (record.state === "settling") {
      // Only the literal "cancelled" refuses to end an in-flight operation; other reasons mark its result unknown.
      if (reason === "cancelled") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
      record.state = "resolved";
      clearTimeout(record.timer);
      const result: InteractionResult = { interactionId: id, outcome: "unknown", reason };
      await this.publishRejectedSettlement({ record, result, error: new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true) });
      return result;
    }
    return this.cancelPending({ id, record, reason, outcome });
  }
  /**
   * cancel calls only for an actionable record. Hold capacity and clear expiry before notifying native;
   * timeout or notification failure changes the requested outcome to unknown. Release capacity before
   * publication, then reject begin's waiter even if publication fails. Never retry native cancellation.
   */
  private async cancelPending({ id, record, reason, outcome }: {
    id: string; record: RecordState; reason: string; outcome: "cancelled" | "expired" | "unknown";
  }): Promise<InteractionResult> {
    record.state = "settling";
    clearTimeout(record.timer);
    try { await waitForRequest(() => record.responder(null, reason), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 }); }
    catch { outcome = "unknown"; }
    record.state = "resolved";
    const result: InteractionResult = { interactionId: id, outcome, reason };
    await this.publishRejectedSettlement({
      record, result,
      error: new HarnessSdkError(outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_CANCELLED", "Interaction is no longer actionable", false, outcome === "unknown"),
    });
    return result;
  }
  /**
   * Session.fail, finishClose and dispose await this during teardown. Attempt concurrent cancellation
   * of unresolved interactions, optionally limited to turnId; await every attempt and suppress
   * individual failures for teardown owners. Connection loss requests an unknown outcome.
   */
  async cancelAll(reason: string, turnId?: string): Promise<void> {
    const ids = [...this.records]
      .filter(([, record]) => record.state !== "resolved" && (turnId === undefined || record.request.turnId === turnId))
      .map(([id]) => id);
    await Promise.allSettled(ids.map((id) => this.cancel(id, reason, reason === "connection_lost" ? "unknown" : "cancelled")));
  }
  /**
   * Session.resolveInteraction returns this promise to adapters reporting an already-settled native
   * request. Publish native-side settlement without calling the responder; ignore unknown/resolved IDs
   * and reject the waiter even for responded because no value is supplied. Clear expiry and release
   * capacity before publication; publication failure rejects this call but still rejects the waiter.
   */
  async resolveExternally(result: InteractionResult): Promise<void> {
    const record = this.records.get(result.interactionId);
    if (!record || record.state === "resolved") return;
    record.state = "resolved";
    clearTimeout(record.timer);
    await this.publishRejectedSettlement({
      record, result,
      error: new HarnessSdkError(result.outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_ALREADY_RESOLVED", "Interaction was resolved by the native peer", false, result.outcome === "unknown"),
    });
  }
  /**
   * cancel, cancelPending and resolveExternally call after marking the record resolved. Await the
   * supplied publisher before rejecting begin's waiter, including when publication fails. Keep the
   * waiter's lifecycle error separate from the publication failure returned to the settlement caller.
   * State transitions and timer cleanup remain with those callers.
   */
  private async publishRejectedSettlement({ record, result, error }: {
    record: RecordState; result: InteractionResult; error: HarnessSdkError;
  }): Promise<void> {
    try { await this.publish(result); }
    finally { record.reject(error); }
  }
}
