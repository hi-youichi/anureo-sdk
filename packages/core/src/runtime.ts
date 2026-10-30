import { randomUUID } from "node:crypto";
import {
  assertEvent, assertRequest, assertResult, negotiateVersion, supportsCapability, supportsExtension, validateJsonSchema,
  type Capabilities, type AhpEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap,
  type InitializeParams, type InitializeResult, type InteractionRequested, type InteractionResponse,
  type Item, type SessionBinding, type SessionOpenParams, type SessionState,
} from "@anureo/protocol";
import { HarnessSdkError, sdkError, waitForRequest, type RequestOptions } from "./errors";
import { InteractionRegistry } from "./interactions";
import { BoundedEventQueue } from "./queue";
import { SecretRedactor } from "./secrets";
import type { BackendSession, EventScope, HarnessAdapter, HarnessRuntime, HarnessSession, NativeInteractionResponder, RuntimeOptions, SessionEventSink, SessionMethod } from "./ports";

function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown): void => { if (entry && typeof entry === "object") { for (const child of Object.values(entry)) freeze(child); Object.freeze(entry); } };
  freeze(copy); return copy;
}
function wireError(cause: unknown): { code: string; message: string; retryable: boolean; outcomeUnknown: boolean } {
  const error = sdkError(cause, "PROTOCOL_ERROR", true);
  return { code: error.code, message: error.code, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown };
}

export class ManagedHarnessSession implements HarnessSession, SessionEventSink {
  private _binding: SessionBinding;
  private _capabilities: Capabilities;
  private readonly queue: BoundedEventQueue<AhpEvent>;
  private readonly interactions: InteractionRegistry;
  private readonly streamId: string;
  private seq = 0;
  private activeTurnId?: string;
  private readonly started = new Set<string>();
  private readonly ended = new Set<string>();
  private readonly deliveredStarted = new Set<string>();
  private readonly deliveredEnded = new Set<string>();
  private readonly items = new Map<string, { item: Item; completed: boolean }>();
  private backend?: BackendSession;
  private closed = false;
  private recovering = false;
  private controlBusy = false;
  private maintenancePending = false;
  private emitter: Promise<void> = Promise.resolve();
  private pendingEmissions = 0;
  private disposePromise?: Promise<void>;
  private failurePromise?: Promise<void>;
  private failureCause?: HarnessSdkError;
  private emergencyPublication = false;
  private backendDisposal?: Promise<void>;
  private requests = new Map<string, { fingerprint: string; result: Promise<unknown>; settled: boolean }>();
  private state: SessionState;
  private readonly createId: () => string;
  private readonly secrets: SecretRedactor;

  constructor(binding: SessionBinding, capabilities: Capabilities, private readonly options: RuntimeOptions = {}, initial?: Pick<SessionOpenParams, "config" | "model">, private readonly clientCapabilities?: Capabilities) {
    this.createId = options.createId ?? randomUUID;
    this._binding = immutable(binding); this._capabilities = immutable(capabilities);
    this.secrets = new SecretRedactor((value) => this.options.onMarkedSecret?.(this.binding, value));
    this.streamId = this.createId(); this.queue = new BoundedEventQueue({ ...options.queue, maxControlEvents: (options.maxPendingInteractions ?? 32) + 1 });
    this.state = { binding: structuredClone(binding), capabilities: structuredClone(capabilities), config: structuredClone(initial?.config ?? {}), ...(initial?.model ? { model: initial.model } : {}), status: "opening", capabilityRevision: 1 };
    this.interactions = new InteractionRegistry(async (payload) => {
      const event: AhpEventPayload = { type: "interaction/resolved", payload };
      if (this.emergencyPublication) { this.queue.pushControl(this.makeEvent(event, {})); this.seq++; }
      else await this.emit(event);
    }, { maxPending: options.maxPendingInteractions ?? 32, timeoutMs: options.interactionTimeoutMs ?? 600_000, responseTimeoutMs: options.requestTimeoutMs }, (request, response) => this.secrets.rememberResponse(request, response));
  }
  get binding(): Readonly<SessionBinding> { return this._binding; }
  get capabilities(): Readonly<Capabilities> { return this._capabilities; }
  get isClosed(): boolean { return this.closed; }
  get snapshot(): SessionState { return this.secrets.state(structuredClone(this.state)); }
  events(): AsyncIterable<AhpEvent> { return this.queue; }

  reserveFork(binding: SessionBinding): () => void {
    this.requireBackend();
    if (binding.adapterId !== this.binding.adapterId || binding.runtimeConfigId !== this.binding.runtimeConfigId) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    if (this.activeTurnId || this.controlBusy || this.maintenancePending) throw new HarnessSdkError("SESSION_BUSY");
    this.controlBusy = true;
    return () => { this.controlBusy = false; };
  }

  async attach(backend: BackendSession): Promise<void> {
    if (this.backend) throw new HarnessSdkError("PROTOCOL_ERROR", "Backend already attached");
    for (const key of ["sessionId", "adapterId", "runtimeConfigId"] as const) if (backend.binding[key] !== this.binding[key]) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    if (this.closed) { await backend.dispose(); throw this.failureCause ?? new HarnessSdkError("STREAM_CLOSED", "Session closed before backend attachment", false, true); }
    this.backend = backend; this._binding = immutable(backend.binding); this._capabilities = immutable(backend.capabilities);
    this.state = { ...this.state, binding: structuredClone(backend.binding), capabilities: structuredClone(backend.capabilities), status: this.activeTurnId ? "running" : "ready" };
    await this.emit({ type: "session/state", payload: this.snapshot });
  }

  private makeEvent(payload: AhpEventPayload, scope: EventScope): AhpEvent {
    payload = this.secrets.event(payload);
    const turnId = scope.turnId ?? ((payload.type === "turn/started" || payload.type === "turn/completed") ? payload.payload.turnId : undefined);
    const itemId = scope.itemId ?? (payload.type === "item/delta" ? payload.payload.itemId : payload.type === "item/started" || payload.type === "item/completed" ? payload.payload.item.id : undefined);
    const event: AhpEvent = { sessionId: this.binding.sessionId, streamId: this.streamId, seq: this.seq + 1, timestamp: (this.options.now ?? (() => new Date().toISOString()))(), ...scope, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}), ...payload };
    assertEvent(event); return event;
  }
  private prepare(payload: AhpEventPayload, scope: EventScope): boolean {
    if (payload.type === "turn/started") {
      const id = payload.payload.turnId;
      if (this.ended.has(id) || this.started.has(id)) return false;
      if (this.activeTurnId && this.activeTurnId !== id) throw new HarnessSdkError("PROTOCOL_ERROR", "Concurrent native turns");
      this.activeTurnId = id; this.started.add(id); this.state.status = "running"; this.state.activeTurnId = id;
    } else if (payload.type === "turn/completed") {
      const id = payload.payload.turnId;
      if (this.ended.has(id)) return false;
      if (!this.started.has(id)) throw new HarnessSdkError("PROTOCOL_ERROR", "Turn completed without started");
      this.ended.add(id);
      if (this.activeTurnId === id) { this.activeTurnId = undefined; delete this.state.activeTurnId; this.state.status = this.recovering ? "recoveryRequired" : "ready"; }
    } else if (payload.type === "item/started" || payload.type === "item/completed" || payload.type === "item/delta") {
      const turnId = scope.turnId;
      if (!turnId || !this.started.has(turnId) || this.ended.has(turnId)) throw new HarnessSdkError("PROTOCOL_ERROR", "Item outside an active turn");
      const itemId = payload.type === "item/delta" ? payload.payload.itemId : payload.payload.item.id;
      const key = JSON.stringify([turnId, itemId]); const previous = this.items.get(key);
      if (payload.type === "item/started") {
        if (previous) throw new HarnessSdkError("PROTOCOL_ERROR", "Duplicate item started");
        this.items.set(key, { item: structuredClone(payload.payload.item), completed: false });
      } else if (payload.type === "item/completed") {
        if (previous?.completed) return false;
        // Some native protocols emit only completed items. Consumers still receive a full authority snapshot.
        this.items.set(key, { item: structuredClone(payload.payload.item), completed: true });
      } else if (!previous || previous.completed) throw new HarnessSdkError("PROTOCOL_ERROR", "Delta without an open item");
    } else if (payload.type === "session/state") {
      if (payload.payload.binding.sessionId !== this.binding.sessionId || payload.payload.binding.adapterId !== this.binding.adapterId || payload.payload.binding.runtimeConfigId !== this.binding.runtimeConfigId) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
      this.state = { ...structuredClone(payload.payload), metadata: { ...this.state.metadata, ...structuredClone(payload.payload.metadata) } }; this._capabilities = immutable(payload.payload.capabilities); this._binding = immutable(payload.payload.binding);
      if (["ready", "closed"].includes(payload.payload.status) && !this.activeTurnId) this.maintenancePending = false;
    } else if (payload.type === "session/metadata") {
      this.state.metadata = { ...this.state.metadata, ...structuredClone(payload.payload) };
    } else if (payload.type === "extension" && !supportsExtension(this.capabilities, payload.payload.name, payload.payload.version)) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    return true;
  }
  private accepted(payload: AhpEventPayload): void {
    this.seq++;
    if (payload.type === "turn/started") this.deliveredStarted.add(payload.payload.turnId);
    if (payload.type === "turn/completed") this.deliveredEnded.add(payload.payload.turnId);
  }
  emit(payload: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError("STREAM_CLOSED"));
    if (++this.pendingEmissions > (this.options.queue?.maxWaitingWriters ?? 32)) {
      this.pendingEmissions--; const error = new HarnessSdkError("BACKPRESSURE_EXCEEDED"); void this.fail(error); return Promise.reject(error);
    }
    const task = this.emitter.then(async () => {
      if (!this.prepare(payload, scope)) return;
      const event = this.makeEvent(payload, scope); await this.queue.write(event, () => this.accepted(payload));
      if (payload.type === "turn/completed") void this.interactions.cancelAll("turn_ended", payload.payload.turnId);
    });
    this.emitter = task.catch(() => {});
    return task.catch(async (cause) => { await this.fail(cause); throw cause; }).finally(() => { this.pendingEmissions--; });
  }
  tryEmit(payload: AhpEventPayload, scope: EventScope = {}): boolean {
    try {
      if (this.closed) return false;
      if (this.pendingEmissions > 0) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      const event = this.makeEvent(payload, scope); this.queue.assertWritable(event);
      if (!this.prepare(payload, scope)) return true;
      this.queue.push(event); this.accepted(payload);
      if (payload.type === "turn/completed") void this.interactions.cancelAll("turn_ended", payload.payload.turnId);
      return true;
    } catch (cause) { void this.fail(cause); return false; }
  }
  async requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (!this.capabilities.interactions?.includes(request.kind) || !this.clientCapabilities?.interactions?.includes(request.kind)) {
      await responder(null, "unsupported").catch(() => {}); throw new HarnessSdkError("INTERACTION_UNSUPPORTED");
    }
    let result: Promise<InteractionResponse>;
    try { result = this.interactions.begin(request, responder); }
    catch (cause) { await responder(null, "interaction_rejected").catch(() => {}); throw cause; }
    await this.emit({ type: "interaction/requested", payload: request }, { turnId: request.turnId, itemId: request.itemId });
    return result;
  }
  async resolveInteraction(result: AhpResultMap["interaction/respond"]): Promise<void> {
    assertResult("interaction/respond", result); await this.interactions.resolveExternally(result);
  }
  fail(cause: unknown): Promise<void> {
    return this.failurePromise ??= this.performFailure(cause);
  }
  private async performFailure(cause: unknown): Promise<void> {
    if (this.closed) return;
    this.failureCause = sdkError(cause, "STREAM_FAILED", true);
    this.closed = true; this.recovering = true; this.state.status = "recoveryRequired";
    const error = wireError(cause); const turnId = this.activeTurnId ?? [...this.deliveredStarted].find((id) => !this.deliveredEnded.has(id));
    this.emergencyPublication = true;
    await this.interactions.cancelAll("connection_lost");
    if (turnId && this.deliveredStarted.has(turnId) && !this.deliveredEnded.has(turnId)) {
      this.ended.add(turnId); this.activeTurnId = undefined;
      const event = this.makeEvent({ type: "turn/completed", payload: { turnId, status: "failed", error } }, { turnId });
      this.accepted(event); this.queue.endWithControl(event);
    } else this.queue.end(sdkError(cause, "STREAM_FAILED", true));
    await this.disposeBackend().catch(() => {});
  }
  private requireBackend(method?: SessionMethod): BackendSession {
    if (this.recovering && method !== "history/read" && method !== "turn/interrupt") throw new HarnessSdkError("RECOVERY_REQUIRED");
    if (this.closed) throw new HarnessSdkError("SESSION_CLOSED");
    if (!this.backend) throw new HarnessSdkError("SESSION_NOT_READY");
    return this.backend;
  }
  private guard<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): void {
    assertRequest(method, params);
    if (params.sessionId !== this.binding.sessionId) throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    const unsupported = () => { throw new HarnessSdkError("CAPABILITY_UNSUPPORTED"); };
    if (method === "turn/steer" && !supportsCapability(this.capabilities, "turn.steer")) unsupported();
    if (method === "turn/interrupt" && !supportsCapability(this.capabilities, "turn.interrupt")) unsupported();
    if (method === "session/revert" && !supportsCapability(this.capabilities, "session.revert", (params as AhpRequestMap["session/revert"]).scope)) unsupported();
    if (method === "history/read" && !supportsCapability(this.capabilities, "session.history")) unsupported();
    if ((method === "goal/set" || method === "goal/clear") && !supportsCapability(this.capabilities, "goal.actions", method.split("/")[1])) unsupported();
    if (method === "compact/start" && !this.capabilities.compact) unsupported();
    if (method === "review/start" && !this.capabilities.review) unsupported();
    if (method === "turn/start") {
      const start = params as AhpRequestMap["turn/start"];
      if (start.outputSchema !== undefined && !this.capabilities.turn?.outputSchema) unsupported();
      const modalities = this.capabilities.turn?.inputModalities ?? ["text"];
      if (start.input.some((block) => !modalities.includes(block.type))) unsupported();
      if (start.overrides && Object.keys(start.overrides).some((key) => !this.capabilities.turn?.overrides?.includes(key))) unsupported();
    }
    if (method === "session/config/set") {
      const patch = (params as AhpRequestMap["session/config/set"]).patch;
      for (const [key, value] of Object.entries(patch)) {
        const option = this.capabilities.config?.options.find((option) => option.id === key && option.scope === "session");
        if (!option) unsupported();
        if (option && !validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Config value does not match schema");
      }
    }
  }
  private call<M extends SessionMethod>(method: M, params: AhpRequestMap[M], options: RequestOptions = {}): Promise<AhpResultMap[M]> {
    if (options.signal?.aborted) return Promise.reject(new HarnessSdkError("REQUEST_ABORTED"));
    try { this.guard(method, params); } catch (cause) { return Promise.reject(cause); }
    const key = JSON.stringify([method, params.requestId]); const fingerprint = JSON.stringify(params);
    const previous = this.requests.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.result as Promise<AhpResultMap[M]> : Promise.reject(new HarnessSdkError("REQUEST_ID_CONFLICT"));
    const cacheLimit = this.options.requestCacheSize ?? 1024;
    if (this.requests.size >= cacheLimit) {
      for (const [id, entry] of this.requests) if (entry.settled) { this.requests.delete(id); break; }
      if (this.requests.size >= cacheLimit) return Promise.reject(new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Request limit exceeded"));
    }
    const result = waitForRequest(async () => {
      const backend = this.requireBackend(method);
      if (method === "interaction/respond") { const answer = params as AhpRequestMap["interaction/respond"]; return await this.interactions.respond(answer.interactionId, answer.requestId, answer.response) as AhpResultMap[M]; }
      if (method === "interaction/cancel") { const cancel = params as AhpRequestMap["interaction/cancel"]; return await this.interactions.cancel(cancel.interactionId, cancel.reason) as AhpResultMap[M]; }
      const execution = method === "turn/start" || method === "review/start";
      const exclusive = execution || method === "session/config/set" || method === "session/revert" || method === "session/close" || method === "compact/start" || method === "goal/set" || method === "goal/clear";
      if (exclusive && (this.activeTurnId || this.controlBusy || this.maintenancePending)) throw new HarnessSdkError("SESSION_BUSY");
      if (method === "turn/steer" && this.activeTurnId !== (params as AhpRequestMap["turn/steer"]).expectedTurnId) throw new HarnessSdkError("TURN_MISMATCH");
      if (method === "turn/interrupt" && this.activeTurnId !== (params as AhpRequestMap["turn/interrupt"]).turnId) throw new HarnessSdkError("TURN_MISMATCH");
      if (exclusive) this.controlBusy = true;
      if (method === "compact/start") { this.maintenancePending = true; this.state.status = "running"; await this.emit({ type: "session/state", payload: this.snapshot }); }
      const turnId = execution ? (params as AhpRequestMap["turn/start"] | AhpRequestMap["review/start"]).turnId : undefined;
      if (turnId) { if (this.started.has(turnId) || this.ended.has(turnId)) { this.controlBusy = false; throw new HarnessSdkError("TURN_ID_CONFLICT"); } this.activeTurnId = turnId; }
      try {
        let value = await backend.execute(method, params); assertResult(method, value);
        value = this.secrets.result(method, value); assertResult(method, value);
        // A ready snapshot emitted after dispatch can arrive before the command
        // acknowledgement. Do not re-lock a maintenance action already confirmed done.
        if (method === "compact/start" && (value as AhpResultMap["compact/start"]).status === "accepted" && !this.maintenancePending) value = { ...(value as AhpResultMap["compact/start"]), status: "completed" } as AhpResultMap[M];
        if (method === "compact/start" && (value as AhpResultMap["compact/start"]).status === "completed") { this.maintenancePending = false; this.state.status = "ready"; await this.emit({ type: "session/state", payload: this.snapshot }); }
        if (method === "session/config/set") this.state = structuredClone(value as SessionState);
        if (method === "session/revert") {
          const nativeRef = (value as AhpResultMap["session/revert"]).nativeRef;
          if (nativeRef) {
            this._binding = immutable({ ...this.binding, nativeRef });
            this.state.binding = structuredClone(this.binding);
          }
        }
        if (method === "history/read") {
          let page = this.secrets.history(value as AhpResultMap["history/read"]);
          if (this.options.redactHistory) page = await this.options.redactHistory(this.binding, page);
          assertResult("history/read", page); return page as AhpResultMap[M];
        }
        return value;
      } catch (cause) {
        if (method === "compact/start" && !sdkError(cause).outcomeUnknown) { this.maintenancePending = false; this.state.status = "ready"; await this.emit({ type: "session/state", payload: this.snapshot }).catch(() => {}); }
        if (turnId && this.started.has(turnId) && !this.ended.has(turnId)) await this.fail(cause);
        else if (turnId && this.activeTurnId === turnId) this.activeTurnId = undefined;
        throw cause;
      } finally { if (exclusive) this.controlBusy = false; }
    }, options, this.options.requestTimeoutMs).catch((cause) => {
      if (sdkError(cause).outcomeUnknown) { this.recovering = true; this.state.status = "recoveryRequired"; }
      throw cause;
    });
    this.requests.set(key, { fingerprint, result, settled: false });
    void result.finally(() => { const entry = this.requests.get(key); if (entry) entry.settled = true; }).catch(() => {});
    return result;
  }
  startTurn(params: AhpRequestMap["turn/start"], options?: RequestOptions) { return this.call("turn/start", params, options); }
  steer(params: AhpRequestMap["turn/steer"], options?: RequestOptions) { return this.call("turn/steer", params, options); }
  interrupt(params: AhpRequestMap["turn/interrupt"], options?: RequestOptions) { return this.call("turn/interrupt", params, options); }
  respond(params: AhpRequestMap["interaction/respond"], options?: RequestOptions) { return this.call("interaction/respond", params, options); }
  cancelInteraction(params: AhpRequestMap["interaction/cancel"], options?: RequestOptions) { return this.call("interaction/cancel", params, options); }
  setConfig(params: AhpRequestMap["session/config/set"], options?: RequestOptions) { return this.call("session/config/set", params, options); }
  revert(params: AhpRequestMap["session/revert"], options?: RequestOptions) { return this.call("session/revert", params, options); }
  readHistory(params: AhpRequestMap["history/read"], options?: RequestOptions) { return this.call("history/read", params, options); }
  setGoal(params: AhpRequestMap["goal/set"], options?: RequestOptions) { return this.call("goal/set", params, options); }
  clearGoal(params: AhpRequestMap["goal/clear"], options?: RequestOptions) { return this.call("goal/clear", params, options); }
  compact(params: AhpRequestMap["compact/start"], options?: RequestOptions) { return this.call("compact/start", params, options); }
  review(params: AhpRequestMap["review/start"], options?: RequestOptions) { return this.call("review/start", params, options); }
  async close(options?: RequestOptions): Promise<void> {
    if (this.closed && !this.recovering) return;
    await this.call("session/close", { requestId: this.createId(), sessionId: this.binding.sessionId }, options);
    this.closed = true; this.state.status = "closed"; await this.disposeBackend(); this.queue.end();
  }
  private disposeBackend(): Promise<void> { return this.backendDisposal ??= this.backend?.dispose() ?? Promise.resolve(); }
  dispose(): Promise<void> {
    return this.disposePromise ??= (async () => {
      this.emergencyPublication = true;
      if (!this.closed) await this.interactions.cancelAll("runtime_disposed");
      if (this.activeTurnId && this.started.has(this.activeTurnId) && !this.ended.has(this.activeTurnId)) await this.fail(new HarnessSdkError("RUNTIME_DISPOSED", "Runtime disposed", false, true));
      this.closed = true; this.queue.end(); await this.disposeBackend();
    })();
  }
}

export class ManagedHarnessRuntime implements HarnessRuntime {
  private initialized?: InitializeResult;
  private readonly sessions = new Map<string, ManagedHarnessSession>();
  private closed = false;
  private disposing?: Promise<void>;
  private initialization?: Promise<InitializeResult>;
  private clientCapabilities?: Capabilities;
  constructor(private readonly adapter: HarnessAdapter, private readonly options: RuntimeOptions = {}) {}
  initialize(params: InitializeParams, options?: RequestOptions): Promise<InitializeResult> {
    if (this.closed) return Promise.reject(new HarnessSdkError("RUNTIME_DISPOSED"));
    assertRequest("initialize", params); negotiateVersion(params.protocolVersions);
    return this.initialization ??= waitForRequest(async () => {
      const result = await this.adapter.initialize(params); assertResult("initialize", result);
      if (!params.protocolVersions.includes(result.protocolVersion)) throw new HarnessSdkError("PROTOCOL_VERSION_UNSUPPORTED");
      this.initialized = immutable(result); this.clientCapabilities = immutable(params.clientCapabilities ?? {}); return this.initialized;
    }, options, this.options.requestTimeoutMs).catch((cause) => { this.initialization = undefined; throw cause; });
  }
  async openSession(params: SessionOpenParams, options?: RequestOptions): Promise<HarnessSession> {
    if (options?.signal?.aborted) throw new HarnessSdkError("REQUEST_ABORTED");
    assertRequest("session/open", params);
    if (this.closed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (!this.initialized) throw new HarnessSdkError("NOT_INITIALIZED");
    const previous = this.sessions.get(params.binding.sessionId);
    if (previous && !previous.isClosed) throw new HarnessSdkError("SESSION_ALREADY_OPEN");
    if (params.mode === "resume" && !this.initialized.capabilities.session?.resume) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    if (params.mode === "fork" && (!params.fork || !this.initialized.capabilities.session?.fork?.includes(params.fork.boundary.relation))) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    const source = params.mode === "fork" && params.fork ? this.sessions.get(params.fork.sourceSessionId) : undefined;
    const releaseSource = source && !source.isClosed ? source.reserveFork(params.binding) : undefined;
    try {
      const session = new ManagedHarnessSession(params.binding, this.initialized.capabilities, this.options, params, this.clientCapabilities);
      this.sessions.set(params.binding.sessionId, session);
      try {
        await waitForRequest(async () => {
          const backend = await this.adapter.openSession(params, session); await session.attach(backend);
        }, options, this.options.openTimeoutMs ?? 120_000);
        return session;
      } catch (cause) { await session.dispose(); this.sessions.delete(params.binding.sessionId); throw cause; }
    } finally { releaseSource?.(); }
  }
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closed = true;
      const results = await Promise.allSettled([...this.sessions.values()].map((session) => session.dispose()));
      // Always attempt adapter cleanup, but never turn an unverified backend stop into success.
      const [adapterResult] = await Promise.allSettled([this.adapter.dispose()]);
      this.sessions.clear();
      const failure = [...results, adapterResult!].find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
  }
}
export function createHarnessRuntime(adapter: HarnessAdapter, options?: RuntimeOptions): HarnessRuntime { return new ManagedHarnessRuntime(adapter, options); }
