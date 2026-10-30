import { createHash } from "node:crypto";
import { assertInteractionResponse, type InteractionRequested, type InteractionResponse, type InteractionResult } from "@anureo/protocol";
import { HarnessSdkError, sdkError, waitForRequest } from "./errors";
import type { NativeInteractionResponder } from "./ports";

interface RecordState {
  request: InteractionRequested;
  responder: NativeInteractionResponder;
  state: "pending" | "responding" | "resolved";
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: InteractionResponse) => void;
  reject: (cause: unknown) => void;
  responseRequestId?: string;
  responseFingerprint?: string;
  responseOperation?: Promise<InteractionResult>;
}
export class InteractionRegistry {
  private readonly records = new Map<string, RecordState>();
  constructor(
    private readonly publish: (result: InteractionResult) => Promise<void>,
    private readonly limits: { maxPending: number; timeoutMs: number; responseTimeoutMs?: number },
    private readonly beforeResponse?: (request: InteractionRequested, response: InteractionResponse) => void,
  ) {}
  get pendingCount(): number { return [...this.records.values()].filter((record) => record.state !== "resolved").length; }
  pending(): InteractionRequested[] { return [...this.records.values()].filter((record) => record.state === "pending").map((record) => structuredClone(record.request)); }
  begin(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (this.records.has(request.interactionId)) throw new HarnessSdkError("INTERACTION_ALREADY_EXISTS");
    if (this.pendingCount >= this.limits.maxPending) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Pending interaction limit exceeded");
    const ttl = request.expiresAt ? Math.min(this.limits.timeoutMs, new Date(request.expiresAt).getTime() - Date.now()) : this.limits.timeoutMs;
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
  async respond(id: string, requestId: string, response: InteractionResponse): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    assertInteractionResponse(record.request, response);
    this.beforeResponse?.(record.request, response);
    const fingerprint = createHash("sha256").update(JSON.stringify(response)).digest("hex");
    if (record.responseRequestId === requestId && record.responseFingerprint === fingerprint && record.responseOperation) return record.responseOperation;
    if (record.state !== "pending") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    record.state = "responding"; record.responseRequestId = requestId; record.responseFingerprint = fingerprint; clearTimeout(record.timer);
    record.responseOperation = (async () => {
      try {
        await waitForRequest(() => record.responder(response), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 });
        if (record.state === "resolved") throw new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true);
        const result: InteractionResult = { interactionId: id, outcome: "responded" };
        record.state = "resolved"; await this.publish(result); record.resolve(response); return result;
      } catch (cause) {
        const error = sdkError(cause, "RESULT_UNKNOWN", true);
        if (record.state !== "resolved") { record.state = "resolved"; await this.publish({ interactionId: id, outcome: "unknown", reason: error.code }); }
        record.reject(error); throw error;
      }
    })();
    return record.responseOperation;
  }
  async cancel(id: string, reason = "cancelled", outcome: "cancelled" | "expired" | "unknown" = "cancelled"): Promise<InteractionResult> {
    const record = this.records.get(id);
    if (!record) throw new HarnessSdkError("INTERACTION_EXPIRED");
    if (record.state === "resolved") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
    if (record.state === "responding") {
      if (reason === "cancelled") throw new HarnessSdkError("INTERACTION_ALREADY_RESOLVED");
      record.state = "resolved"; clearTimeout(record.timer);
      const result: InteractionResult = { interactionId: id, outcome: "unknown", reason };
      try { await this.publish(result); } finally { record.reject(new HarnessSdkError("RESULT_UNKNOWN", "Interaction ended while response was in flight", false, true)); }
      return result;
    }
    record.state = "responding"; clearTimeout(record.timer);
    try { await waitForRequest(() => record.responder(null, reason), { timeoutMs: this.limits.responseTimeoutMs ?? 30_000 }); }
    catch { outcome = "unknown"; }
    record.state = "resolved";
    const result: InteractionResult = { interactionId: id, outcome, reason };
    try { await this.publish(result); } finally { record.reject(new HarnessSdkError(outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_CANCELLED", "Interaction is no longer actionable", false, outcome === "unknown")); }
    return result;
  }
  async cancelAll(reason: string, turnId?: string): Promise<void> {
    const ids = [...this.records].filter(([, record]) => record.state !== "resolved" && (turnId === undefined || record.request.turnId === turnId)).map(([id]) => id);
    await Promise.allSettled(ids.map((id) => this.cancel(id, reason, reason === "connection_lost" ? "unknown" : "cancelled")));
  }
  async resolveExternally(result: InteractionResult): Promise<void> {
    const record = this.records.get(result.interactionId);
    if (!record || record.state === "resolved") return;
    record.state = "resolved"; clearTimeout(record.timer);
    try { await this.publish(result); }
    finally { record.reject(new HarnessSdkError(result.outcome === "unknown" ? "RESULT_UNKNOWN" : "INTERACTION_ALREADY_RESOLVED", "Interaction was resolved by the native peer", false, result.outcome === "unknown")); }
  }
}
