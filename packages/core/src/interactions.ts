// Owns bounded native interaction settlement and replay; must not run host handlers or project private content.
import { createHash } from "node:crypto";
import { assertInteractionResponse, type InteractionRequested, type InteractionResponse, type InteractionResult } from "@anureo/protocol";
import { HarnessSdkError, sdkError } from "./sdk-error";
import { waitForRequest } from "./request";
import type { NativeInteractionResponder } from "./ports";

/** Per-request lifecycle state retained for settlement and a bounded replay guard. */
interface RecordState {
  request: InteractionRequested;
  responder: NativeInteractionResponder;
  // Settling covers native calls for both a response and a cancellation notification.
  state: "pending" | "settling" | "resolved";
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: InteractionResponse) => void;
  reject: (cause: unknown) => void;
  responseRequestId?: string;
  responseFingerprint?: string;
  responseOperation?: Promise<InteractionResult>;
}
/** Clamp an optional request expiry to the configured interaction lifetime; invalid or elapsed deadlines are rejected by begin. */
function interactionTtl(request: InteractionRequested, timeoutMs: number): number {
  return request.expiresAt ? Math.min(timeoutMs, new Date(request.expiresAt).getTime() - Date.now()) : timeoutMs;
}

/** Hash the response payload for exact replay detection; the request ID alone cannot distinguish conflicting retries. */
function responseFingerprint(response: InteractionResponse): string {
  return createHash("sha256").update(JSON.stringify(response)).digest("hex");
}

/** Owns bounded interaction settlement/replay state; Session callers publish results and own host handlers/privacy projection. */
export class InteractionRegistry {
  private readonly records = new Map<string, RecordState>();
  /** Configure settlement publication and pre-response checks; callbacks may reject/throw, while native work is bounded separately. */
  constructor(
    private readonly publish: (result: InteractionResult) => Promise<void>,
    private readonly limits: { maxPending: number; timeoutMs: number; responseTimeoutMs?: number },
    private readonly beforeResponse?: (request: InteractionRequested, response: InteractionResponse) => void,
  ) {}
  /** Count pending and settling requests so in-flight native work continues to consume capacity; resolved replay guards do not. */
  get pendingCount(): number { return [...this.records.values()].filter((record) => record.state !== "resolved").length; }
  /** Return detached copies of actionable requests only; settling/resolved entries cannot be answered again. */
  pending(): InteractionRequested[] { return [...this.records.values()].filter((record) => record.state === "pending").map((record) => structuredClone(record.request)); }
  /** Register a unique unexpired request and unrefed expiry timer; throw on duplicates/capacity/expiry. The returned promise resolves only after native response and publication, and rejects for other settlements. */
  begin(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (this.records.has(request.interactionId)) throw new HarnessSdkError("INTERACTION_ALREADY_EXISTS");
    if (this.pendingCount >= this.limits.maxPending) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Pending interaction limit exceeded");
    const ttl = interactionTtl(request, this.limits.timeoutMs);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new HarnessSdkError("INTERACTION_EXPIRED");
    // Resolved records are retained only as a bounded replay guard. Unresolved records are never evicted.
    if (this.records.size >= this.limits.maxPending + 1024) {
      for (const [id, record] of this.records) if (record.state === "resolved") { this.records.delete(id); break; }
    }
    const result = new Promise<InteractionResponse>((resolve, reject) => {
      const timer = setTimeout(() => { void this.cancel(request.interactionId, "timeout", "expired").catch(() => {}); }, ttl);
      timer.unref?.();
      this.records.set(request.interactionId, { request: structuredClone(request), responder, state: "pending", timer, resolve, reject });
    });
    // An adapter can still attach its await after the event publication; retain rejection observation meanwhile.
    void result.catch(() => {});
    return result;
  }
  /** Validate/project before native delivery; replay identical request IDs and reject conflicts. Expiry is cleared before dispatch; publish completes before the original waiter resolves. */
  async respond(id: string, requestId: string, response: InteractionResponse): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    assertInteractionResponse(record.request, response);
    this.beforeResponse?.(record.request, response);
    const fingerprint = responseFingerprint(response);
    if (record.responseRequestId === requestId && record.responseFingerprint === fingerprint && record.responseOperation) return record.responseOperation;
    if (record.state !== "pending") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    record.state = "settling"; record.responseRequestId = requestId; record.responseFingerprint = fingerprint; clearTimeout(record.timer);
    record.responseOperation = (async () => {
      try {
        await waitForRequest(() => record.responder(response), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 });
        if (record.state === "resolved") throw new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true);
        const result: InteractionResult = { interactionId: id, outcome: "responded" };
        // Mark the interaction no longer actionable before publishing or settling the waiter.
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
    })();
    return record.responseOperation;
  }
  /** Cancel or expire an unresolved request, notifying native once when pending. Non-cancellation during settling marks outcome unknown. Publish then reject its waiter, even if publication fails. */
  async cancel(id: string, reason = "cancelled", outcome: "cancelled" | "expired" | "unknown" = "cancelled"): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    if (record.state === "resolved") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    if (record.state === "settling") {
      // Only the literal "cancelled" refuses to end an in-flight operation; other reasons mark its result unknown.
      if (reason === "cancelled") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
      record.state = "resolved"; clearTimeout(record.timer);
      const result: InteractionResult = { interactionId: id, outcome: "unknown", reason };
      try { await this.publish(result); } finally { record.reject(new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true)); }
      return result;
    }
    record.state = "settling"; clearTimeout(record.timer);
    try { await waitForRequest(() => record.responder(null, reason), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 }); }
    catch { outcome = "unknown"; }
    record.state = "resolved";
    const result: InteractionResult = { interactionId: id, outcome, reason };
    try { await this.publish(result); } finally { record.reject(new HarnessSdkError(outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_CANCELLED", "Interaction is no longer actionable", false, outcome === "unknown")); }
    return result;
  }
  /** Attempt concurrent cancellation of matching unresolved interactions; await every attempt and suppress individual failures for teardown owners. */
  async cancelAll(reason: string, turnId?: string): Promise<void> {
    const ids = [...this.records].filter(([, record]) => record.state !== "resolved" && (turnId === undefined || record.request.turnId === turnId)).map(([id]) => id);
    await Promise.allSettled(ids.map((id) => this.cancel(id, reason, reason === "connection_lost" ? "unknown" : "cancelled")));
  }
  /** Publish native-side settlement without calling the responder; ignore unknown/resolved IDs and reject the waiter even for responded because no value is supplied. */
  async resolveExternally(result: InteractionResult): Promise<void> {
    const record = this.records.get(result.interactionId);
    if (!record || record.state === "resolved") return;
    record.state = "resolved"; clearTimeout(record.timer);
    try { await this.publish(result); }
    finally { record.reject(new HarnessSdkError(result.outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_ALREADY_RESOLVED", "Interaction was resolved by the native peer", false, result.outcome === "unknown")); }
  }
}
