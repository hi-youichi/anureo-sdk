// Coordinates dispatch, ordered observation and teardown for one native session.
import { assertResult, assertEvent, publicInteraction, publicValue, supportsExtension,
  type AhpEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap, type Capabilities,
  type InteractionRequested, type InteractionResponse, type SessionBinding, type SessionOpenParams, type SessionState } from '@anureo/protocol';
import { HarnessSdkError, sdkError } from './errors';
import { invalidWait, waitForRequest } from './request';
import type { ClientOptions, SubmitOptions } from './client-options';
import { InteractionRegistry } from './lifecycle/interactions';
import { SecretRedactor } from './privacy/secrets';
import type { BackendSession, EventScope, NativeInteractionResponder, SessionEventSink, SessionMethod } from './ports';
import { EventHub } from './lifecycle/events';
import { guardRequest } from './requests/guard';
import { ResultAccumulator } from './lifecycle/result';
import { Turn } from './turn';
import type { ExecutionObservation } from './lifecycle/execution-observation';
import type { EventSubscriptionOptions, RequestOptions, TurnResult } from './types';
import { deferred } from './lifecycle/deferred';
import { immutable } from './lifecycle/immutable';
import { inputBlocks } from './lifecycle/input';
import { positive } from './lifecycle/limits';
import { combined, observationClosed } from './lifecycle/errors';

/**
 * Submit input, dispatch requests and observe events for a session opened through Client.
 * Await close to request native close and release resources, or dispose to release observation
 * and backend resources with native stop unconfirmed. Client.dispose also releases its sessions.
 */
export class Session implements SessionEventSink {
  /**
   * Client.open constructs this sink before starting native open so callbacks and teardown can race
   * attachment safely. Clone initial state, allocate stream identity and install privacy/interaction
   * hooks without acquiring a backend. ID generation or cloning can throw; Client owns later disposal.
   */
  constructor(private readonly params: SessionOpenParams, private readonly options: ClientOptions, capabilities: Capabilities, private readonly createId: () => string) {
    this.streamId = createId();
    this.state = { binding: immutable(params.binding), capabilities: immutable(capabilities), capabilityRevision: 1, config: structuredClone(params.config ?? {}), status: 'opening', activeTurnIds: [], ...(params.model ? { model: params.model } : {}) };
    this.secrets = new SecretRedactor(value => options.runtime?.onMarkedSecret?.(this.binding, value));
    /**
     * InteractionRegistry.respond, cancel and resolveExternally invoke this registered publisher.
     * Abort/remove handler identity before awaiting ordered resolution publication; rejection goes
     * back to registry settlement. startInteractionHandler still owns capacity until host work settles.
     */
    this.interactions = new InteractionRegistry(async result => {
      this.handlers.get(result.interactionId)?.abort();
      this.handlers.delete(result.interactionId);
      if (!this.closed) await this.emit({ type: 'interaction/resolved', payload: result });
    }, { maxPending: options.runtime?.maxPendingInteractions ?? 32, timeoutMs: options.runtime?.interactionTimeoutMs ?? 600_000, responseTimeoutMs: options.runtime?.requestTimeoutMs }, (request, response) => this.secrets.rememberResponse(request, response));
  }
  /**
   * Read the stable session ID used in request and event envelopes.
   */
  get id(): string { return this.state.binding.sessionId; }
  /**
   * Read a detached, frozen copy of the current binding. Its native reference may change after
   * a revert or a native state update. Cloning failures throw synchronously.
   */
  get binding(): Readonly<SessionBinding> { return immutable(this.state.binding); }
  /**
   * Capture the current binding and the original working directory for Client.sessions.resume or
   * Client.sessions.fork. Cloning failures throw synchronously.
   */
  get reference(): Readonly<{ binding: SessionBinding; cwd: string }> { return immutable({ binding: this.binding, cwd: this.params.cwd }); }
  /**
   * Read a detached, frozen copy of the session's current capabilities before choosing an operation.
   * Cloning failures throw synchronously.
   */
  get capabilities(): Readonly<Capabilities> { return immutable(this.state.capabilities); }
  /**
   * Read a frozen, privacy-filtered copy of the currently admitted state without waiting for
   * the event queue. Projection or cloning failures throw synchronously.
   */
  get snapshot(): Readonly<SessionState> { return immutable(this.secrets.state(this.state)); }
  /**
   * OutputSession.publishOutput invokes this optional sink hook before revalidating final JSON.
   * Return marked-secret projection without mutating the candidate; OutputSession owns schema failure
   * handling and final publication.
   */
  projectOutput(text: string): string { return this.secrets.text(text); }
  /**
   * Attach the backend, restore active observations and publish initial state. Client.attachSession
   * awaits this before returning a session to the host. Dispose a mismatched or already-closed
   * attachment before rejecting. Adoption or publication failure rejects to Client.open, which
   * owns session cleanup.
   */
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
  /**
   * Subscribe to future session events without replay; subscribe before submitting to observe its
   * lifecycle from admission. Each subscription is isolated and bounded; invalid limits throw and later
   * failures reject reads. Consumers must exhaust, return or abort the iterator to release it. Detaching
   * or overflowing this observer does not stop native execution or affect sibling subscriptions.
   */
  events(options?: EventSubscriptionOptions): AsyncIterable<AhpEvent> { return this.hub.subscribe(options); }
  /**
   * Client.attachSession supplies this sink to OutputSession, whose event forwarding calls it;
   * Session.bindSubmission, outcome bookkeeping and interaction hooks also await the same ordered path.
   * Clone and enqueue a payload. Resolve once the ordered queue processes it, even when a duplicate
   * is suppressed or observation has since closed. Reject closed admission, serialization, cloning,
   * capacity or processing failures. Overflow and processing failures also end observation.
   */
  emit(payload: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError('STREAM_CLOSED'));
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(payload)); } catch { return Promise.reject(new HarnessSdkError('PROTOCOL_ERROR')); }
    if (this.eventExceedsByteCapacity(bytes)) {
      const cause = new HarnessSdkError('BACKPRESSURE_EXCEEDED'); void this.fail(cause); return Promise.reject(cause);
    }
    if (++this.backlog > this.maxQueuedEvents()) {
      this.backlog--;
      void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED'));
      return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'));
    }
    this.pendingBytes += bytes;
    let copy: AhpEventPayload;
    try { copy = structuredClone(payload); }
    catch { this.backlog--; this.pendingBytes -= bytes; return Promise.reject(new HarnessSdkError('PROTOCOL_ERROR')); }
    const target = { ...scope };
    const operation = this.source.then(() => this.publish(copy, target));
    this.source = operation.catch(cause => { void this.fail(cause); }).finally(
      /** emit registers this after failure observation; release the event's queue reservation on either outcome without awaiting teardown. */
      () => { this.backlog--; this.pendingBytes -= bytes; },
    );
    return operation;
  }
  /**
   * A direct adapter sink consumer unable to await publication can use this admission probe. Return
   * false on closure, serialization or capacity failure and invoke fail; true means the immediate
   * checks passed, with emit rejection observed asynchronously. It does not promise successful
   * publication. OutputSession.open supplies its own native-adapter tryEmit forwarding callback.
   */
  tryEmit(payload: AhpEventPayload, scope: EventScope = {}): boolean {
    if (this.closed || this.backlog >= this.maxQueuedEvents()) { void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return false; }
    try {
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (this.eventExceedsByteCapacity(bytes)) { void this.fail(new HarnessSdkError('BACKPRESSURE_EXCEEDED')); return false; }
    } catch { void this.fail(new HarnessSdkError('PROTOCOL_ERROR')); return false; }
    void this.emit(payload, scope).catch(() => {}); return true;
  }
  /**
   * Native sink consumers may report association here; onRequestSucceeded awaits it when a receipt
   * contains turnId. Queue submission/bound through emit so event admission orders association against
   * native completion. Publication failures reject; successful association can release submit's Turn
   * before a separate native receipt settles. Wrapped adapters reach the same event path via OutputSession.
   */
  bindSubmission(submissionId: string, turnId: string): Promise<void> {
    return this.emit({ type: 'submission/bound', payload: { submissionId, turnId } });
  }
  /**
   * Submit text or protocol blocks. Delivery defaults to native, so the adapter may queue the input
   * or join an existing execution. Resolve a Turn as soon as the input is bound to an execution,
   * independently of receipt or terminal timing. Normalization, admission, dispatch and wait failures
   * can reject before association. Use Turn.result for the terminal outcome and dispose the handle
   * when finished observing. Abort or timeout leaves admitted work running.
   */
  submit(options: SubmitOptions, wait: RequestOptions = {}): Promise<Turn> {
    try {
      return this.submitExecution({
        method: 'input/submit', options: { ...options, input: inputBlocks(options.input), delivery: options.delivery ?? 'native' },
      }, wait);
    } catch (cause) { return Promise.reject(cause); }
  }
  /**
   * Hosts start a native review through submitExecution's association lifecycle. Resolve a Turn on
   * binding or reject admission/dispatch/wait failure; caller cancellation leaves admitted work alive.
   * ID generation or option cloning can throw synchronously. The returned observer follows the same
   * disposal and native-control rules as submit.
   */
  review(options: { target: AhpRequestMap['review/start']['target'] }, wait: RequestOptions = {}): Promise<Turn> {
    return this.submitExecution({ method: 'review/start', options }, wait);
  }
  /**
   * Request interruption for the whole session. Set cancelQueued only if advertised by the session.
   * Resolve the native receipt or reject on capability, dispatch or wait failure. Caller cancellation
   * affects waiting only. Use Turn.result for a terminal execution outcome.
   * Request ID generation can throw synchronously before request is called.
   */
  interrupt(options: { cancelQueued?: boolean } = {}, wait?: RequestOptions): Promise<AhpResultMap['session/interrupt']> {
    return this.request('session/interrupt', { ...this.requestIdentity(), ...options }, wait);
  }
  /**
   * Dispatch a typed session request and await its receipt. Matching method/request IDs replay the
   * cached outcome while retained; changed params or a submission reserved by another request reject
   * with a conflict. session/close instead shares its existing close work regardless of request ID.
   * Hosts and context's Turn control callbacks use this entry. Ordinary calls validate
   * wait options before dispatch and return a caller-scoped receipt wait; session/close validates the
   * request first and uses closeRequest's shared teardown. Validation, dispatch and wait failures reject;
   * admitted native work, bookkeeping and cleanup survive cancellation without automatic retries.
   */
  request<M extends SessionMethod>(method: M, params: AhpRequestMap[M], wait: RequestOptions = {}): Promise<AhpResultMap[M]> {
    if (method === 'session/close') {
      try { guardRequest(method, params, this.id, this.capabilities); } catch (cause) { return Promise.reject(cause); }
      return this.closeRequest(params as AhpRequestMap['session/close'], wait) as Promise<AhpResultMap[M]>;
    }
    const waitError = requestWaitError(wait);
    if (waitError) return Promise.reject(waitError);
    return waitForRequest(() => this.dispatchOperation(method, params), wait, this.options.runtime?.requestTimeoutMs);
  }
  /**
   * Settle a native interaction through a configured handler or manual interaction/respond request.
   * OutputSession.open forwards the adapter's request/responder here. An own key in
   * ClientOptions.interactions enables the kind; undefined selects manual handling and omission rejects
   * it. Notify native rejection for closed/unsupported/handler-capacity cases, otherwise register
   * settlement and publish interaction/requested before scheduling a configured host handler. Return
   * the registry's response after native settlement/publication, or reject its failure. The host handler
   * owns its work; Session aborts its signal on settlement/teardown without cancelling that work.
   */
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
  /**
   * OutputSession.open forwards native settlement reports here; direct adapters can use the sink too.
   * Return InteractionRegistry.resolveExternally's publication promise without invoking the responder.
   * The original interaction wait rejects even for responded because native supplied no response value;
   * unknown/already-resolved IDs are ignored by the registry.
   */
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void> { return this.interactions.resolveExternally(result); }
  /**
   * OutputSession forwards adapter observation loss here; emit, tryEmit, rejectNativeResult and cached
   * bookkeeping also invoke it. Idempotently end observation with a safe unknown-outcome SDK error,
   * await interaction cancellation, then attempt backend release while suppressing release-promise
   * rejection. A synchronous disposal throw rejects this call. Native execution stop stays unconfirmed;
   * the first caller can await cleanup without initiating a native interrupt; later calls return early.
   */
  async fail(cause: unknown): Promise<void> {
    if (this.closed) return;
    this.endObservation(new HarnessSdkError(sdkError(cause).code, 'Session observation failed', false, true, { source: 'sdk' }));
    await this.interactions.cancelAll('connection_lost');
    await this.disposeBackend().catch(() => {});
  }
  /**
   * Request native close and await interaction and backend cleanup. Concurrent close calls share the
   * work. A session whose observation already ended awaits backend release and returns its stored
   * receipt or an unconfirmed-stop receipt. Cleanup failure can reject after native close succeeds.
   * Abort or timeout rejects only this caller's wait.
   * Request ID generation can throw synchronously before closeRequest is called.
   */
  close(wait: RequestOptions = {}): Promise<AhpResultMap['session/close']> {
    return this.closeRequest(this.requestIdentity(), wait);
  }
  /**
   * Client.open awaits this on setup/wait failure and Client.dispose awaits it before adapter release;
   * host session consumers may also call it directly. Share teardown and its rejection: end observation,
   * abort handler signals, await interaction cancellation, then release the backend. Native close is
   * caller-owned and execution stop remains unconfirmed; repeated disposal never repeats owned work.
   */
  dispose(): Promise<void> {
    /** dispose starts this owned teardown once; repeated calls share its completion/rejection while Client waits before releasing the adapter. */
    return this.disposal ??= (async () => {
      const cause = observationClosed(); this.endObservation(cause);
      await this.interactions.cancelAll('runtime_disposed');
      await this.disposeBackend();
    })();
  }
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
  /**
   * attach and admitEvent call before recomputing status. Replace native state with a detached clone,
   * preserving earlier metadata patches omitted by the snapshot. Clone failure propagates to attachment
   * or ordered publication; callers still own binding validation and active-execution bookkeeping.
   */
  private adoptState(state: SessionState): void {
    this.state = { ...structuredClone(state), ...((this.state.metadata || state.metadata) ? { metadata: { ...this.state.metadata, ...state.metadata } } : {}) };
  }
  /**
   * Recompute the status and active IDs exposed by snapshot and state events after lifecycle changes.
   * Closure, closing and recovery take precedence over execution activity.
   */
  private updateStatus(): void {
    this.state.activeTurnIds = [...this.executions.values()].filter(value => value.started && !value.terminal).map(value => value.id);
    if (this.closed) this.state.status = 'closed';
    else if (this.closing) this.state.status = 'closing';
    else if (this.recovering) this.state.status = 'recoveryRequired';
    else this.state.status = this.state.activeTurnIds.length ? 'running' : 'ready';
  }
  /**
   * attach restores active observations here; admitEvent and bindRecord reuse the same execution
   * registry for live events and late associations. Return an existing context or allocate bounded
   * completion/events/results and explicit Turn controls. Reclaim only an eligible terminal snapshot;
   * throw BACKPRESSURE_EXCEEDED if capacity stays pinned. Invalid budgets throw before insertion.
   * Turn owns each observer's cancellation.
   */
  private context(id: string): Execution {
    const known = this.executions.get(id); if (known) return known;
    const limit = positive(this.options.limits?.maxExecutions, 128);
    if (this.executions.size >= limit) this.reclaimExecution();
    if (this.executions.size >= limit) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Execution observation limit exceeded');
    const completion = deferred<TurnResult>();
    const context: Execution = {
      id, completion, result: completion.promise, events: new EventHub(), started: false, terminal: false, items: new Map(),
      accumulator: new ResultAccumulator(positive(this.options.limits?.maxResultBytes, 16 * 1024 * 1024), positive(this.options.limits?.maxItems, 2048)),
      /**
       * context installs this port on the shared observation; Turn.steer invokes it explicitly.
       * Normalize input and await request with this execution's atomic target. Admission/dispatch/
       * wait failures reject Turn.steer; caller cancellation leaves the native steer alive.
       */
      steer: async (input, wait) => { await this.request('turn/steer', { ...this.requestIdentity(), submissionId: this.createId(), expectedTurnId: id, input: inputBlocks(input) }, wait); },
      /**
       * context installs this port for explicit Turn.interrupt calls, awaiting request's native
       * control receipt and propagating its failures. Teardown never invokes it; native terminal
       * events still own execution completion after interruption.
       */
      interrupt: async wait => { await this.request('turn/interrupt', { ...this.requestIdentity(), turnId: id }, wait); },
    };
    this.executions.set(id, context); return context;
  }
  /**
   * context calls under execution-count pressure. Remove at most the oldest eligible terminal
   * execution, subtract its retained bytes and remove its acknowledged submissions. Older unbound
   * inputs pin possible late results; returning without eviction makes context reject capacity instead
   * of silently losing a future association. Existing Turn handles keep their shared context.
   */
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
  /** emit and tryEmit share the configured count budget, which defaults to 2048 queued events. */
  private maxQueuedEvents(): number {
    return this.options.runtime?.queue?.maxEvents ?? 2048;
  }
  /**
   * emit and tryEmit use this shared rule before reserving bytes. Report a frame/pending-byte budget
   * overflow without changing accounting; callers decide whether to reject or return false and fail
   * observation.
   */
  private eventExceedsByteCapacity(bytes: number): boolean {
    return bytes > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024) || this.pendingBytes + bytes > (this.options.runtime?.queue?.maxBytes ?? 16 * 1024 * 1024);
  }
  /**
   * emit schedules this synchronous phase on source and observes throws through fail. Validate before
   * admitting state changes, then project private content, retain execution results and publish the
   * public event. Ignore duplicate lifecycle events; settle terminal results before ending their stream.
   * Queued work arriving after observation closes is ignored.
   */
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
  /**
   * publish calls before any lifecycle mutation. Validate envelope/payload identity and extension
   * support, returning the optional execution ID used for admission and retention. Shape, identity or
   * capability errors throw into emit's failure chain without reserving execution/submission state.
   */
  private validateEvent(rawPayload: AhpEventPayload, scope: EventScope): string | undefined {
    const turnId = scope.turnId ?? (rawPayload.type === 'turn/started' || rawPayload.type === 'turn/completed' ? rawPayload.payload.turnId : undefined);
    if ((rawPayload.type === 'turn/started' || rawPayload.type === 'turn/completed') && scope.turnId && scope.turnId !== rawPayload.payload.turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting execution identities');
    if (rawPayload.type === 'extension' && !supportsExtension(this.capabilities, rawPayload.payload.name, rawPayload.payload.version)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const itemId = payloadItemId(rawPayload);
    if (scope.itemId && itemId && scope.itemId !== itemId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item identities');
    // Invalid shapes must not reserve execution or submission state.
    assertEvent({ ...scope, sessionId: this.id, streamId: this.streamId, seq: this.seq + 1, timestamp: new Date().toISOString(), ...rawPayload });
    return turnId;
  }
  /**
   * publish calls after validateEvent and consumes the returned payload/context for privacy projection
   * and retention. Route submission and session changes separately from execution admission; ignored
   * duplicates return undefined. Unknown/conflicting identity or invalid lifecycle transitions throw
   * into emit's observation-failure chain. This phase neither publishes nor settles terminal results.
   */
  private admitEvent(rawPayload: AhpEventPayload, turnId: string | undefined): { payload: AhpEventPayload; execution?: Execution } | undefined {
    switch (rawPayload.type) {
      case 'submission/bound': {
        const submission = this.submissions.get(rawPayload.payload.submissionId);
        if (!submission) throw new HarnessSdkError('PROTOCOL_ERROR', 'Unknown submission binding');
        this.bindRecord(submission, rawPayload.payload.turnId);
        return { payload: rawPayload };
      }
      case 'submission/status':
        return { payload: this.admitSubmissionStatus(rawPayload) };
      case 'session/metadata':
        this.state.metadata = { ...this.state.metadata, ...structuredClone(rawPayload.payload) };
        return { payload: rawPayload };
      case 'session/state':
        if (!matchesBinding(rawPayload.payload.binding, this.binding)) throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
        this.adoptState(rawPayload.payload);
        this.updateStatus();
        return { payload: { type: 'session/state', payload: this.state } };
    }
    if (!turnId) return { payload: rawPayload };
    const execution = this.context(turnId);
    if (!this.admitExecutionEvent(execution, rawPayload)) return;
    return { payload: rawPayload, execution };
  }
  /**
   * admitEvent routes submission/status here before publish can expose it. Reject an unresolved
   * association for rejected/unknown status, retaining unknown outcomes for late binding, then return
   * projected diagnostics. Unknown IDs or projection failures throw into emit's observation-failure
   * chain; acknowledgement remains owned by dispatch bookkeeping.
   */
  private admitSubmissionStatus(event: Extract<AhpEventPayload, { type: 'submission/status' }>): AhpEventPayload {
    const submission = this.submissions.get(event.payload.submissionId);
    if (!submission) throw new HarnessSdkError('PROTOCOL_ERROR', 'Unknown submission status');
    if (event.payload.status === 'rejected' || event.payload.status === 'unknown') {
      submission.definitivelyRejected = event.payload.status === 'rejected';
      const error = event.payload.error;
      submission.executionBinding.reject(error ? new HarnessSdkError(error.code, error.code, error.retryable, error.outcomeUnknown) : new HarnessSdkError('SUBMISSION_REJECTED'));
    }
    return this.projectSubmissionStatus(event);
  }
  /**
   * admitSubmissionStatus calls after any association rejection. Return status/identity unchanged
   * while projecting receipt and error content so private native diagnostics cannot reach observers.
   * Projection errors propagate through admission to emit; public event publication remains with publish.
   */
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
  /**
   * admitEvent calls with the context for a validated execution event. Enforce native turn/item order,
   * mutating execution-local markers only for admitted transitions. Return false to suppress duplicate
   * turn starts/completions or item completions; throw for invalid transitions. retainEvent owns terminal
   * settlement after privacy projection, so this phase does not finish the execution.
   */
  private admitExecutionEvent(execution: Execution, rawPayload: AhpEventPayload): boolean {
    if (rawPayload.type === 'turn/started') {
      if (execution.started || execution.terminal) return false;
      execution.started = true;
    }
    if (rawPayload.type === 'turn/completed') {
      if (execution.terminal) return false;
      if (!execution.started) throw new HarnessSdkError('PROTOCOL_ERROR', 'Turn ended without start');
    }
    if (rawPayload.type.startsWith('item/')) return this.admitItemEvent(execution, rawPayload);
    return true;
  }
  /**
   * admitExecutionEvent delegates item transitions here after payload validation. Require an active
   * execution and reject repeated starts or deltas without a live item. Completion snapshots may
   * introduce an item without a start; suppress repeated completions without changing its markers.
   */
  private admitItemEvent(execution: Execution, payload: AhpEventPayload): boolean {
    if (!execution.started || execution.terminal) throw new HarnessSdkError('PROTOCOL_ERROR', 'Item outside execution');
    const itemId = payloadItemId(payload);
    if (!itemId) return true;
    const previousState = execution.items.get(itemId);
    if (
      (payload.type === 'item/started' && previousState !== undefined) ||
      (payload.type === 'item/delta' && previousState !== 'started')
    ) throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid item lifecycle');
    if (payload.type === 'item/completed' && previousState === 'completed') return false;
    if (payload.type !== 'item/delta') execution.items.set(itemId, payload.type === 'item/completed' ? 'completed' : 'started');
    return true;
  }
  /**
   * publish passes an admitted public event here before session-wide fanout. Accumulate bounded result
   * content and update shared byte accounting; accumulator/budget errors throw into emit's failure chain.
   * For native completion, record terminal sequence and resolve Turn.result before publishing and ending
   * the execution hub. Session-wide publication and activity recomputation remain with publish.
   */
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
  /**
   * The context control callbacks, submitExecution, interrupt and close allocate fresh host request
   * identity here. Return sessionId/requestId from the configured ID source; generator failures throw.
   * Deduplicated dispatch reuses supplied identity rather than generating another request.
   */
  private requestIdentity() { return { sessionId: this.id, requestId: this.createId() }; }
  /**
   * admitEvent calls for an ordered submission/bound event. Reject conflicting or definitively rejected
   * bindings with PROTOCOL_ERROR; otherwise reuse/allocate the execution and resolve association.
   * submitExecution consumes that promise to construct a Turn independently of native acknowledgement;
   * the caller still owns event publication and dispatch bookkeeping.
   */
  private bindRecord(record: SubmissionRecord, turnId: string): void {
    if (record.target && record.target.id !== turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Submission rebound');
    if (record.definitivelyRejected) throw new HarnessSdkError('PROTOCOL_ERROR', 'Rejected submission bound');
    record.target ??= this.context(turnId);
    record.executionBinding.resolve(record.target);
  }
  /**
   * submitExecution uses this on dispatch rejection; onRequestFailed calls after failure-status
   * publication. Reject unresolved association with the original cause and track definitive rejection
   * and acknowledgement. Unknown outcomes stay eligible for late binding; a pending dispatch remains
   * pinned until bookkeeping acknowledges it. A resolved association is never undone.
   */
  private rejectSubmission({ record, cause, dispatch }: { record: SubmissionRecord; cause: unknown; dispatch: 'pending' | 'acknowledged' }): void {
    record.definitivelyRejected = !sdkError(cause).outcomeUnknown;
    record.acknowledged ||= dispatch === 'acknowledged';
    record.executionBinding.reject(cause);
  }
  /**
   * submitExecution allocates before waiting for association; reserveSubmission also uses it for dispatch
   * admission, including raw requests. Return existing bookkeeping or allocate a binding gate, reclaiming
   * at most one acknowledged rejected/terminal entry under pressure. Throw BACKPRESSURE_EXCEEDED rather
   * than evict unresolved work; callers own reservation, acknowledgement and settlement.
   */
  private getOrCreateSubmission(id: string): SubmissionRecord {
    const existing = this.submissions.get(id);
    if (existing) return existing;
    const limit = positive(this.options.limits?.maxSubmissions, 1024);
    if (this.submissions.size >= limit) this.reclaimSubmission();
    if (this.submissions.size >= limit) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Submission limit exceeded');
    const record: SubmissionRecord = { executionBinding: deferred<ExecutionObservation>(), createdSeq: this.seq, definitivelyRejected: false, acknowledged: false };
    this.submissions.set(id, record);
    return record;
  }
  /**
   * getOrCreateSubmission calls under submission-count pressure. Evict the oldest acknowledged
   * rejection or terminal association, if any. Unknown unbound submissions remain eligible for
   * late binding; getOrCreateSubmission rejects admission if nothing can be reclaimed.
   */
  private reclaimSubmission(): void {
    for (const [id, record] of this.submissions) {
      if (!record.acknowledged || (!record.definitivelyRejected && !record.target?.terminal)) continue;
      this.submissions.delete(id);
      return;
    }
  }
  /**
   * submit and review return this association wait. Validate before allocating bookkeeping, dispatch
   * independently, then construct a Turn when binding resolves. Observe dispatch rejection separately
   * so the original error reaches an unresolved association while admitted records stay pinned through
   * status publication. Caller abort/deadline ends only waiting; late binding and native work continue.
   * ID generation/cloning failures throw before dispatch; submit converts those throws to rejection.
   */
  private submitExecution({ method, options }: ExecutionSubmission, wait: RequestOptions): Promise<Turn> {
    const waitError = requestWaitError(wait);
    if (waitError) return Promise.reject(waitError);
    const submissionId = this.createId();
    const params = structuredClone({ ...options, ...this.requestIdentity(), submissionId });
    let record: SubmissionRecord;
    try {
      // Association storage must exist before dispatch can publish a native binding.
      this.validateRequestAdmission(method, params);
      record = this.getOrCreateSubmission(submissionId);
    } catch (cause) { return Promise.reject(cause); }
    // Observe the association independently: no native acceptance receipt is required.
    void this.dispatchOperation(method, params).catch(
      /** submitExecution observes rejection independently of its binding wait; preserve the cause, but leave admitted dispatches pinned until failure-status publication. */
      cause => this.rejectSubmission({ record, cause, dispatch: record.requestId ? 'pending' : 'acknowledged' }),
    );
    return waitForRequest(async () => new Turn(await record.executionBinding.promise), wait, this.options.runtime?.requestTimeoutMs);
  }
  /**
   * submitExecution checks before creating an association gate; dispatchOperation checks every
   * dispatch, including replays. Lifecycle failures take precedence over protocol/capability errors.
   * Callers return these throws as rejected promises before reserving native work.
   */
  private validateRequestAdmission<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): void {
    this.assertCallable(method);
    guardRequest(method, params, this.id, this.capabilities);
  }
  /**
   * validateRequestAdmission checks lifecycle before protocol and capability admission.
   * Throw for closed/closing/recovery-blocked business calls, retaining explicit interruption and
   * interaction controls during close/recovery plus history and close during recovery. Callers expose
   * these failures without native dispatch; this check changes no state.
   */
  private assertCallable(method: SessionMethod): void {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const control = method === 'session/interrupt' || method === 'turn/interrupt' || method === 'interaction/respond' || method === 'interaction/cancel';
    if (this.closing && !control) throw new HarnessSdkError('SESSION_CLOSING');
    if (this.recovering && !control && method !== 'history/read' && method !== 'session/close') throw new HarnessSdkError('RECOVERY_REQUIRED');
  }
  /**
   * request, submitExecution and closeRequest call before applying their own wait ownership. Validate
   * and detach params, replay matching cached outcomes, admit capacity and reserve submission identity,
   * then cache new work. Admission errors reject before native dispatch; request identity conflicts do
   * not replace cached work. Serialization/cloning can throw to the surrounding caller; host deadlines
   * never cancel the cached outcome or its bookkeeping.
   */
  private dispatchOperation<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    try { this.validateRequestAdmission(method, params); } catch (cause) { return Promise.reject(cause); }
    if (Buffer.byteLength(JSON.stringify(params)) > (this.options.runtime?.queue?.maxFrameBytes ?? 8 * 1024 * 1024)) return Promise.reject(new HarnessSdkError('FRAME_TOO_LARGE'));
    params = structuredClone(params);
    const key = JSON.stringify([method, params.requestId]);
    const fingerprint = JSON.stringify(params);
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new HarnessSdkError('REQUEST_ID_CONFLICT'));
      return previous.result as Promise<AhpResultMap[M]>;
    }
    if (!this.admitRequestCapacity()) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'));
    if (isSubmissionMethod(method)) {
      try { this.reserveSubmission(params as AhpRequestMap[SubmissionMethod]); }
      catch (cause) { return Promise.reject(cause); }
    }
    return this.cacheRequestOutcome({ method, params, key, fingerprint });
  }
  /**
   * dispatchOperation calls after replay checks and before reserving submission identity. Reclaim at
   * most the oldest settled request, then report whether a new dispatch fits. Unsettled outcomes stay
   * cached even when their host observers have cancelled; a false result becomes BACKPRESSURE_EXCEEDED.
   */
  private admitRequestCapacity(): boolean {
    const limit = this.options.runtime?.requestCacheSize ?? 1024;
    if (this.requests.size >= limit) {
      for (const [id, value] of this.requests) {
        if (!value.settled) continue;
        this.requests.delete(id);
        break;
      }
    }
    return !(this.requests.size >= limit);
  }
  /**
   * dispatchOperation calls only for submission-bearing methods once request-cache capacity is
   * available. Reserve one request ID per submission or throw a conflict/capacity error before native
   * execution. Association alone does not acknowledge dispatch; outcome bookkeeping owns that step.
   */
  private reserveSubmission(params: AhpRequestMap[SubmissionMethod]): void {
    const existing = this.submissions.get(params.submissionId);
    if (existing?.requestId && existing.requestId !== params.requestId) throw new HarnessSdkError('SUBMISSION_ID_CONFLICT');
    this.getOrCreateSubmission(params.submissionId).requestId = params.requestId;
  }
  /**
   * dispatchOperation returns this shared outcome after admission. Cache before native work starts
   * in a microtask, race that work against observation closure, and observe bookkeeping separately.
   * Replays receive the same receipt/rejection without awaiting binding/status events; bookkeeping
   * failures end observation through fail rather than replace the cached outcome.
   */
  private cacheRequestOutcome<M extends SessionMethod>({ method, params, key, fingerprint }: {
    method: M; params: AhpRequestMap[M]; key: string; fingerprint: string;
  }): Promise<AhpResultMap[M]> {
    const requestOutcome = Promise.race([Promise.resolve().then(() => this.executeRequest(method, params)), this.ended.promise]);
    const entry = { fingerprint, result: requestOutcome, settled: false };
    this.requests.set(key, entry);
    // The cached/returned outcome races the backend result against observation closure.
    // It does not wait for binding or status publication; bookkeeping failures go to fail.
    const outcomeBookkeeping = requestOutcome.then(
      /** cacheRequestOutcome registers this on settlement; release cache capacity before success bookkeeping without changing the cached receipt if publication fails. */
      result => {
        entry.settled = true;
        return this.onRequestSucceeded({ method, params, result });
      },
      /** cacheRequestOutcome registers this on rejection; release cache capacity before recovery/status handling while submission reclamation still waits for failure publication. */
      cause => {
        entry.settled = true;
        return this.onRequestFailed({ method, params, cause });
      },
    );
    void outcomeBookkeeping.catch(cause => { void this.fail(cause); });
    return requestOutcome;
  }
  /**
   * cacheRequestOutcome schedules this once per admitted request. Route interaction controls through
   * the registry or await the backend, validate native identity before projecting content, then update
   * request-owned state and return a frozen validated result. Failures reject the cached outcome unless
   * observation closure wins its race; execution and state effects can still finish after that race.
   * The caller owns outcome bookkeeping and never retries native work automatically.
   */
  private async executeRequest<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    const nativeResult = await this.invokeRequest(method, params);
    this.validateNativeResult(method, params, nativeResult);
    let result = this.projectRequestResult(method, nativeResult);
    if (method === 'history/read' && this.options.runtime?.redactHistory) {
      result = await this.options.runtime.redactHistory(this.binding, result as AhpResultMap['history/read']);
    }
    this.applyRequestResult(method, result);
    assertResult(method, result);
    return immutable(result) as AhpResultMap[M];
  }
  /**
   * executeRequest awaits one invocation after request admission. Keep manual interaction responses
   * and cancellations in the registry so they share settlement with automatic handlers; dispatch other
   * methods to the attached backend. Throws/rejections become cached request failures without retries.
   */
  private invokeRequest<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<unknown> {
    if (!this.backend) throw new HarnessSdkError('NOT_INITIALIZED');
    if (method === 'interaction/respond') {
      const value = params as AhpRequestMap['interaction/respond'];
      return this.interactions.respond(value.interactionId, value.requestId, value.response);
    }
    if (method === 'interaction/cancel') {
      const value = params as AhpRequestMap['interaction/cancel'];
      return this.interactions.cancel(value.interactionId, value.reason);
    }
    return this.backend.execute(method, params);
  }
  /**
   * executeRequest projects only after native-result validation. Redact history before the optional
   * host hook, preserve submission/close receipts, and project other method results. Projection failures
   * reject the cached outcome; executeRequest still owns hook invocation and final result validation.
   */
  private projectRequestResult(method: SessionMethod, result: AhpResultMap[SessionMethod]): AhpResultMap[SessionMethod] {
    if (method === 'history/read') return this.secrets.history(result as AhpResultMap['history/read']);
    if (method === 'input/submit' || method === 'review/start' || method === 'session/close') return result;
    return this.secrets.result<SessionMethod>(method, result);
  }
  /**
   * executeRequest commits projected config, revert-reference and goal results before freezing the
   * returned receipt. Cloning failures reject that request; caller cancellation does not roll back
   * these updates. Other methods leave request-owned state unchanged; events own execution activity.
   */
  private applyRequestResult(method: SessionMethod, result: unknown): void {
    if (method === 'session/config/set') { this.state = structuredClone(result as SessionState); this.updateStatus(); }
    if (method === 'session/revert') {
      const nativeRef = (result as AhpResultMap['session/revert']).nativeRef;
      if (nativeRef) this.state.binding = { ...this.binding, nativeRef: structuredClone(nativeRef) };
    }
    if (method === 'goal/set' || method === 'goal/clear') this.state.goal = structuredClone(result as AhpResultMap['goal/set']);
  }
  /**
   * executeRequest calls before privacy projection or request-owned state changes. Validate protocol
   * shape and submission/steer identities; malformed results call rejectNativeResult, which throws an
   * unknown-outcome protocol error and starts observation teardown. On success the assertion narrows
   * the native value for projection.
   */
  private validateNativeResult<M extends SessionMethod>(method: M, params: AhpRequestMap[M], result: unknown): asserts result is AhpResultMap[M] {
    try { assertResult(method, result); }
    catch { this.rejectNativeResult('Invalid native result'); }
    if (isSubmissionMethod(method) && (result as AhpResultMap['input/submit']).submissionId !== (params as AhpRequestMap['input/submit']).submissionId) {
      this.rejectNativeResult('Conflicting submission identity');
    }
    if (method === 'turn/steer' && (result as AhpResultMap['turn/steer']).turnId !== (params as AhpRequestMap['turn/steer']).expectedTurnId) {
      this.rejectNativeResult('Conflicting steer target');
    }
  }
  /**
   * validateNativeResult calls for malformed shape or conflicting identity. Start fail without waiting
   * for cleanup, then throw the same unknown-outcome protocol error into executeRequest's rejection.
   * Native effects cannot be inferred safely, so caller-visible failure must not claim definite rejection.
   */
  private rejectNativeResult(message: string): never {
    const cause = new HarnessSdkError('PROTOCOL_ERROR', message, false, true);
    void this.fail(cause);
    throw cause;
  }
  /**
   * cacheRequestOutcome registers this success continuation separately from its returned receipt.
   * Acknowledge a retained submission, await receipt-based binding before status, and publish accepted/
   * queued/dispatched disposition while observation remains open. A publication failure goes to the
   * cache's fail observer without replacing the receipt; non-submission outcomes need no bookkeeping.
   */
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
  /**
   * cacheRequestOutcome registers this rejection continuation separately from its returned failure.
   * Mark eligible unknown outcomes as requiring recovery, then publish submission failure before
   * acknowledging it with rejectSubmission. Publication failure goes to the cache's fail observer;
   * unknown outcomes remain available for late binding. Definite submission rejection alone leaves
   * unrelated executions usable.
   */
  private async onRequestFailed<M extends SessionMethod>({ method, params, cause }: { method: M; params: AhpRequestMap[M]; cause: unknown }): Promise<void> {
    const error = sdkError(cause);
    if (error.outcomeUnknown && method !== 'history/read' && method !== 'turn/interrupt' && method !== 'session/interrupt') { this.recovering = true; this.updateStatus(); }
    if (!isSubmissionMethod(method)) return;
    const id = (params as AhpRequestMap['input/submit']).submissionId, record = this.submissions.get(id);
    if (record && !this.closed) await this.emit({ type: 'submission/status', payload: { submissionId: id, status: error.outcomeUnknown ? 'unknown' : 'rejected', error: { code: error.code, message: error.code, retryable: error.retryable, outcomeUnknown: error.outcomeUnknown } } });
    if (record) this.rejectSubmission({ record, cause: error, dispatch: 'acknowledged' });
  }
  /**
   * requestInteraction calls only after requested-event publication. Invoke the supplied host handler
   * with a cloned native request and abort signal, then send its answer through InteractionRegistry.
   * Skip aborted invocation/delivery; release capacity only when host work settles, even after native
   * settlement. Handler/delivery failure cancels an actionable interaction; secondary cancellation
   * errors are observed and suppressed. This scheduling does not return a handler wait to the adapter.
   */
  private startInteractionHandler({ request, handler, controller }: { request: InteractionRequested; handler: InteractionHandler; controller: AbortController }): void {
    // Keep handler invocation and answer delivery in separate promise stages; a sentinel
    // distinguishes a skipped invocation without forcing an optional response value.
    const skipped = Symbol('aborted_handler');
    void Promise.resolve().then<InteractionResponse | typeof skipped>(() =>
      controller.signal.aborted ? skipped : handler(structuredClone(request), { signal: controller.signal })
    ).then(async response => {
      if (!controller.signal.aborted && response !== skipped) await this.interactions.respond(request.interactionId, this.createId(), response);
    }).catch(
      /** startInteractionHandler registers this failure continuation; cancel only actionable requests and consume secondary cancellation errors because teardown owns aborted ones. */
      async () => {
        if (!controller.signal.aborted) await this.interactions.cancel(request.interactionId, 'handler_failed').catch(() => {});
      },
    ).finally(
      /** startInteractionHandler registers this finalizer to release capacity after host work settles; native settlement may already have aborted its signal. */
      () => {
        this.handlerCount--;
        this.handlers.delete(request.interactionId);
      },
    );
  }
  /**
   * fail, finishClose and dispose call at their respective teardown stages. Mark closed, reject the
   * closure race and unresolved associations/results, abort handler signals and end unfinished streams.
   * Completed execution snapshots/streams remain intact. Callers own interaction cancellation, backend
   * release and any native close; rejecting observation does not assert execution stopped.
   */
  private endObservation(cause: unknown): void {
    this.observationFailure ??= cause;
    this.closed = true; this.updateStatus(); this.ended.reject(cause);
    for (const value of this.submissions.values()) value.executionBinding.reject(cause);
    for (const execution of this.executions.values()) if (!execution.terminal) { execution.completion.reject(cause); execution.events.end(cause); }
    for (const controller of this.handlers.values()) controller.abort(); this.handlers.clear();
    this.hub.end(cause);
  }
  /**
   * close and request(session/close) return this caller wait around shared close work or, once
   * observation is closed, backend release. Invalid or already-aborted waits reject before either
   * operation starts. Later abort/deadline affects only the caller's wait.
   */
  private closeRequest(params: AhpRequestMap['session/close'], wait: RequestOptions): Promise<AhpResultMap['session/close']> {
    const waitError = requestWaitError(wait);
    if (waitError) return Promise.reject(waitError);
    if (this.closed) return waitForRequest(() => this.closedReceipt(), wait, this.options.runtime?.requestTimeoutMs);
    const closing = this.closing ?? this.startClose(params);
    return waitForRequest(() => closing, wait, this.options.runtime?.requestTimeoutMs);
  }
  /**
   * closeRequest asks for a receipt on an already-closed session. Await backend release and
   * propagate its failure before returning the stored native receipt or an unconfirmed stop.
   */
  private async closedReceipt(): Promise<AhpResultMap['session/close']> {
    await this.disposeBackend();
    return this.closeReceipt ?? { closed: true, observationClosed: true, executionStopped: 'unconfirmed' };
  }
  /**
   * closeRequest starts this once per close attempt. Dispatch before marking the session closing
   * so close itself passes the lifecycle guard. A successful receipt proceeds through finishClose.
   * Dispatch rejection clears the close gate, marks recovery when the outcome is unknown and
   * rejects shared close work with the original cause.
   */
  private startClose(params: AhpRequestMap['session/close']): Promise<AhpResultMap['session/close']> {
    const native = this.dispatchOperation('session/close', params);
    this.closing = native.then(
      result => this.finishClose(result),
      cause => {
        this.closing = undefined;
        if (sdkError(cause).outcomeUnknown) this.recovering = true;
        this.updateStatus();
        throw cause;
      },
    );
    void this.closing.catch(() => {});
    this.updateStatus();
    return this.closing;
  }
  /**
   * startClose registers this on native success and shares its result or cleanup rejection with host
   * waiters. Store the receipt, attempt interaction cancellation then backend release in order, and end
   * observation even if cleanup failed. Throw a safe combined error only after both attempts; native stop
   * confirmation changes unfinished-observation diagnostics without inventing terminal Turn results.
   */
  private async finishClose(result: AhpResultMap['session/close']): Promise<AhpResultMap['session/close']> {
    this.closeReceipt = result;
    const causes: unknown[] = [];
    try { await this.interactions.cancelAll('session_closed'); } catch (cause) { causes.push(cause); }
    try { await this.disposeBackend(); } catch (cause) { causes.push(cause); }
    this.endObservation(observationClosed({ executionStopped: result.executionStopped }));
    if (causes.length) throw combined(causes);
    return result;
  }
  /**
   * fail, closedReceipt, finishClose and dispose share the backend's returned release promise and its
   * rejection; never infer native stop. A synchronous disposal throw escapes before promise caching.
   * Before attachment the no-op promise does not own a backend arriving later: attach rejects/releases
   * that backend when observation has already closed.
   */
  private disposeBackend(): Promise<void> { return this.backendDisposal ??= this.backend?.dispose() ?? Promise.resolve(); }
}

/**
 * request, submitExecution and closeRequest reject with this failure before starting their waits.
 * An invalid explicit timeout takes precedence over an already-aborted signal.
 */
function requestWaitError(wait: RequestOptions): HarnessSdkError | undefined {
  if (invalidWait(wait)) return new HarnessSdkError('INVALID_PARAMS');
  if (wait.signal?.aborted) return new HarnessSdkError('REQUEST_ABORTED');
  return undefined;
}

/** Options supplied by submit and review before submitExecution assigns request and submission IDs. */
type ExecutionSubmission = {
  [M in 'input/submit' | 'review/start']: {
    method: M;
    options: Omit<AhpRequestMap[M], 'sessionId' | 'requestId' | 'submissionId'>;
  };
}['input/submit' | 'review/start'];

/** Submission-bearing dispatch methods sharing reservation, native identity checks and outcome bookkeeping. */
type SubmissionMethod = 'input/submit' | 'review/start' | 'turn/steer';

/**
 * dispatchOperation uses this guard to reserve submission identity; validateNativeResult and the
 * success/failure continuations use the same set to check and acknowledge outcomes. Return whether
 * a method carries submission identity without changing session state or dispatching work.
 */
function isSubmissionMethod(method: SessionMethod): method is SubmissionMethod {
  return method === 'input/submit' || method === 'review/start' || method === 'turn/steer';
}

/**
 * attach checks backend/snapshot bindings here; admitEvent checks native session/state before
 * adoption. Compare session, adapter and configuration identity, allowing nativeRef to change on
 * resume/revert. False makes the caller reject mismatched state; this predicate performs no cleanup.
 */
function matchesBinding(candidate: SessionBinding, expected: SessionBinding): boolean {
  return candidate.sessionId === expected.sessionId && candidate.adapterId === expected.adapterId && candidate.runtimeConfigId === expected.runtimeConfigId;
}

/**
 * validateEvent compares this payload identity with scope.itemId before admission;
 * admitItemEvent uses it for execution-local item ordering. Return the identity shared by item
 * snapshots/deltas, or undefined for other payloads; callers retain shape and lifecycle validation.
 */
function payloadItemId(event: AhpEventPayload): string | undefined {
  if (event.type === 'item/delta') return event.payload.itemId;
  if (event.type === 'item/started' || event.type === 'item/completed') return event.payload.item.id;
  return undefined;
}

/** Host callback admitted by requestInteraction and invoked by startInteractionHandler; manual registrations never enter this port. */
type InteractionHandler = (request: InteractionRequested, context: { signal: AbortSignal }) => Promise<InteractionResponse>;

/** cacheRequestOutcome's replay entry; host cancellation and queued status/binding publication do not own its lifetime. */
interface RequestRecord {
  /** Serialized detached params used to reject conflicting replays of the same method/request ID. */
  fingerprint: string;
  /** Dispatch outcome raced against observation closure, without waiting for status publication. */
  result: Promise<unknown>;
  /** Only settled outcomes may be reclaimed to admit a new request. */
  settled: boolean;
}

/** getOrCreateSubmission allocates association separately from dispatch acknowledgement so retention can protect late native bindings. */
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
/** context's shared execution state; Turn observes it while retainEvent/endObservation own completion and stream settlement. */
interface Execution extends ExecutionObservation {
  /** Retains only public projected content for terminal snapshots and shared byte accounting. */
  accumulator: ResultAccumulator;
  /** Settled by retainEvent on native completion, or rejected by endObservation. */
  completion: ReturnType<typeof deferred<TurnResult>>;
  /** Restored at attachment or admitted by the first native start event. */
  started: boolean;
  /** Set during terminal retention, before the execution's event hub ends. */
  terminal: boolean;
  /** Execution-local ordering markers; native item IDs may be reused by other executions. */
  items: Map<string, 'started' | 'completed'>;
  /** Native terminal publication sequence used to protect possible late associations. */
  terminalSeq?: number;
}
