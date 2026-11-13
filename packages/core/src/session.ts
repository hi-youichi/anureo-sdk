// Owns one session’s dispatch and observation lifecycle; must not initialize adapters or own client-wide resources.
import { assertResult, assertEvent, publicInteraction, publicValue, supportsExtension,
  type AhpEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap, type Capabilities,
  type InteractionRequested, type InteractionResponse, type SessionBinding, type SessionOpenParams, type SessionState } from '@anureo/protocol';
import { HarnessSdkError, sdkError } from './sdk-error';
import { invalidWait, waitForRequest, type RequestOptions } from './request';
import type { ClientOptions, SubmitOptions } from './client-options';
import { InteractionRegistry } from './interactions';
import { SecretRedactor } from './secrets';
import type { BackendSession, EventScope, NativeInteractionResponder, SessionEventSink, SessionMethod } from './ports';
import { EventHub, type EventSubscriptionOptions } from './lifecycle/events';
import { guardRequest } from './guard';
import { ResultAccumulator } from './lifecycle/result';
import { Turn, type ExecutionObservation } from './lifecycle/resources';
import type { TurnResult } from './lifecycle/types';
import { deferred } from './lifecycle/deferred';
import { immutable } from './lifecycle/immutable';
import { inputBlocks } from './lifecycle/input';
import { positive } from './limits';
import { combined, observationClosed } from './lifecycle/errors';

/** Methods that associate a new input with an execution; all share identity and acknowledgement rules. */
type SubmissionMethod = 'input/submit' | 'review/start' | 'turn/steer';

/** Identify submission-bearing methods for dispatch and outcome bookkeeping without touching session state. */
function isSubmissionMethod(method: SessionMethod): method is SubmissionMethod {
  return method === 'input/submit' || method === 'review/start' || method === 'turn/steer';
}

/** Compare stable session identity only; nativeRef may change when resuming or reverting. Used before adopting native state. */
function matchesBinding(candidate: SessionBinding, expected: SessionBinding): boolean {
  return candidate.sessionId === expected.sessionId && candidate.adapterId === expected.adapterId && candidate.runtimeConfigId === expected.runtimeConfigId;
}

/** Required automatic handler port; undefined handlers are handled as manual interactions before scheduling. */
type InteractionHandler = (request: InteractionRequested, context: { signal: AbortSignal }) => Promise<InteractionResponse>;

/** Cached dispatch outcome, retained independently of caller cancellation and queued association/status publication. */
interface RequestRecord {
  fingerprint: string;
  result: Promise<unknown>;
  /** Only settled outcomes may be reclaimed to admit a new request. */
  settled: boolean;
}

/** Tracks association and dispatch acknowledgement separately so late native bindings cannot lose a retained execution. */
interface SubmissionRecord {
  /** Resolves on association, independently of native acknowledgement or completion. */
  executionBinding: ReturnType<typeof deferred<ExecutionObservation>>;
  /** Admission sequence distinguishes older unbound inputs from inputs created after completion. */
  createdSeq: number;
  /** Set only once dispatch admission reserves this submission identity. */
  requestId?: string;
  /** Retained native execution, shared when several submissions join one turn. */
  target?: Execution;
  /** False includes unknown outcomes, which remain eligible for late binding. */
  definitivelyRejected: boolean;
  /** Allows reclamation after dispatch response, pre-dispatch rejection, or failure-status publication; association alone is insufficient. */
  acknowledged: boolean;
}
/** Session-owned execution state; native terminal events or observation closure settle completion and end its event lifetime. */
interface Execution extends ExecutionObservation {
  accumulator: ResultAccumulator;
  completion: ReturnType<typeof deferred<TurnResult>>;
  started: boolean;
  terminal: boolean;
  items: Map<string, 'started' | 'completed'>;
  /** Native terminal publication sequence used to protect possible late associations. */
  terminalSeq?: number;
}
/** Owns dispatch identity, ordered events and local observation for one native session. Client attaches the backend; disposal releases resources without implying execution stopped. */
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
  private readonly requests = new Map<string, RequestRecord>();
  private readonly interactions: InteractionRegistry;
  private readonly handlers = new Map<string, AbortController>();
  private handlerCount = 0;
  private readonly secrets: SecretRedactor;
  private state: SessionState;
  /** Construct local state for Client before native open; retain host hooks, allocate the stream identity and clone initial state. Clone/configuration failures throw before any backend is adopted. */
  constructor(private readonly params: SessionOpenParams, private readonly options: ClientOptions, capabilities: Capabilities, private readonly createId: () => string) {
    this.streamId = createId();
    this.state = { binding: immutable(params.binding), capabilities: immutable(capabilities), capabilityRevision: 1, config: structuredClone(params.config ?? {}), status: 'opening', activeTurnIds: [], ...(params.model ? { model: params.model } : {}) };
    this.secrets = new SecretRedactor(value => options.runtime?.onMarkedSecret?.(this.binding, value));
    /** On registry settlement, abort/release handler identity before ordered result publication; reject publication failure to the registry. Capacity remains owned by the handler promise. */
    this.interactions = new InteractionRegistry(async result => {
      this.handlers.get(result.interactionId)?.abort();
      this.handlers.delete(result.interactionId);
      if (!this.closed) await this.emit({ type: 'interaction/resolved', payload: result });
    }, { maxPending: options.runtime?.maxPendingInteractions ?? 32, timeoutMs: options.runtime?.interactionTimeoutMs ?? 600_000, responseTimeoutMs: options.runtime?.requestTimeoutMs }, (request, response) => this.secrets.rememberResponse(request, response));
  }
  /** Return the session identity for hosts and adapter envelopes without exposing mutable binding state. */
  get id(): string { return this.state.binding.sessionId; }
  /** Return a detached frozen binding so host mutation cannot change request identity; cloning failures propagate. */
  get binding(): Readonly<SessionBinding> { return immutable(this.state.binding); }
  /** Return a frozen resume reference with binding and original cwd; cloning failures propagate. */
  get reference(): Readonly<{ binding: SessionBinding; cwd: string }> { return immutable({ binding: this.binding, cwd: this.params.cwd }); }
  /** Return detached frozen current capabilities for host policy checks; cloning failures propagate without changing state. */
  get capabilities(): Readonly<Capabilities> { return immutable(this.state.capabilities); }
  /** Return a frozen privacy-projected state for host observation; cloning/projection errors propagate without changing lifecycle bookkeeping. */
  get snapshot(): Readonly<SessionState> { return immutable(this.secrets.state(this.state)); }
  /** Project marked secrets out of final text before schema revalidation; called by the output adapter without mutating the candidate. */
  projectOutput(text: string): string { return this.secrets.text(text); }
  /** Adopt a matching backend and publish initial state; dispose mismatched or late backends before rejection. Client calls once after native open. */
  async attach(backend: BackendSession): Promise<void> {
    if (!matchesBinding(backend.binding, this.binding)) { await backend.dispose(); throw new HarnessSdkError('SESSION_BINDING_MISMATCH'); }
    if (this.closed) { await backend.dispose(); throw this.observationFailure ?? new HarnessSdkError('SESSION_CLOSED'); }
    if (backend.state) {
      if (!matchesBinding(backend.state.binding, this.binding)) { await backend.dispose(); throw new HarnessSdkError('SESSION_BINDING_MISMATCH'); }
      this.adoptState(backend.state);
      for (const id of backend.state.activeTurnIds) this.context(id).started = true;
    }
    this.backend = backend;
    this.state.binding = immutable(backend.binding);
    this.state.capabilities = immutable(backend.capabilities);
    this.updateStatus();
    await this.emit({ type: 'session/state', payload: this.state });
  }
  /** Adopt a detached native snapshot while preserving metadata patches omitted by it; attachment and ordered state events call before recomputing activity. Clone failures propagate. */
  private adoptState(state: SessionState): void {
    this.state = { ...structuredClone(state), ...((this.state.metadata || state.metadata) ? { metadata: { ...this.state.metadata, ...state.metadata } } : {}) };
  }
  /** Recompute public activity/status from execution and close/recovery state; never query or stop the backend. */
  private updateStatus(): void {
    this.state.activeTurnIds = [...this.executions.values()].filter(value => value.started && !value.terminal).map(value => value.id);
    if (this.closed) this.state.status = 'closed';
    else if (this.closing) this.state.status = 'closing';
    else if (this.recovering) this.state.status = 'recoveryRequired';
    else this.state.status = this.state.activeTurnIds.length ? 'running' : 'ready';
  }
  /** Create a bounded host event subscription; invalid limits throw and later errors surface on reads. Abort/detach/overflow affect only this observer, never native work. */
  events(options?: EventSubscriptionOptions): AsyncIterable<AhpEvent> { return this.hub.subscribe(options); }
  /** Return or allocate execution observation; reclaim only terminal snapshots unneeded by late submissions, otherwise throw BACKPRESSURE_EXCEEDED. */
  private context(id: string): Execution {
    const known = this.executions.get(id); if (known) return known;
    const limit = positive(this.options.limits?.maxExecutions, 128);
    if (this.executions.size >= limit) this.reclaimExecution();
    if (this.executions.size >= limit) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Execution observation limit exceeded');
    const completion = deferred<TurnResult>();
    const context: Execution = {
      id, completion, result: completion.promise, events: new EventHub(), started: false, terminal: false, items: new Map(),
      accumulator: new ResultAccumulator(positive(this.options.limits?.maxResultBytes, 16 * 1024 * 1024), positive(this.options.limits?.maxItems, 2048)),
      /** Explicit Turn control; normalize new input while retaining this execution as the atomic target. Reject admission/dispatch/wait failures. */
      steer: async (input, wait) => { await this.request('turn/steer', { ...this.requestIdentity(), submissionId: this.createId(), expectedTurnId: id, input: inputBlocks(input) }, wait); },
      /** Explicit Turn control; observation teardown never invokes this native interrupt. Reject native/wait failures. */
      interrupt: async wait => { await this.request('turn/interrupt', { ...this.requestIdentity(), turnId: id }, wait); },
    };
    this.executions.set(id, context); return context;
  }
  /** Reclaim at most the oldest eligible terminal execution and its acknowledged submissions; called only under capacity pressure, never evicts a possible late binding. */
  private reclaimExecution(): void {
    for (const [key, execution] of this.executions) {
      if (!execution.terminal) continue;
      const terminalSeq = execution.terminalSeq;
      // New inputs cannot need an already-ended execution; older unbound inputs may.
      const pinned = terminalSeq !== undefined && [...this.submissions.values()].some(submission =>
        !submission.definitivelyRejected && !submission.target && submission.createdSeq < terminalSeq);
      if (pinned) continue;
      this.totalBytes -= execution.accumulator.size;
      this.executions.delete(key);
      for (const [id, record] of this.submissions) if (record.target === execution && record.acknowledged) this.submissions.delete(id);
      break;
    }
  }
  /** Check serialized event bytes against frame and pending-queue budgets without reserving capacity; emit and tryEmit share this admission rule. */
  private eventExceedsByteCapacity(bytes: number): boolean {
    return bytes > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024) || this.pendingBytes + bytes > (this.options.runtime?.queue?.maxBytes ?? 16 * 1024 * 1024);
  }
  /** Clone and enqueue an adapter event for ordered publication; reject closed/invalid/overflow input and fail observation on processing errors. Resolves after publication. */
  emit(payload: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError('STREAM_CLOSED'));
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(payload)); } catch { return Promise.reject(new HarnessSdkError('PROTOCOL_ERROR')); }
    if (this.eventExceedsByteCapacity(bytes)) {
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
  /** Attempt non-blocking adapter event admission; return false and fail observation on serialization/capacity failure. Publication errors are observed asynchronously. */
  tryEmit(payload: AhpEventPayload, scope: EventScope = {}): boolean {
    if (this.closed || this.backlog >= (this.options.runtime?.queue?.maxEvents ?? 2048)) { void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return false; }
    try {
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (this.eventExceedsByteCapacity(bytes)) { void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return false; }
    } catch { void this.fail(new HarnessSdkError('PROTOCOL_ERROR')); return false; }
    void this.emit(payload, scope).catch(() => {}); return true;
  }
  /** Process one queued event synchronously: validate, admit lifecycle changes, project, retain and publish. Throw to emit's failure chain; terminal results settle before their streams end. */
  private publish(rawPayload: AhpEventPayload, scope: EventScope): void {
    if (this.closed) return;
    const turnId = this.validateEvent(rawPayload, scope);
    const admitted = this.admitEvent(rawPayload, turnId);
    if (!admitted) return;
    // Privacy projection preserves protocol identities while redacting content.
    const publicPayload = this.secrets.event(admitted.payload, turnId);
    const event: AhpEvent = { ...scope, ...(turnId ? { turnId } : {}), sessionId: this.id, streamId: this.streamId, seq: ++this.seq, timestamp: (this.options.runtime?.now ?? (() => new Date().toISOString()))(), ...publicPayload };
    assertEvent(event);
    if (admitted.execution) this.retainEvent(admitted.execution, event);
    this.updateStatus();
    this.hub.publish(event);
  }
  /** Resolve envelope identity and validate raw shape before any lifecycle mutation; called by publish, throws protocol/capability errors and returns the optional execution identity. */
  private validateEvent(rawPayload: AhpEventPayload, scope: EventScope): string | undefined {
    const turnId = scope.turnId ?? (rawPayload.type === 'turn/started' || rawPayload.type === 'turn/completed' ? rawPayload.payload.turnId : undefined);
    if ((rawPayload.type === 'turn/started' || rawPayload.type === 'turn/completed') && scope.turnId && scope.turnId !== rawPayload.payload.turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting execution identities');
    if (rawPayload.type === 'extension' && !supportsExtension(this.capabilities, rawPayload.payload.name, rawPayload.payload.version)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const itemId = rawPayload.type === 'item/delta' ? rawPayload.payload.itemId : rawPayload.type === 'item/started' || rawPayload.type === 'item/completed' ? rawPayload.payload.item.id : undefined;
    if (scope.itemId && itemId && scope.itemId !== itemId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item identities');
    // Invalid shapes must not reserve execution or submission state.
    assertEvent({ ...scope, sessionId: this.id, streamId: this.streamId, seq: this.seq + 1, timestamp: new Date().toISOString(), ...rawPayload });
    return turnId;
  }
  /** Apply ordered submission/session changes or admit execution events; return undefined for ignored duplicates. Called only after shape validation; may reject unknown/conflicting identities. */
  private admitEvent(rawPayload: AhpEventPayload, turnId: string | undefined): { payload: AhpEventPayload; execution?: Execution } | undefined {
    let execution: Execution | undefined;
    let processedPayload = rawPayload;
    if (rawPayload.type === 'submission/bound') {
      const submission = this.submissions.get(rawPayload.payload.submissionId);
      if (!submission) throw new HarnessSdkError('PROTOCOL_ERROR', 'Unknown submission binding');
      this.bindRecord(submission, rawPayload.payload.turnId);
    } else if (rawPayload.type === 'submission/status') {
      const submission = this.submissions.get(rawPayload.payload.submissionId);
      if (!submission) throw new HarnessSdkError('PROTOCOL_ERROR', 'Unknown submission status');
      if (rawPayload.payload.status === 'rejected' || rawPayload.payload.status === 'unknown') {
        submission.definitivelyRejected = rawPayload.payload.status === 'rejected';
        const error = rawPayload.payload.error;
        submission.executionBinding.reject(error ? new HarnessSdkError(error.code, error.code, error.retryable, error.outcomeUnknown) : new HarnessSdkError('SUBMISSION_REJECTED'));
      }
      processedPayload = this.projectSubmissionStatus(rawPayload);
    } else if (rawPayload.type === 'session/metadata') {
      this.state.metadata = { ...this.state.metadata, ...structuredClone(rawPayload.payload) };
    } else if (rawPayload.type === 'session/state') {
      if (!matchesBinding(rawPayload.payload.binding, this.binding)) throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
      this.adoptState(rawPayload.payload);
      this.updateStatus();
      processedPayload = { type: 'session/state', payload: this.state };
    } else if (turnId) {
      execution = this.context(turnId);
      if (!this.admitExecutionEvent(execution, rawPayload)) return;
    }
    return { payload: processedPayload, execution };
  }
  /** Redact submission diagnostics and receipts without changing protocol status/identity; admitEvent calls after association rejection so private native details never reach observers. Projection failures propagate. */
  private projectSubmissionStatus(event: Extract<AhpEventPayload, { type: 'submission/status' }>): AhpEventPayload {
    const { receipt, error } = event.payload;
    return { ...event, payload: {
      ...event.payload,
      ...(receipt ? { receipt: this.secrets.json(publicValue(receipt)) as typeof receipt } : {}),
      ...(error ? { error: {
        ...error,
        message: this.secrets.text(error.message),
        ...(error.details ? { details: this.secrets.json(publicValue(error.details)) as typeof error.details } : {}),
      } } : {}),
    } };
  }
  /** Enforce turn/item ordering before publication; return false for duplicate starts/completions, throw on invalid transitions, and mutate only admitted lifecycle markers. */
  private admitExecutionEvent(execution: Execution, rawPayload: AhpEventPayload): boolean {
    if (rawPayload.type === 'turn/started') {
      if (execution.started || execution.terminal) return false;
      execution.started = true;
    }
    if (rawPayload.type === 'turn/completed') {
      if (execution.terminal) return false;
      if (!execution.started) throw new HarnessSdkError('PROTOCOL_ERROR', 'Turn ended without start');
    }
    if (rawPayload.type.startsWith('item/')) {
      if (!execution.started || execution.terminal) throw new HarnessSdkError('PROTOCOL_ERROR', 'Item outside execution');
      const itemId = rawPayload.type === 'item/delta' ? rawPayload.payload.itemId : rawPayload.type === 'item/started' || rawPayload.type === 'item/completed' ? rawPayload.payload.item.id : undefined;
      if (itemId) {
        const previousState = execution.items.get(itemId);
        if (
          (rawPayload.type === 'item/started' && previousState !== undefined) ||
          (rawPayload.type === 'item/delta' && previousState !== 'started')
        ) throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid item lifecycle');
        if (rawPayload.type === 'item/completed' && previousState === 'completed') return false;
        if (rawPayload.type !== 'item/delta') execution.items.set(itemId, rawPayload.type === 'item/completed' ? 'completed' : 'started');
      }
    }
    return true;
  }
  /** Accumulate an admitted public event and enforce the shared result budget; settle terminal results before publishing/ending execution events. Throws accumulator or budget errors to publish. */
  private retainEvent(execution: Execution, event: AhpEvent): void {
    const previous = execution.accumulator.size;
    execution.accumulator.accept(event);
    this.totalBytes += execution.accumulator.size - previous;
    if (this.totalBytes > positive(this.options.limits?.maxResultBytes, 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    if (event.type === 'turn/completed') {
      execution.terminal = true;
      execution.terminalSeq = this.seq;
      execution.completion.resolve(execution.accumulator.finish(event.payload));
    }
    execution.events.publish(event);
    if (execution.terminal) execution.events.end();
  }
  /** Allocate identity for a new host/Turn control request using the host ID source; generator failures propagate. Replayed dispatches retain their existing identity. */
  private requestIdentity() { return { sessionId: this.id, requestId: this.createId() }; }
  /** Queue native submission association through the ordered event path; reject publication failure. */
  bindSubmission(submissionId: string, turnId: string): Promise<void> {
    return this.emit({ type: 'submission/bound', payload: { submissionId, turnId } });
  }
  /** Resolve association without changing an existing target; throw PROTOCOL_ERROR on conflicting or definitively rejected bindings. */
  private bindRecord(record: SubmissionRecord, turnId: string): void {
    if (record.target && record.target.id !== turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Submission rebound');
    if (record.definitivelyRejected) throw new HarnessSdkError('PROTOCOL_ERROR', 'Rejected submission bound');
    record.target ??= this.context(turnId);
    record.executionBinding.resolve(record.target);
  }
  /** Reject association and track dispatch acknowledgement; unknown outcomes remain eligible for late binding and cannot be prematurely reclaimed. */
  private rejectSubmission({ record, cause, dispatch }: { record: SubmissionRecord; cause: unknown; dispatch: 'pending' | 'acknowledged' }): void {
    record.definitivelyRejected = !sdkError(cause).outcomeUnknown;
    record.acknowledged ||= dispatch === 'acknowledged';
    record.executionBinding.reject(cause);
  }
  /** Return or allocate submission bookkeeping, reclaiming acknowledged terminal/rejected entries only; throw BACKPRESSURE_EXCEEDED instead of evicting unresolved work. */
  private record(id: string): SubmissionRecord {
    const existing = this.submissions.get(id);
    if (existing) return existing;
    const limit = positive(this.options.limits?.maxSubmissions, 1024);
    if (this.submissions.size >= limit) {
      for (const [key, value] of this.submissions) if (value.acknowledged && (value.definitivelyRejected || value.target?.terminal)) { this.submissions.delete(key); break; }
    }
    if (this.submissions.size >= limit) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Submission limit exceeded');
    const record: SubmissionRecord = { executionBinding: deferred<ExecutionObservation>(), createdSeq: this.seq, definitivelyRejected: false, acknowledged: false };
    this.submissions.set(id, record);
    return record;
  }
  /** Normalize input and submit once; resolve a Turn on association independently of receipt/terminal timing. Reject validation, dispatch or caller wait failure. */
  submit(options: SubmitOptions, wait: RequestOptions = {}): Promise<Turn> {
    try {
      return this.submitExecution('input/submit', { ...options, input: inputBlocks(options.input), delivery: options.delivery ?? 'native' }, wait);
    } catch (cause) { return Promise.reject(cause); }
  }
  /** Submit review through the input association lifecycle; resolve a Turn or reject admission, dispatch or wait failure. */
  review(options: { target: AhpRequestMap['review/start']['target'] }, wait: RequestOptions = {}): Promise<Turn> {
    return this.submitExecution('review/start', options, wait);
  }
  /** Validate before allocating a submission, observe dispatch independently, then wait for binding; wait cancellation/deadline leaves native work and late bookkeeping alive. */
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
      this.rejectSubmission({ record, cause, dispatch: record.requestId ? 'pending' : 'acknowledged' });
    });
    return waitForRequest(async () => new Turn(await record.executionBinding.promise), wait, this.options.runtime?.requestTimeoutMs);
  }
  /** Send an explicit native session interrupt; reject capability, dispatch or wait failures. Local disposal never calls this implicitly. */
  interrupt(options: { cancelQueued?: boolean } = {}, wait?: RequestOptions): Promise<AhpResultMap['session/interrupt']> {
    return this.request('session/interrupt', { ...this.requestIdentity(), ...options }, wait);
  }
  /** Reject business calls after closure, during close or unknown-outcome recovery; retain the explicit controls needed for recovery. */
  private assertCallable(method: SessionMethod): void {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const control = method === 'session/interrupt' || method === 'turn/interrupt' || method === 'interaction/respond' || method === 'interaction/cancel';
    if (this.closing && !control) throw new HarnessSdkError('SESSION_CLOSING');
    if (this.recovering && !control && method !== 'history/read' && method !== 'session/close') throw new HarnessSdkError('RECOVERY_REQUIRED');
  }
  /** Dispatch a host request with caller-scoped waiting; close uses owned shutdown. Reject invalid ordinary waits before dispatch; native work survives cancellation. */
  request<M extends SessionMethod>(method: M, params: AhpRequestMap[M], wait: RequestOptions = {}): Promise<AhpResultMap[M]> {
    if (method === 'session/close') {
      try { guardRequest(method, params, this.id, this.capabilities); } catch (cause) { return Promise.reject(cause); }
      return this.closeRequest(params as AhpRequestMap['session/close'], wait) as Promise<AhpResultMap[M]>;
    }
    if (invalidWait(wait)) return Promise.reject(new HarnessSdkError('INVALID_PARAMS'));
    if (wait.signal?.aborted) return Promise.reject(new HarnessSdkError('REQUEST_ABORTED'));
    return waitForRequest(() => this.dispatchOperation(method, params), wait, this.options.runtime?.requestTimeoutMs);
  }
  /** Admit/deduplicate one request, cache its closure-raced outcome and observe late bookkeeping; reject validation, identity or capacity failures before native dispatch. Host wait deadlines never own this work. */
  private dispatchOperation<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    try { this.assertCallable(method); guardRequest(method, params, this.id, this.capabilities); } catch (cause) { return Promise.reject(cause); }
    if (Buffer.byteLength(JSON.stringify(params)) > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024)) return Promise.reject(new HarnessSdkError('FRAME_TOO_LARGE'));
    params = structuredClone(params);
    const key = JSON.stringify([method, params.requestId]), fingerprint = JSON.stringify(params);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new HarnessSdkError('REQUEST_ID_CONFLICT'));
      return previous.result as Promise<AhpResultMap[M]>;
    }
    const limit = this.options.runtime?.requestCacheSize ?? 1024;
    if (this.requests.size >= limit) {
      for (const [id, value] of this.requests) {
        if (!value.settled) continue;
        this.requests.delete(id);
        break;
      }
    }
    if (this.requests.size >= limit) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'));
    if (isSubmissionMethod(method)) {
      const id = (params as AhpRequestMap['input/submit']).submissionId;
      const existing = this.submissions.get(id);
      if (existing?.requestId && existing.requestId !== params.requestId) return Promise.reject(new HarnessSdkError('SUBMISSION_ID_CONFLICT'));
      try { this.record(id).requestId = params.requestId; } catch (cause) { return Promise.reject(cause); }
    }
    const requestOutcome = Promise.race([Promise.resolve().then(() => this.executeRequest(method, params)), this.ended.promise]);
    const entry = { fingerprint, result: requestOutcome, settled: false };
    this.requests.set(key, entry);
    // The cached/returned outcome races the backend result against observation closure.
    // It does not wait for binding or status publication; bookkeeping failures go to fail.
    const outcomeBookkeeping = requestOutcome.then(
      /** Release cache capacity before success bookkeeping; its failures must not change the cached outcome. */
      result => {
        entry.settled = true;
        return this.onRequestSucceeded({ method, params, result });
      },
      /** Release cache capacity before recovery/status handling; submission reclamation still waits for publication. */
      cause => {
        entry.settled = true;
        return this.onRequestFailed({ method, params, cause });
      },
    );
    void outcomeBookkeeping.catch(cause => { void this.fail(cause); });
    return requestOutcome;
  }
  /** Execute once for dispatchOperation, validate native identities, project public content and update request-owned state. Reject backend/validation/privacy failures; caller waits never own these effects. */
  private async executeRequest<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (!this.backend) throw new HarnessSdkError('NOT_INITIALIZED');
    let result: unknown;
    if (method === 'interaction/respond') {
      const value = params as AhpRequestMap['interaction/respond'];
      result = await this.interactions.respond(value.interactionId, value.requestId, value.response);
    } else if (method === 'interaction/cancel') {
      const value = params as AhpRequestMap['interaction/cancel'];
      result = await this.interactions.cancel(value.interactionId, value.reason);
    } else result = await this.backend.execute(method, params);
    this.validateNativeResult({ method, params, result });
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
  }
  /** Validate native shape and request/result identities before any projection or state update; executeRequest calls once, and malformed outcomes also fail observation. */
  private validateNativeResult<M extends SessionMethod>({ method, params, result }: { method: M; params: AhpRequestMap[M]; result: unknown }): void {
    try { assertResult(method, result); }
    catch { this.rejectNativeResult('Invalid native result'); }
    if (isSubmissionMethod(method) && (result as AhpResultMap['input/submit']).submissionId !== (params as AhpRequestMap['input/submit']).submissionId) {
      this.rejectNativeResult('Conflicting submission identity');
    }
    if (method === 'turn/steer' && (result as AhpResultMap['turn/steer']).turnId !== (params as AhpRequestMap['turn/steer']).expectedTurnId) {
      this.rejectNativeResult('Conflicting steer target');
    }
  }
  /** Fail observation and throw the same unknown-outcome protocol error to dispatch; used only for invalid native results whose execution effects cannot be inferred safely. */
  private rejectNativeResult(message: string): never {
    const cause = new HarnessSdkError('PROTOCOL_ERROR', message, false, true);
    void this.fail(cause);
    throw cause;
  }
  /** Acknowledge a successful submission and queue binding before status; dispatch outcome is already settled. Publication failures fail observation through dispatchOperation. */
  private async onRequestSucceeded<M extends SessionMethod>({ method, params, result }: { method: M; params: AhpRequestMap[M]; result: AhpResultMap[M] }): Promise<void> {
    if (!isSubmissionMethod(method)) return;
    const response = result as AhpResultMap['input/submit'] | AhpResultMap['turn/steer'];
    const record = this.submissions.get(response.submissionId);
    if (!record) return;
    record.acknowledged = true;
    if ('turnId' in response) {
      if (method === 'turn/steer' && response.turnId !== (params as AhpRequestMap['turn/steer']).expectedTurnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Wrong steer target');
      await this.bindSubmission(response.submissionId, response.turnId);
    }
    const disposition = 'disposition' in response ? response.disposition : undefined;
    if (!this.closed) await this.emit({ type: 'submission/status', payload: {
      submissionId: response.submissionId,
      status: disposition === 'dispatched' || disposition === 'queued' ? disposition : 'accepted',
      ...('receipt' in response && response.receipt ? { receipt: response.receipt } : {}),
    } });
  }
  /** Mark unknown dispatch outcomes for recovery, publish submission failure, then acknowledge rejection; records stay pinned until publication. Errors go to dispatchOperation's failure observer. */
  private async onRequestFailed<M extends SessionMethod>({ method, params, cause }: { method: M; params: AhpRequestMap[M]; cause: unknown }): Promise<void> {
    const error = sdkError(cause);
    if (error.outcomeUnknown && method !== 'history/read' && method !== 'turn/interrupt' && method !== 'session/interrupt') { this.recovering = true; this.updateStatus(); }
    if (!isSubmissionMethod(method)) return;
    const id = (params as AhpRequestMap['input/submit']).submissionId, record = this.submissions.get(id);
    if (record && !this.closed) await this.emit({ type: 'submission/status', payload: { submissionId: id, status: error.outcomeUnknown ? 'unknown' : 'rejected', error: { code: error.code, message: error.code, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown } } });
    if (record) this.rejectSubmission({ record, cause: error, dispatch: 'acknowledged' });
  }
  /** Register/publish a native request before running a host handler; resolve after native response/publication or reject settlement failure. Abort handler signals on settlement/teardown. */
  async requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse> {
    if (this.closed) { await responder(null, 'session_closed'); throw new HarnessSdkError('SESSION_CLOSED'); }
    if (!this.capabilities.interactions?.includes(request.kind) || !Object.hasOwn(this.options.interactions ?? {}, request.kind)) { await responder(null, 'unsupported'); throw new HarnessSdkError('INTERACTION_UNSUPPORTED'); }
    const handler = this.options.interactions?.[request.kind] as InteractionHandler | undefined;
    if (handler && this.handlerCount >= (this.options.runtime?.maxPendingInteractions ?? 32)) { await responder(null, 'capacity'); throw new HarnessSdkError('BACKPRESSURE_EXCEEDED'); }
    const result = this.interactions.begin(request, responder);
    const controller = handler ? new AbortController() : undefined;
    if (controller) { this.handlers.set(request.interactionId, controller); this.handlerCount++; }
    await this.emit({ type: 'interaction/requested', payload: publicInteraction(request) }, { turnId: request.turnId, itemId: request.itemId });
    if (handler && controller) this.startInteractionHandler({ request, handler, controller });
    return result;
  }
  /** Schedule an admitted automatic handler after requested-event publication; ignore late answers after abort and release handler capacity only when host work settles. Cancellation failures are intentionally observed and swallowed. */
  private startInteractionHandler({ request, handler, controller }: { request: InteractionRequested; handler: InteractionHandler; controller: AbortController }): void {
    // Keep handler invocation and answer delivery in separate promise stages; a sentinel
    // distinguishes a skipped invocation without forcing an optional response value.
    const skipped = Symbol('aborted_handler');
    void Promise.resolve().then<InteractionResponse | typeof skipped>(() =>
      controller.signal.aborted ? skipped : handler(structuredClone(request), { signal: controller.signal })
    ).then(async response => {
      if (!controller.signal.aborted && response !== skipped) await this.interactions.respond(request.interactionId, this.createId(), response);
    }).catch(
      /** Cancel actionable interactions after handler failure; teardown/settlement owns aborted requests. Ignore secondary cancellation errors. */
      async () => {
        if (!controller.signal.aborted) await this.interactions.cancel(request.interactionId, 'handler_failed').catch(() => {});
      },
    ).finally(
      /** Release capacity only after host work settles, even when native settlement already aborted its signal. */
      () => {
        this.handlerCount--;
        this.handlers.delete(request.interactionId);
      },
    );
  }
  /** Accept native-side settlement without invoking its responder; pending observation rejects because no response value is available. */
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void> { return this.interactions.resolveExternally(result); }
  /** End local observation, reject waiters and abort handlers; callers retain native close and backend disposal responsibility. */
  private endObservation(cause: unknown): void {
    this.observationFailure ??= cause;
    this.closed = true; this.updateStatus(); this.ended.reject(cause);
    for (const value of this.submissions.values()) value.executionBinding.reject(cause);
    for (const execution of this.executions.values()) if (!execution.terminal) { execution.completion.reject(cause); execution.events.end(cause); }
    for (const controller of this.handlers.values()) controller.abort(); this.handlers.clear();
    this.hub.end(cause);
  }
  /** Close local observation with a safe unknown-outcome error, cancel interactions and attempt backend disposal; native execution stop remains unconfirmed. */
  async fail(cause: unknown): Promise<void> {
    if (this.closed) return;
    this.endObservation(new HarnessSdkError(sdkError(cause).code, 'Session observation failed', false, true, { source: 'sdk' }));
    await this.interactions.cancelAll('connection_lost');
    await this.disposeBackend().catch(() => {});
  }
  /** Request native close once and release resources after its receipt; abort/deadline only stops caller waiting. */
  close(wait: RequestOptions = {}): Promise<AhpResultMap['session/close']> {
    return this.closeRequest(this.requestIdentity(), wait);
  }
  /** Keep controls available during native close, then end observation after cleanup; reject aggregated failures. Failed native close resets admission for explicit recovery. */
  private closeRequest(params: AhpRequestMap['session/close'], wait: RequestOptions): Promise<AhpResultMap['session/close']> {
    if (invalidWait(wait)) return Promise.reject(new HarnessSdkError('INVALID_PARAMS'));
    if (wait.signal?.aborted) return Promise.reject(new HarnessSdkError('REQUEST_ABORTED'));
    if (this.closed) return waitForRequest(async () => { await this.disposeBackend(); return this.closeReceipt ?? { closed: true as const, observationClosed: true as const, executionStopped: 'unconfirmed' as const }; }, wait, this.options.runtime?.requestTimeoutMs);
    if (!this.closing) {
      // Dispatch before setting closing; later business calls are rejected while controls stay usable.
      const native = this.dispatchOperation('session/close', params);
      this.closing = native.then(
        result => this.finishClose(result),
        /** Restore admission after native rejection; preserve recovery for unknown outcomes and propagate the original cause. */
        cause => {
          this.closing = undefined;
          if (sdkError(cause).outcomeUnknown) this.recovering = true;
          this.updateStatus();
          throw cause;
        },
      );
      void this.closing.catch(() => {}); this.updateStatus();
    }
    const closing = this.closing;
    return waitForRequest(() => closing, wait, this.options.runtime?.requestTimeoutMs);
  }
  /** After native close succeeds, retain its receipt, attempt interaction and backend cleanup in order, then end observation; reject combined cleanup errors only after every attempt. Called by the shared close promise. */
  private async finishClose(result: AhpResultMap['session/close']): Promise<AhpResultMap['session/close']> {
    this.closeReceipt = result;
    const causes: unknown[] = [];
    try { await this.interactions.cancelAll('session_closed'); } catch (cause) { causes.push(cause); }
    try { await this.disposeBackend(); } catch (cause) { causes.push(cause); }
    this.endObservation(observationClosed(result.executionStopped === 'confirmed'));
    if (causes.length) throw combined(causes);
    return result;
  }
  /** Return the shared native-release promise for fail, close and dispose; invoke backend disposal at most once and propagate its rejection without asserting execution stopped. */
  private disposeBackend(): Promise<void> { return this.backendDisposal ??= this.backend?.dispose() ?? Promise.resolve(); }
  /** Idempotently end observation, abort handlers, cancel interactions, then dispose the backend; reject cleanup failure without claiming native termination. */
  dispose(): Promise<void> {
    /** Owned teardown runs independently of callers so repeated disposal shares both work and any cleanup rejection. */
    return this.disposal ??= (async () => {
      const cause = observationClosed(); this.endObservation(cause);
      await this.interactions.cancelAll('runtime_disposed');
      await this.disposeBackend();
    })();
  }
}
