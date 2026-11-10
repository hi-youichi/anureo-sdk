import { randomUUID } from 'node:crypto';
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, assertResult, assertEvent, publicInteraction, publicValue, supportsCapability, supportsExtension,
  type AhpEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap, type Capabilities,
  type InteractionRequested, type InteractionResponse, type SessionBinding, type SessionOpenParams, type SessionState,
} from '@anureo/protocol';
import { HarnessSdkError, sdkError, waitForRequest, type RequestOptions } from './errors';
import { InteractionRegistry } from './interactions';
import { SecretRedactor } from './secrets';
import type { RuntimeOptions, NativeInteractionResponder } from './ports';
import { EventHub, type EventSubscriptionOptions } from './lifecycle/events';
import { guardRequest } from './guard';
import type { BackendSession, EventScope, HarnessAdapter, SessionEventSink, SessionMethod } from './ports';
import { ResultAccumulator } from './lifecycle/result';
import { Turn, type ExecutionObservation } from './lifecycle/resources';
import type { Input, TurnResult } from './lifecycle/types';
import { deferred, immutable, inputBlocks, positive } from './lifecycle/value';

export type InteractionHandlers = { [K in InteractionRequested['kind']]?: (request: Extract<InteractionRequested, { kind: K }>, context: { signal: AbortSignal }) => Promise<Extract<InteractionResponse, { kind: K }>> };
export interface ClientOptions {
  adapter: HarnessAdapter;
  identity: Pick<SessionBinding, 'adapterId' | 'runtimeConfigId'>;
  runtime?: RuntimeOptions;
  interactions?: InteractionHandlers;
  limits?: { maxExecutions?: number; maxSubmissions?: number; maxResultBytes?: number; maxItems?: number };
}
export interface SubmitOptions {
  input: Input;
  delivery?: AhpRequestMap['input/submit']['delivery'];
  overrides?: AhpRequestMap['input/submit']['overrides'];
  outputSchema?: AhpRequestMap['input/submit']['outputSchema'];
}
interface SubmissionRecord {
  completion: ReturnType<typeof deferred<ExecutionObservation>>;
  createdSeq: number;
  requestId?: string;
  target?: Execution;
  failed: boolean;
  acknowledged: boolean;
}
interface Execution extends ExecutionObservation {
  accumulator: ResultAccumulator;
  completion: ReturnType<typeof deferred<TurnResult>>;
  started: boolean;
  terminal: boolean;
  items: Map<string, boolean>;
  terminalSeq?: number;
}
function invalidWait(wait?: RequestOptions): boolean { return wait?.timeoutMs !== undefined && (!Number.isFinite(wait.timeoutMs) || wait.timeoutMs <= 0 || wait.timeoutMs > 0x7fffffff); }
function observationClosed(stopped = false): HarnessSdkError { return new HarnessSdkError('OBSERVATION_CLOSED', stopped ? 'Observation closed before a native terminal result' : 'Observation closed; execution stop is unconfirmed', false, true, { source: 'sdk', executionStopped: stopped ? 'confirmed' : 'unconfirmed' }); }
function combined(causes: unknown[]): HarnessSdkError {
  const errors = [...new Set(causes)].flatMap(cause => {
    const error = sdkError(cause);
    if (error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors)) {
      return error.details.errors.filter((value): value is { code: string; outcomeUnknown?: boolean } => !!value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(value.code)).map(value => ({ code: value.code, outcomeUnknown: value.outcomeUnknown === true }));
    }
    return [{ code: error.code, outcomeUnknown: error.outcomeUnknown }];
  });
  return new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'One or more owned resources could not be released', false, true,
    { source: 'sdk', errors });
}

export class Session implements SessionEventSink {
  private backend?: BackendSession;
  private observationFailure?: unknown;
  private closed = false;
  private recovering = false;
  private closing?: Promise<AhpResultMap['session/close']>;
  private closeReceipt?: AhpResultMap['session/close'];
  private disposal?: Promise<void>;
  private backendDisposal?: Promise<void>;
  private readonly ended = deferred<never>();
  private seq = 0;
  private readonly streamId: string;
  private source = Promise.resolve();
  private backlog = 0;
  private pendingBytes = 0;
  private totalBytes = 0;
  private readonly hub = new EventHub<AhpEvent>();
  private readonly executions = new Map<string, Execution>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly requests = new Map<string, { fingerprint: string; result: Promise<unknown>; settled: boolean }>();
  private readonly interactions: InteractionRegistry;
  private readonly handlers = new Map<string, AbortController>();
  private handlerCount = 0;
  private readonly secrets: SecretRedactor;
  private state: SessionState;
  constructor(private readonly params: SessionOpenParams, private readonly options: ClientOptions, capabilities: Capabilities, private readonly createId: () => string) {
    this.streamId = createId();
    this.state = { binding: immutable(params.binding), capabilities: immutable(capabilities), capabilityRevision: 1, config: structuredClone(params.config ?? {}), status: 'opening', activeTurnIds: [], ...(params.model ? { model: params.model } : {}) };
    this.secrets = new SecretRedactor(value => options.runtime?.onMarkedSecret?.(this.binding, value));
    this.interactions = new InteractionRegistry(async result => {
      this.handlers.get(result.interactionId)?.abort();
      this.handlers.delete(result.interactionId);
      if (!this.closed) await this.emit({ type: 'interaction/resolved', payload: result });
    }, { maxPending: options.runtime?.maxPendingInteractions ?? 32, timeoutMs: options.runtime?.interactionTimeoutMs ?? 600_000, responseTimeoutMs: options.runtime?.requestTimeoutMs }, (request, response) => this.secrets.rememberResponse(request, response));
  }
  get id(): string { return this.state.binding.sessionId; }
  get binding(): Readonly<SessionBinding> { return immutable(this.state.binding); }
  get reference(): Readonly<{ binding: SessionBinding; cwd: string }> { return immutable({ binding: this.binding, cwd: this.params.cwd }); }
  get capabilities(): Readonly<Capabilities> { return immutable(this.state.capabilities); }
  get snapshot(): Readonly<SessionState> { return immutable(this.secrets.state(this.state)); }
  async attach(backend: BackendSession): Promise<void> {
    for (const key of ['sessionId', 'adapterId', 'runtimeConfigId'] as const) if (backend.binding[key] !== this.binding[key]) { await backend.dispose(); throw new HarnessSdkError('SESSION_BINDING_MISMATCH'); }
    if (this.closed) { await backend.dispose(); throw this.observationFailure ?? new HarnessSdkError('SESSION_CLOSED'); }
    if (backend.state) {
      for (const key of ['sessionId', 'adapterId', 'runtimeConfigId'] as const) if (backend.state.binding[key] !== this.binding[key]) { await backend.dispose(); throw new HarnessSdkError('SESSION_BINDING_MISMATCH'); }
      this.state = { ...structuredClone(backend.state), ...((this.state.metadata || backend.state.metadata) ? { metadata: { ...this.state.metadata, ...backend.state.metadata } } : {}) };
      for (const id of backend.state.activeTurnIds) this.context(id).started = true;
    }
    this.backend = backend; this.state.binding = immutable(backend.binding); this.state.capabilities = immutable(backend.capabilities); this.updateStatus();
    await this.emit({ type: 'session/state', payload: this.state });
  }
  private updateStatus(): void {
    this.state.activeTurnIds = [...this.executions.values()].filter(value => value.started && !value.terminal).map(value => value.id);
    this.state.status = this.closed ? 'closed' : this.closing ? 'closing' : this.recovering ? 'recoveryRequired' : this.state.activeTurnIds.length ? 'running' : 'ready';
  }
  events(options?: EventSubscriptionOptions): AsyncIterable<AhpEvent> { return this.hub.subscribe(options); }
  private context(id: string): Execution {
    const known = this.executions.get(id); if (known) return known;
    const limit = positive(this.options.limits?.maxExecutions, 128);
    if (this.executions.size >= limit) {
      for (const [key, value] of this.executions) {
        if (!value.terminal) continue;
        // A new input cannot need an already-ended execution. Older unbound
        // inputs may still receive a late association and pin that snapshot.
        const pinned = [...this.submissions.values()].some(submission =>
          !submission.failed && !submission.target && submission.createdSeq < value.terminalSeq!);
        if (pinned) continue;
        this.totalBytes -= value.accumulator.size;
        this.executions.delete(key);
        for (const [id, record] of this.submissions) if (record.target === value && record.acknowledged) this.submissions.delete(id);
        break;
      }
      if (this.executions.size >= limit) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Execution observation limit exceeded');
    }
    const completion = deferred<TurnResult>();
    const context: Execution = {
      id, completion, result: completion.promise, events: new EventHub(), started: false, terminal: false, items: new Map(),
      accumulator: new ResultAccumulator(positive(this.options.limits?.maxResultBytes, 16 * 1024 * 1024), positive(this.options.limits?.maxItems, 2048)),
      steer: async (input, wait) => { await this.request('turn/steer', { ...this.requestIdentity(), submissionId: this.createId(), expectedTurnId: id, input: inputBlocks(input) }, wait); },
      interrupt: async wait => { await this.request('turn/interrupt', { ...this.requestIdentity(), turnId: id }, wait); },
    };
    this.executions.set(id, context); return context;
  }
  emit(payload: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError('STREAM_CLOSED'));
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(payload)); } catch { return Promise.reject(new HarnessSdkError('PROTOCOL_ERROR')); }
    if (bytes > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024) || this.pendingBytes + bytes > (this.options.runtime?.queue?.maxBytes ?? 16 * 1024 * 1024)) {
      const cause = new HarnessSdkError('BACKPRESSURE_EXCEEDED'); void this.fail(cause); return Promise.reject(cause);
    }
    if (++this.backlog > (this.options.runtime?.queue?.maxEvents ?? 2048)) { this.backlog--; void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); }
    this.pendingBytes += bytes;
    let copy: AhpEventPayload;
    try { copy = structuredClone(payload); }
    catch { this.backlog--; this.pendingBytes -= bytes; return Promise.reject(new HarnessSdkError('PROTOCOL_ERROR')); }
    const target = { ...scope };
    const operation = this.source.then(() => this.publish(copy, target));
    this.source = operation.catch(cause => { void this.fail(cause); }).finally(() => { this.backlog--; this.pendingBytes -= bytes; });
    return operation;
  }
  tryEmit(payload: AhpEventPayload, scope: EventScope = {}): boolean {
    if (this.closed || this.backlog >= (this.options.runtime?.queue?.maxEvents ?? 2048)) { void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return false; }
    try {
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (bytes > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024) || this.pendingBytes + bytes > (this.options.runtime?.queue?.maxBytes ?? 16 * 1024 * 1024)) { void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return false; }
    } catch { void this.fail(new HarnessSdkError('PROTOCOL_ERROR')); return false; }
    void this.emit(payload, scope).catch(() => {}); return true;
  }
  private publish(payload: AhpEventPayload, scope: EventScope): void {
    if (this.closed) return;
    const turnId = scope.turnId ?? (payload.type === 'turn/started' || payload.type === 'turn/completed' ? payload.payload.turnId : undefined);
    if ((payload.type === 'turn/started' || payload.type === 'turn/completed') && scope.turnId && scope.turnId !== payload.payload.turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting execution identities');
    if (payload.type === 'extension' && !supportsExtension(this.capabilities, payload.payload.name, payload.payload.version)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const itemId = payload.type === 'item/delta' ? payload.payload.itemId : payload.type === 'item/started' || payload.type === 'item/completed' ? payload.payload.item.id : undefined;
    if (scope.itemId && itemId && scope.itemId !== itemId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item identities');
    let execution: Execution | undefined;
    // Validate shape before updating lifecycle bookkeeping.
    assertEvent({ ...scope, sessionId: this.id, streamId: this.streamId, seq: this.seq + 1, timestamp: new Date().toISOString(), ...payload });
    if (payload.type === 'submission/bound') {
      const submission = this.submissions.get(payload.payload.submissionId);
      if (!submission) throw new HarnessSdkError('PROTOCOL_ERROR', 'Unknown submission binding');
      this.bindRecord(submission, payload.payload.turnId);
    } else if (payload.type === 'submission/status') {
      const submission = this.submissions.get(payload.payload.submissionId);
      if (!submission) throw new HarnessSdkError('PROTOCOL_ERROR', 'Unknown submission status');
      if (payload.payload.status === 'rejected' || payload.payload.status === 'unknown') {
        submission.failed = payload.payload.status === 'rejected';
        const error = payload.payload.error;
        submission.completion.reject(error ? new HarnessSdkError(error.code, error.code, error.retryable, error.outcomeUnknown) : new HarnessSdkError('SUBMISSION_REJECTED'));
      }
      payload = { ...payload, payload: { ...payload.payload,
        ...(payload.payload.receipt ? { receipt: this.secrets.json(publicValue(payload.payload.receipt)) as typeof payload.payload.receipt } : {}),
        ...(payload.payload.error ? { error: { ...payload.payload.error, message: this.secrets.text(payload.payload.error.message),
          ...(payload.payload.error.details ? { details: this.secrets.json(publicValue(payload.payload.error.details)) as typeof payload.payload.error.details } : {}) } } : {}) } };
    } else if (payload.type === 'session/metadata') {
      this.state.metadata = { ...this.state.metadata, ...structuredClone(payload.payload) };
    } else if (payload.type === 'session/state') {
      for (const key of ['sessionId', 'adapterId', 'runtimeConfigId'] as const) if (payload.payload.binding[key] !== this.binding[key]) throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
      this.state = { ...structuredClone(payload.payload), ...((this.state.metadata || payload.payload.metadata) ? { metadata: { ...this.state.metadata, ...payload.payload.metadata } } : {}) }; this.updateStatus(); payload = { type: 'session/state', payload: this.state };
    } else if (turnId) {
      execution = this.context(turnId);
      if (payload.type === 'turn/started') { if (execution.started || execution.terminal) return; execution.started = true; }
      if (payload.type === 'turn/completed') { if (execution.terminal) return; if (!execution.started) throw new HarnessSdkError('PROTOCOL_ERROR', 'Turn ended without start'); }
      if (payload.type.startsWith('item/')) {
        if (!execution.started || execution.terminal) throw new HarnessSdkError('PROTOCOL_ERROR', 'Item outside execution');
        const itemId = payload.type === 'item/delta' ? payload.payload.itemId : payload.type === 'item/started' || payload.type === 'item/completed' ? payload.payload.item.id : undefined;
        if (itemId) {
          const previous = execution.items.get(itemId);
          if (payload.type === 'item/started' && previous !== undefined || payload.type === 'item/delta' && previous !== false) throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid item lifecycle');
          if (payload.type === 'item/completed' && previous === true) return;
          if (payload.type !== 'item/delta') execution.items.set(itemId, payload.type === 'item/completed');
        }
      }
    }
    // Privacy projection preserves protocol identities while redacting content.
    payload = this.secrets.event(payload, turnId);
    const event: AhpEvent = { ...scope, ...(turnId ? { turnId } : {}), sessionId: this.id, streamId: this.streamId, seq: ++this.seq, timestamp: (this.options.runtime?.now ?? (() => new Date().toISOString()))(), ...payload };
    assertEvent(event);
    if (execution) {
      const previous = execution.accumulator.size; execution.accumulator.accept(event); this.totalBytes += execution.accumulator.size - previous;
      if (this.totalBytes > positive(this.options.limits?.maxResultBytes, 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
      if (payload.type === 'turn/completed') { execution.terminal = true; execution.terminalSeq = this.seq; execution.completion.resolve(execution.accumulator.finish(payload.payload)); }
      execution.events.publish(event); if (execution.terminal) execution.events.end();
    }
    this.updateStatus(); this.hub.publish(event);
  }
  private requestIdentity() { return { sessionId: this.id, requestId: this.createId() }; }
  bindSubmission(submissionId: string, turnId: string): Promise<void> {
    return this.emit({ type: 'submission/bound', payload: { submissionId, turnId } });
  }
  private bindRecord(record: SubmissionRecord, turnId: string): void {
    if (record.target && record.target.id !== turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Submission rebound');
    if (record.failed) throw new HarnessSdkError('PROTOCOL_ERROR', 'Rejected submission bound');
    record.target ??= this.context(turnId);
    record.completion.resolve(record.target);
  }
  private rejectSubmission(record: SubmissionRecord, cause: unknown, acknowledged = true): void {
    record.failed = !sdkError(cause).outcomeUnknown;
    record.acknowledged ||= acknowledged;
    record.completion.reject(cause);
  }
  private record(id: string): SubmissionRecord {
    const existing = this.submissions.get(id);
    if (existing) return existing;
    const limit = positive(this.options.limits?.maxSubmissions, 1024);
    if (this.submissions.size >= limit) {
      for (const [key, value] of this.submissions) if (value.acknowledged && (value.failed || value.target?.terminal)) { this.submissions.delete(key); break; }
    }
    if (this.submissions.size >= limit) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Submission limit exceeded');
    const record: SubmissionRecord = { completion: deferred<ExecutionObservation>(), createdSeq: this.seq, failed: false, acknowledged: false };
    this.submissions.set(id, record);
    return record;
  }
  submit(options: SubmitOptions, wait: RequestOptions = {}): Promise<Turn> {
    try {
      return this.submitExecution('input/submit', { ...options, input: inputBlocks(options.input), delivery: options.delivery ?? 'native' }, wait);
    } catch (cause) { return Promise.reject(cause); }
  }
  review(options: { target: AhpRequestMap['review/start']['target'] }, wait: RequestOptions = {}): Promise<Turn> {
    return this.submitExecution('review/start', options, wait);
  }
  private submitExecution(method: 'input/submit' | 'review/start', options: object, wait: RequestOptions): Promise<Turn> {
    if (invalidWait(wait)) return Promise.reject(new HarnessSdkError('INVALID_PARAMS'));
    if (wait.signal?.aborted) return Promise.reject(new HarnessSdkError('REQUEST_ABORTED'));
    const submissionId = this.createId();
    const params = structuredClone({ ...options, ...this.requestIdentity(), submissionId }) as AhpRequestMap[typeof method];
    try { this.assertCallable(method); guardRequest(method, params, this.id, this.capabilities); }
    catch (cause) { return Promise.reject(cause); }
    let record: SubmissionRecord;
    try { record = this.record(submissionId); } catch (cause) { return Promise.reject(cause); }
    // Observe the association independently: no native acceptance receipt is required.
    void this.dispatchOperation(method, params).catch(cause => {
      // Preserve the original dispatch error, but keep admitted records pinned
      // until their status event is published.
      this.rejectSubmission(record, cause, !record.requestId);
    });
    return waitForRequest(async () => new Turn(await record.completion.promise), wait, this.options.runtime?.requestTimeoutMs);
  }
  interrupt(options: { cancelQueued?: boolean } = {}, wait?: RequestOptions): Promise<AhpResultMap['session/interrupt']> {
    return this.request('session/interrupt', { ...this.requestIdentity(), ...options }, wait);
  }
  private assertCallable(method: SessionMethod): void {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const control = method === 'session/interrupt' || method === 'turn/interrupt' || method === 'interaction/respond' || method === 'interaction/cancel';
    if (this.closing && !control) throw new HarnessSdkError('SESSION_CLOSING');
    if (this.recovering && !control && method !== 'history/read' && method !== 'session/close') throw new HarnessSdkError('RECOVERY_REQUIRED');
  }
  request<M extends SessionMethod>(method: M, params: AhpRequestMap[M], wait: RequestOptions = {}): Promise<AhpResultMap[M]> {
    if (method === 'session/close') {
      try { guardRequest(method, params, this.id, this.capabilities); } catch (cause) { return Promise.reject(cause); }
      return this.closeRequest(params as AhpRequestMap['session/close'], wait) as Promise<AhpResultMap[M]>;
    }
    if (invalidWait(wait)) return Promise.reject(new HarnessSdkError('INVALID_PARAMS'));
    if (wait.signal?.aborted) return Promise.reject(new HarnessSdkError('REQUEST_ABORTED'));
    return waitForRequest(() => this.dispatchOperation(method, params), wait, this.options.runtime?.requestTimeoutMs);
  }
  /** Owns dispatch and late outcomes independently of any caller's wait deadline. */
  private dispatchOperation<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    try { this.assertCallable(method); guardRequest(method, params, this.id, this.capabilities); } catch (cause) { return Promise.reject(cause); }
    if (Buffer.byteLength(JSON.stringify(params)) > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024)) return Promise.reject(new HarnessSdkError('FRAME_TOO_LARGE'));
    params = structuredClone(params);
    const key = JSON.stringify([method, params.requestId]), fingerprint = JSON.stringify(params);
    const previous = this.requests.get(key);
    if (previous) return previous.fingerprint === fingerprint ? previous.result as Promise<AhpResultMap[M]> : Promise.reject(new HarnessSdkError('REQUEST_ID_CONFLICT'));
    const limit = this.options.runtime?.requestCacheSize ?? 1024;
    if (this.requests.size >= limit) { for (const [id, value] of this.requests) if (value.settled) { this.requests.delete(id); break; } }
    if (this.requests.size >= limit) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'));
    if (method === 'input/submit' || method === 'review/start' || method === 'turn/steer') {
      const id = (params as AhpRequestMap['input/submit']).submissionId;
      const existing = this.submissions.get(id);
      if (existing?.requestId && existing.requestId !== params.requestId) return Promise.reject(new HarnessSdkError('SUBMISSION_ID_CONFLICT'));
      try { this.record(id).requestId = params.requestId; } catch (cause) { return Promise.reject(cause); }
    }
    const run = async (): Promise<AhpResultMap[M]> => {
      if (!this.backend) throw new HarnessSdkError('NOT_INITIALIZED');
      let result: unknown;
      if (method === 'interaction/respond') { const value = params as AhpRequestMap['interaction/respond']; result = await this.interactions.respond(value.interactionId, value.requestId, value.response); }
      else if (method === 'interaction/cancel') { const value = params as AhpRequestMap['interaction/cancel']; result = await this.interactions.cancel(value.interactionId, value.reason); }
      else result = await this.backend.execute(method, params);
      try { assertResult(method, result); }
      catch { const cause = new HarnessSdkError('PROTOCOL_ERROR', 'Invalid native result', false, true); void this.fail(cause); throw cause; }
      if ((method === 'input/submit' || method === 'review/start' || method === 'turn/steer') && (result as AhpResultMap['input/submit']).submissionId !== (params as AhpRequestMap['input/submit']).submissionId) {
        const cause = new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting submission identity', false, true); void this.fail(cause); throw cause;
      }
      if (method === 'turn/steer' && (result as AhpResultMap['turn/steer']).turnId !== (params as AhpRequestMap['turn/steer']).expectedTurnId) {
        const cause = new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting steer target', false, true); void this.fail(cause); throw cause;
      }
      if (method === 'history/read') {
        let page = this.secrets.history(result as AhpResultMap['history/read']);
        if (this.options.runtime?.redactHistory) page = await this.options.runtime.redactHistory(this.binding, page);
        result = page;
      } else if (method !== 'input/submit' && method !== 'review/start' && method !== 'session/close') result = this.secrets.result(method, result as never);
      if (method === 'session/config/set') { this.state = structuredClone(result as SessionState); this.updateStatus(); }
      if (method === 'session/revert') {
        const nativeRef = (result as AhpResultMap['session/revert']).nativeRef;
        if (nativeRef) this.state.binding = { ...this.binding, nativeRef: structuredClone(nativeRef) };
      }
      if (method === 'goal/set' || method === 'goal/clear') this.state.goal = structuredClone(result as AhpResultMap['goal/set']);
      assertResult(method, result); return immutable(result) as AhpResultMap[M];
    };
    const operation = Promise.race([Promise.resolve().then(run), this.ended.promise]);
    const entry = { fingerprint, result: operation, settled: false }; this.requests.set(key, entry);
    void operation.then(async result => {
      entry.settled = true;
      if (method === 'input/submit' || method === 'review/start' || method === 'turn/steer') {
        const response = result as AhpResultMap['input/submit'] | AhpResultMap['turn/steer'];
        const record = this.submissions.get(response.submissionId);
        if (!record) return;
        record.acknowledged = true;
        if ('turnId' in response) {
          if (method === 'turn/steer' && response.turnId !== (params as AhpRequestMap['turn/steer']).expectedTurnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Wrong steer target');
          await this.bindSubmission(response.submissionId, response.turnId);
        }
        if (!this.closed) await this.emit({ type: 'submission/status', payload: {
          submissionId: response.submissionId,
          status: 'disposition' in response && response.disposition === 'dispatched' ? 'dispatched' : 'disposition' in response && response.disposition === 'queued' ? 'queued' : 'accepted',
          ...('receipt' in response && response.receipt ? { receipt: response.receipt } : {}),
        } });
      }
    }, async cause => {
      entry.settled = true;
      const error = sdkError(cause);
      if (error.outcomeUnknown && method !== 'history/read' && method !== 'turn/interrupt' && method !== 'session/interrupt') { this.recovering = true; this.updateStatus(); }
      if (method === 'input/submit' || method === 'review/start' || method === 'turn/steer') {
        const id = (params as AhpRequestMap['input/submit']).submissionId, record = this.submissions.get(id);
        if (record && !this.closed) await this.emit({ type: 'submission/status', payload: { submissionId: id, status: error.outcomeUnknown ? 'unknown' : 'rejected', error: { code: error.code, message: error.code, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown } } });
        if (record) this.rejectSubmission(record, error);
      }
    }).catch(cause => { void this.fail(cause); });
    return operation;
  }
  async requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (this.closed) { await responder(null, 'session_closed'); throw new HarnessSdkError('SESSION_CLOSED'); }
    if (!this.capabilities.interactions?.includes(request.kind) || !Object.hasOwn(this.options.interactions ?? {}, request.kind)) { await responder(null, 'unsupported'); throw new HarnessSdkError('INTERACTION_UNSUPPORTED'); }
    const handler = this.options.interactions?.[request.kind] as ((request: InteractionRequested, context: { signal: AbortSignal }) => Promise<InteractionResponse>) | undefined;
    if (handler && this.handlerCount >= (this.options.runtime?.maxPendingInteractions ?? 32)) { await responder(null, 'capacity'); throw new HarnessSdkError('BACKPRESSURE_EXCEEDED'); }
    const result = this.interactions.begin(request, responder);
    const controller = handler ? new AbortController() : undefined;
    if (controller) { this.handlers.set(request.interactionId, controller); this.handlerCount++; }
    await this.emit({ type: 'interaction/requested', payload: publicInteraction(request) }, { turnId: request.turnId, itemId: request.itemId });
    if (handler && controller) {
      void Promise.resolve().then(() => controller.signal.aborted ? undefined : handler(structuredClone(request), { signal: controller.signal })).then(async response => {
        if (!controller.signal.aborted) await this.interactions.respond(request.interactionId, this.createId(), response!);
      }).catch(async () => { if (!controller.signal.aborted) await this.interactions.cancel(request.interactionId, 'handler_failed').catch(() => {}); }).finally(() => { this.handlerCount--; this.handlers.delete(request.interactionId); });
    }
    return result;
  }
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void> { return this.interactions.resolveExternally(result); }
  private end(cause: unknown): void {
    this.observationFailure ??= cause;
    this.closed = true; this.updateStatus(); this.ended.reject(cause);
    for (const value of this.submissions.values()) value.completion.reject(cause);
    for (const execution of this.executions.values()) if (!execution.terminal) { execution.completion.reject(cause); execution.events.end(cause); }
    for (const controller of this.handlers.values()) controller.abort(); this.handlers.clear();
    this.hub.end(cause);
  }
  async fail(cause: unknown): Promise<void> {
    if (this.closed) return;
    this.end(new HarnessSdkError(sdkError(cause).code, 'Session observation failed', false, true, { source: 'sdk' }));
    await this.interactions.cancelAll('connection_lost');
    await this.disposeBackend().catch(() => {});
  }
  close(wait: RequestOptions = {}): Promise<AhpResultMap['session/close']> {
    return this.closeRequest(this.requestIdentity(), wait);
  }
  private closeRequest(params: AhpRequestMap['session/close'], wait: RequestOptions): Promise<AhpResultMap['session/close']> {
    if (invalidWait(wait)) return Promise.reject(new HarnessSdkError('INVALID_PARAMS'));
    if (wait.signal?.aborted) return Promise.reject(new HarnessSdkError('REQUEST_ABORTED'));
    if (this.closed) return waitForRequest(async () => { await this.disposeBackend(); return this.closeReceipt ?? { closed: true as const, observationClosed: true as const, executionStopped: 'unconfirmed' as const }; }, wait, this.options.runtime?.requestTimeoutMs);
    if (!this.closing) {
      // Dispatch before setting closing; later business calls are rejected while controls stay usable.
      const native = this.dispatchOperation('session/close', params);
      this.closing = native.then(async result => {
        this.closeReceipt = result;
        const causes: unknown[] = [];
        try { await this.interactions.cancelAll('session_closed'); } catch (cause) { causes.push(cause); }
        try { await this.disposeBackend(); } catch (cause) { causes.push(cause); }
        this.end(observationClosed(result.executionStopped === 'confirmed'));
        if (causes.length) throw combined(causes);
        return result;
      }, cause => {
        this.closing = undefined;
        if (sdkError(cause).outcomeUnknown) this.recovering = true;
        this.updateStatus(); throw cause;
      });
      void this.closing.catch(() => {}); this.updateStatus();
    }
    return waitForRequest(() => this.closing!, wait, this.options.runtime?.requestTimeoutMs);
  }
  private disposeBackend(): Promise<void> { return this.backendDisposal ??= this.backend?.dispose() ?? Promise.resolve(); }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      const cause = observationClosed(); this.end(cause);
      await this.interactions.cancelAll('runtime_disposed');
      await this.disposeBackend();
    })();
  }
}

export class Client {
  private initialized?: Capabilities;
  private closed = false;
  private disposing?: Promise<void>;
  private readonly owned = new Set<Session>();
  private readonly createId: () => string;
  constructor(private readonly options: ClientOptions) {
    this.createId = options.runtime?.createId ?? randomUUID;
    for (const value of [options.identity.adapterId, options.identity.runtimeConfigId]) if (typeof value !== 'string' || !value.trim()) throw new HarnessSdkError('INVALID_PARAMS');
    for (const value of Object.values(options.limits ?? {})) positive(value, 1);
    for (const [kind, handler] of Object.entries(options.interactions ?? {})) if (!['approval', 'userInput', 'elicitation', 'dynamicTool'].includes(kind) || handler !== undefined && typeof handler !== 'function') throw new HarnessSdkError('INVALID_PARAMS');
  }
  async initialize(wait?: RequestOptions): Promise<void> {
    if (invalidWait(wait)) throw new HarnessSdkError('INVALID_PARAMS');
    const result = await waitForRequest(() => this.options.adapter.initialize({ protocolVersions: [1], protocolContract: AHP_PROTOCOL_CONTRACT, clientInfo: { name: 'anureo-native-lifecycle', version: '0.2.0' }, clientCapabilities: { interactions: Object.keys(this.options.interactions ?? {}) as InteractionRequested['kind'][] } }), wait, this.options.runtime?.requestTimeoutMs);
    assertResult('initialize', result); this.initialized = immutable(result.capabilities);
  }
  readonly sessions = {
    create: (options: Omit<SessionOpenParams, 'requestId' | 'binding' | 'mode'>, wait?: RequestOptions) => this.open({ ...options, mode: 'new', requestId: this.createId(), binding: { ...this.options.identity, sessionId: this.createId() } }, wait),
    resume: (reference: { binding: SessionBinding; cwd: string }, wait?: RequestOptions) => this.open({ ...reference, mode: 'resume', requestId: this.createId() }, wait),
    fork: (reference: { binding: SessionBinding; cwd: string }, options: { boundary: AhpRequestMap['session/revert']['boundary'] }, wait?: RequestOptions) => {
      if (reference.binding.adapterId !== this.options.identity.adapterId || reference.binding.runtimeConfigId !== this.options.identity.runtimeConfigId) return Promise.reject(new HarnessSdkError('SESSION_BINDING_MISMATCH'));
      return this.open({ cwd: reference.cwd, mode: 'fork', requestId: this.createId(), binding: { ...this.options.identity, sessionId: this.createId() }, fork: { sourceSessionId: reference.binding.sessionId, nativeRef: reference.binding.nativeRef, boundary: options.boundary } }, wait);
    },
  };
  /** Host-level entry with an explicit immutable binding. */
  openSession(params: SessionOpenParams, wait?: RequestOptions): Promise<Session> { return this.open(params, wait); }
  private async open(params: SessionOpenParams, wait?: RequestOptions): Promise<Session> {
    if (invalidWait(wait)) throw new HarnessSdkError('INVALID_PARAMS');
    if (wait?.signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED');
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED');
    if (!this.initialized) throw new HarnessSdkError('NOT_INITIALIZED');
    assertRequest('session/open', params);
    if (params.binding.adapterId !== this.options.identity.adapterId || params.binding.runtimeConfigId !== this.options.identity.runtimeConfigId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
    if (params.mode === 'resume' && !supportsCapability(this.initialized, 'session.resume') || params.mode === 'fork' && !supportsCapability(this.initialized, 'session.fork', params.fork!.boundary.relation)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const session = new Session(structuredClone(params), this.options, this.initialized, this.createId); this.owned.add(session);
    try {
      await waitForRequest(async () => { const backend = await this.options.adapter.openSession(structuredClone(params), session); await session.attach(backend); }, wait, this.options.runtime?.openTimeoutMs ?? 120_000);
      if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED');
      return session;
    } catch (cause) { this.owned.delete(session); try { await session.dispose(); } catch (cleanup) { throw combined([cause, cleanup]); } throw cause; }
  }
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closed = true;
      const results = await Promise.allSettled([...this.owned].map(session => session.dispose()));
      const [adapter] = await Promise.allSettled([this.options.adapter.dispose()]);
      this.owned.clear(); const failures = [...results, adapter!].filter((value): value is PromiseRejectedResult => value.status === 'rejected');
      if (failures.length) throw combined(failures.map(value => value.reason));
    })();
  }
}
export async function createClient(options: ClientOptions, wait?: RequestOptions): Promise<Client> {
  if (wait?.signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED');
  const client = new Client({ ...options, identity: { ...options.identity }, runtime: { ...options.runtime }, interactions: { ...options.interactions }, limits: { ...options.limits } });
  try { await client.initialize(wait); return client; }
  catch (cause) { try { await client.dispose(); } catch (cleanup) { throw combined([cause, cleanup]); } throw cause; }
}
