// Owns per-session output admission, execution association, publication and revocation.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap, type Capabilities, type HarnessError, type Item, type JsonSchema, type SessionOpenParams, type SessionState } from '@anureo/protocol'
import { HarnessSdkError, sdkError } from '../errors'
import { guardRequest } from '../requests/guard'
import type { BackendSession, EventScope, HarnessAdapter, SessionEventSink, SessionMethod, StructuredOutputToolResult } from '../ports'
import type { OutputBridgeManager, OutputBridgeLease } from './bridge'
import { OUTPUT_SERVER_NAME, toolError } from './tool'
import { compileOutputSchema } from './schema'
import type { OutputLimits } from './limits'
import { checkRelease, failure } from './errors'

/**
 * Internal BackendSession implementation constructed and tracked by withStructuredOutput's
 * openSession port. Client.attachSession gives this wrapper to Session, which reads attachment state,
 * dispatches through execute and releases it through disposeBackend. Owns one native session's output
 * associations, fallback lane and serialized commitment. Hosts observe receipts independently of
 * final events, and caller wait cancellation leaves native work and lane ownership alive.
 */
export class OutputSession implements BackendSession {
  /**
   * withStructuredOutput's openSession port constructs this wrapper before tracking and opening it.
   * Capture dependencies without I/O. The wrapper must await open before attachment and dispose on
   * setup failure. dispose invokes forget after release attempts so adapter ownership can be removed.
   */
  constructor(input: { params: SessionOpenParams; sink: SessionEventSink; manager: OutputBridgeManager; limits: OutputLimits; forget: () => void }) {
    this.params = input.params
    this.sink = input.sink
    this.manager = input.manager
    this.limits = input.limits
    this.forget = input.forget
  }
  /** Session.attach reads the native binding after open. validateEnvelope uses the requested identity until the native backend is available. */
  get binding() { return this.backend?.binding ?? this.params.binding }
  /** Session.attach adopts this capability projection. The native tool or MCP lease can supply schema support without mutating backend capabilities. */
  get capabilities(): Capabilities { return this.projectCapabilities(this.backend?.capabilities ?? {}) }
  /** Session.attach restores this optional projected native state. Return a credential-redacted snapshot with the fallback capability revision applied. */
  get state(): SessionState | undefined { return this.backend?.state ? this.redact(this.projectState(this.backend.state)) : undefined }
  /**
   * withStructuredOutput's openSession port awaits this before Client.attachSession receives the
   * wrapper. Prepare an optional bridge before native open, then adopt the backend and its active
   * turns. A reserved bridge name, lease cleanup failure or warning publication failure rejects
   * setup. Other bridge preparation failures warn and continue. If disposal wins the open race,
   * await native release and reject with its failure or SESSION_CLOSED.
   * nativeOutput is the initialization negotiation result, used only to decide bridge preparation;
   * per-session capabilities decide submission mode. Native-open and release failures reject to the
   * adapter wrapper, which owns setup cleanup.
   */
  async open({ adapter, nativeOutput }: { adapter: HarnessAdapter; nativeOutput: boolean }): Promise<this> {
    // The optional port is an execution-location attestation, not a provider-name heuristic.
    const transport = nativeOutput ? undefined : adapter.outputBridgeTransport?.(this.params)
    // Avoid a promise turn before native dispatch when no bridge needs preparation.
    const params = transport ? await this.prepareBridge(transport) : this.params
    const backend = await adapter.openSession(structuredClone(params), this.nativeSink())
    this.backend = backend
    if (this.disposed) { await backend.dispose(); throw new HarnessSdkError('SESSION_CLOSED') }
    backend.state?.activeTurnIds.forEach(id => this.active.add(id))
    return this
  }
  /**
   * Session.invokeRequest invokes this BackendSession port; Session.executeRequest validates and
   * projects its result. Prepare output policy, check the transformed request against native
   * capabilities, and dispatch once. Bind any receipt turn before returning. A native close
   * receipt revokes output admission before the wrapper returns to Session. Failures
   * reclaim only definitely rejected, unbound submissions and preserve safe cleanup diagnostics.
   * Session owns request replay, caller wait cancellation and native-result validation. These waits
   * never release a live output lane.
   */
  async execute<M extends SessionMethod>(method: M, original: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.disposed || !this.backend) throw new HarnessSdkError('SESSION_CLOSED')
    const params = structuredClone(original)
    if (this.locked && ['input/submit', 'review/start', 'compact/start', 'session/config/set', 'session/revert'].includes(method)) throw new HarnessSdkError('STRUCTURED_OUTPUT_BUSY')
    let submissionId: string | undefined
    try {
      submissionId = requestSubmissionId(method, params)
      const prepared = await this.prepareSubmission(method, params, submissionId)
      const result = await this.dispatch(method, prepared, this.backend)
      if (submissionId && result && typeof result === 'object' && 'turnId' in result && typeof result.turnId === 'string') {
        const boundSubmissionId = submissionId
        await this.enqueue(() => this.bind(boundSubmissionId, result.turnId as string))
      }
      if (method === 'session/config/set') return this.redact(this.projectState(result as SessionState)) as AhpResultMap[M]
      if (method === 'history/read') return this.redact(result)
      if (method === 'session/close') await this.release()
      return result
    } catch (cause) { return this.rejectDispatch(cause, submissionId) }
  }
  /**
   * withStructuredOutput's setup-failure/dispose paths and Session.disposeBackend await this shared
   * cleanup promise. Close admission immediately, release output resources, then attempt backend
   * disposal even after release rejection. Remove adapter ownership after both stages and propagate
   * classified cleanup failures. open separately releases a backend that arrives after this teardown.
   */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true
      const results = await Promise.allSettled([this.release()])
      results.push(...await Promise.allSettled([this.backend?.dispose()]))
      this.forget()
      checkRelease(results)
    })()
  }
  private backend?: BackendSession
  private lease?: OutputBridgeLease
  private disposed = false
  private disposal?: Promise<void>
  private chain = Promise.resolve()
  private queuedBytes = 0
  private queuedEvents = 0
  private heldBytes = 0
  private heldCount = 0
  private outputBytes = 0
  private readonly pending = new Map<string, Envelope[]>()
  private readonly outputs = new Map<string, Output>()
  private readonly byTurn = new Map<string, Output>()
  private readonly unresolved = new Set<string>()
  private readonly active = new Set<string>()
  private readonly terminalVersions = new Map<string, number>()
  private terminalVersion = 0
  private locked?: Output
  private readonly privateStrings = new Set<string>()
  private readonly params: SessionOpenParams
  private readonly sink: SessionEventSink
  private readonly manager: OutputBridgeManager
  private readonly limits: OutputLimits
  private readonly forget: () => void

  /**
   * execute calls this after preparing the request. Validate its frame size, protocol shape and
   * native binding and capabilities before dispatch. Return the native promise directly so the close
   * continuation can revoke output admission as soon as its receipt arrives.
   */
  private dispatch<M extends SessionMethod>(method: M, params: AhpRequestMap[M], backend: BackendSession): Promise<AhpResultMap[M]> {
    if (Buffer.byteLength(JSON.stringify(params)) > (this.limits.queue?.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('FRAME_TOO_LARGE')
    guardRequest(method, params, this.binding.sessionId, backend.capabilities)
    return backend.execute(method, params)
  }

  /**
   * open awaits this only for an attested MCP transport. Retain a lease and its private credentials
   * before returning augmented native-open params. A reserved name rejects before allocation; other
   * setup failures release any lease and publish a warning before returning the original params.
   * Cleanup or warning-publication failures reject open, whose adapter caller owns session disposal.
   */
  private async prepareBridge(transport: 'http' | 'stdio'): Promise<SessionOpenParams> {
    if (this.params.mcpServers?.some(server => server.name === OUTPUT_SERVER_NAME)) throw new HarnessSdkError('INVALID_PARAMS', 'Reserved MCP server name')
    try {
      this.lease = await this.manager.create(transport, args => this.enqueue(async () => this.submitValue(args)))
      const config = this.lease.config
      if (config.type === 'http') {
        this.privateStrings.add(config.url)
        Object.values(config.headers ?? {}).forEach(value => this.privateStrings.add(value))
      } else Object.values(config.env ?? {}).forEach(value => this.privateStrings.add(value))
      return { ...this.params, mcpServers: [...(this.params.mcpServers ?? []), config] }
    } catch {
      await this.lease?.dispose()
      this.lease = undefined
      await this.sink.emit({ type: 'notice', payload: { severity: 'warning', code: 'STRUCTURED_OUTPUT_BRIDGE_UNAVAILABLE', message: 'Structured output bridge could not be prepared' } })
      return this.params
    }
  }
  /**
   * open supplies these callbacks to the native adapter, which may invoke them before attachment.
   * Route events and bindings through serialized output policy. Session handles interactions and
   * direct failure reports. tryEmit returns false when admission throws and forwards both immediate
   * and asynchronous failures to Session.fail.
   */
  private nativeSink(): SessionEventSink {
    return {
      bindSubmission: (submissionId, turnId) => this.emit({ type: 'submission/bound', payload: { submissionId, turnId } }),
      emit: (event, scope = {}) => this.emit(event, scope),
      tryEmit: (event, scope = {}) => {
        try { const operation = this.emit(event, scope); void operation.catch(cause => this.sink.fail(cause)); return true }
        catch (cause) { void this.sink.fail(cause); return false }
      },
      requestInteraction: (request, responder) => this.sink.requestInteraction(request, responder),
      resolveInteraction: result => this.sink.resolveInteraction(result),
      fail: cause => this.sink.fail(cause),
    }
  }
  /**
   * execute returns this rejection after preparation, dispatch or result projection fails. Reclaim
   * only definite submission failures; reject leaves already-bound work alive until its terminal.
   * Preserve the original cause unless cleanup fails, then attach safe cleanup diagnostics without
   * replacing the dispatch error code or outcome. Unknown acceptance retains its output lane.
   */
  private async rejectDispatch(cause: unknown, submissionId: string | undefined): Promise<never> {
    if (submissionId && !sdkError(cause).outcomeUnknown) {
      try { await this.reject(submissionId) } catch (cleanup) {
        const error = sdkError(cause), release = sdkError(cleanup, 'RESOURCE_RELEASE_FAILED', true)
        throw new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown,
          { ...error.details, cleanupErrors: [{ code: release.code, outcomeUnknown: release.outcomeUnknown }] })
      }
    }
    throw cause
  }
  /**
   * The capabilities getter and projectState return this projection to Session attachment
   * and state observers. Prefer the native tool extension over the MCP extension when both exist,
   * retaining native schema support and suppressing fallback advertisement after disposal.
   */
  private projectCapabilities(raw: Capabilities): Capabilities {
    const extension = this.backend?.structuredOutputTool ? { name: 'x-anureo/structured-output-tool', version: '1' } : this.lease ? EXTENSION : undefined
    if (raw.turn?.outputSchema || !extension || this.disposed) return structuredClone(raw)
    return { ...structuredClone(raw), turn: { ...raw.turn, outputSchema: true }, extensions: [...(raw.extensions ?? []).filter(value => value.name !== extension.name), extension] }
  }
  /**
   * The state getter, routeEarlyEvent and execute call this before exposing native state to
   * Session. Return a new state with projected capabilities and the fallback revision offset so
   * observers can distinguish synthetic support. Other state fields remain shared until redaction.
   */
  private projectState(state: SessionState): SessionState {
    return { ...state, capabilities: this.projectCapabilities(state.capabilities), capabilityRevision: state.capabilityRevision + (this.lease || this.backend?.structuredOutputTool ? 1 : 0) }
  }
  /**
   * emit queues acceptance here, prepareBridge and prepareOutput register callbacks that queue
   * candidates here, and execute queues receipt binding. Run work after earlier queued work,
   * returning its result/rejection while preserving the chain for later operations. Callers still own
   * failure publication and cleanup.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(work)
    this.chain = operation.then(() => {}, () => {})
    return operation
  }
  /**
   * nativeSink's emit, tryEmit and bindSubmission callbacks invoke this for native events.
   * Reserve queue capacity and clone the envelope before serialized accept. Serialization, cloning
   * and capacity failures throw synchronously. Processing failures await Session.fail before rejecting,
   * and settlement releases queue counters. Adapters await the returned promise for publication order.
   */
  private emit(event: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (
      bytes > (this.limits.queue?.maxFrameBytes ?? 8 * 1024 * 1024)
      || this.queuedBytes + this.heldBytes + bytes > (this.limits.queue?.maxBytes ?? 16 * 1024 * 1024)
      || this.queuedEvents + this.heldCount >= (this.limits.queue?.maxEvents ?? 2048)
    ) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    const copy = structuredClone({ event, scope })
    this.queuedBytes += bytes
    this.queuedEvents++
    const operation = this.enqueue(() => this.accept(copy))
    return operation.catch(async cause => {
      await this.sink.fail(cause)
      throw cause
    }).finally(() => {
      this.queuedBytes -= bytes
      this.queuedEvents--
    })
  }
  /**
   * routeEarlyEvent awaits this after publishing submission/bound, while execute queues it
   * for a receipt containing turnId. Associate the output and replay held events in order before the
   * caller advances. Conflicting/earlier-execution bindings throw PROTOCOL_ERROR. Replay failures
   * reject to emit or execute, whose failure paths still own observation teardown and cleanup.
   */
  private async bind(submissionId: string, turnId: string): Promise<void> {
    this.unresolved.delete(submissionId)
    const output = this.outputs.get(submissionId)
    if (output && this.associateOutput(output, turnId) === 'already-ended') return
    // Receipt-only backends can bind after emitting all their execution events.
    const held = this.pending.get(turnId)
    if (!held) return
    this.pending.delete(turnId)
    for (const envelope of held) {
      this.heldCount--
      this.heldBytes -= Buffer.byteLength(JSON.stringify(envelope.event))
      await this.accept(envelope)
    }
  }
  /**
   * bind uses this decision before replaying held events. A late binding from an input admitted
   * before the terminal can share that ended execution and is reclaimed immediately. Binding a
   * newer input to an ended execution or changing an existing binding throws PROTOCOL_ERROR.
   * Record competing schemas on the first output so a native success reports the conflict.
   */
  private associateOutput(output: Output, turnId: string): 'associated' | 'already-ended' {
    if (output.turnId && output.turnId !== turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting structured output binding')
    const endedAt = this.terminalVersions.get(turnId)
    if (endedAt !== undefined) {
      if (output.admittedVersion >= endedAt) throw new HarnessSdkError('PROTOCOL_ERROR', 'Structured submission bound to an earlier execution')
      this.drop(output.submissionId)
      return 'already-ended'
    }
    output.turnId = turnId
    const previous = this.byTurn.get(turnId)
    if (previous && !isDeepStrictEqual(previous.schema.schema, output.schema.schema)) previous.error = failure('STRUCTURED_OUTPUT_BINDING_CONFLICT')
    else this.byTurn.set(turnId, previous ?? output)
    return 'associated'
  }
  /**
   * The state getter, accept, routeEarlyEvent, publishOutput and execute project values
   * here before exposing them to Session. Recursively replace output IDs and retained bridge secrets
   * in string values, preserving object keys and leaving retained source data untouched. Session
   * still owns projection of marked user secrets and any host history policy.
   */
  private redact<T>(value: T): T {
    /** Rebuild JSON-shaped values so bridge redaction leaves retained source data untouched. */
    const visit = (node: unknown): unknown => {
      if (typeof node === 'string') {
        let text = node.replace(/anureo_output_[a-f0-9]{48}/g, '[redacted]')
        for (const secret of this.privateStrings) text = text.replaceAll(secret, '[redacted]')
        return text
      }
      if (Array.isArray(node)) return node.map(visit)
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]))
      return node
    }
    return visit(value) as T
  }
  /**
   * rememberText, projectItemSnapshot, submitCandidate and admitOutput reserve or replace retained
   * data here. Apply a signed byte delta to session/output accounting or throw RESULT_BUDGET_EXCEEDED
   * before mutation. Callers commit the corresponding value only after this succeeds and drop/release
   * later reclaim its accounting.
   */
  private retain(output: Output, bytes: number): void {
    if (this.outputBytes + bytes > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
    this.outputBytes += bytes; output.retainedBytes += bytes
  }
  /**
   * projectItemSnapshot and projectItemDelta store text here for outputValue's terminal assembly.
   * Replace one item's text with signed byte accounting. Distinct-item or byte overflow throws
   * RESULT_BUDGET_EXCEEDED before replacing text, propagating through accept to observation failure.
   */
  private rememberText(output: Output, id: string, text: string): void {
    if (!output.text.has(id) && output.text.size >= (this.limits.maxItems ?? 2048)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
    this.retain(output, Buffer.byteLength(text) - Buffer.byteLength(output.text.get(id) ?? ''))
    output.text.set(id, text)
  }
  /**
   * bind reclaims late terminal associations here, and completeTurn/reject reclaim finished or
   * rejected submissions. Remove the submission and subtract its retained bytes. These callers still
   * own turn associations, unresolved IDs and exclusive-lane release.
   */
  private drop(submissionId: string): void {
    const output = this.outputs.get(submissionId)
    if (output) this.outputBytes -= output.retainedBytes
    this.outputs.delete(submissionId)
  }
  /**
   * emit queues this work and bind replays held envelopes through it. Validate and route an envelope,
   * then project its items and commit a terminal before publishing it to Session. A held or suppressed
   * event resolves without publication. Protocol, budget, cleanup and sink failures reject the caller,
   * while candidate-validation failures become failed terminals through publishOutput.
   */
  private async accept({ event, scope }: Envelope): Promise<void> {
    if (this.disposed) throw new HarnessSdkError('STREAM_CLOSED')
    this.validateEnvelope(event, scope)
    if (await this.routeEarlyEvent(event, scope)) return
    const turnId = this.eventTurnId(event, scope)
    if (this.isLateTerminal(event, turnId)) { await this.sink.emit(this.redact(event), scope); return }
    if (event.type === 'turn/started') this.active.add(event.payload.turnId)
    const output = turnId ? this.byTurn.get(turnId) : undefined
    if (this.holdForBinding(event, scope, turnId, output)) return
    const projected = output ? this.projectItemEvent(event, output) : event
    if (!projected) return
    event = projected
    if (event.type === 'turn/completed') event = await this.completeTurn(event, output, turnId)
    await this.sink.emit(this.redact(event), scope)
  }
  /**
   * accept calls this before routing or retaining an envelope. Assert its protocol shape using the
   * current binding and validation-only stream metadata. Assertion failures reject acceptance before
   * association state changes, including for envelopes that would otherwise be held.
   */
  private validateEnvelope(event: AhpEventPayload, scope: EventScope): void {
    assertEvent({ ...scope, sessionId: this.binding.sessionId, streamId: 'output-validation', seq: 1, timestamp: new Date().toISOString(), ...event })
  }
  /**
   * accept awaits this before execution projection. Publish binding before replaying held events,
   * reclaim definite rejections, and publish projected session state. Return true only when publication
   * is complete here. Binding, cleanup or sink failures reject accept. Rejected-status events continue
   * through accept for their normal publication after reclamation.
   */
  private async routeEarlyEvent(event: AhpEventPayload, scope: EventScope): Promise<boolean> {
    if (event.type === 'submission/bound') {
      await this.sink.emit(event, scope)
      await this.bind(event.payload.submissionId, event.payload.turnId)
      return true
    }
    if (event.type === 'submission/status' && event.payload.status === 'rejected') await this.reject(event.payload.submissionId)
    if (event.type === 'session/state') {
      await this.sink.emit(this.redact({ ...event, payload: this.projectState(event.payload) }), scope)
      return true
    }
    return false
  }
  /**
   * accept uses this pure lookup for output association, buffering and terminal projection. Prefer
   * scope.turnId, then lifecycle payload identity, returning undefined for unscoped non-lifecycle events.
   */
  private eventTurnId(event: AhpEventPayload, scope: EventScope): string | undefined {
    return scope.turnId ?? (event.type === 'turn/started' || event.type === 'turn/completed' ? event.payload.turnId : undefined)
  }
  /**
   * accept uses this predicate to forward lifecycle events for already-terminal turns directly to
   * Session. Return whether the event bypasses output bookkeeping so duplicate starts/completions
   * cannot reopen completed output state. Session still validates its own lifecycle observations.
   */
  private isLateTerminal(event: AhpEventPayload, turnId: string | undefined): boolean {
    return Boolean(turnId && this.terminalVersions.has(turnId) && (event.type === 'turn/started' || event.type === 'turn/completed'))
  }
  /**
   * accept returns early when this retains an item/terminal envelope for a possible late binding.
   * Reserve held counters and preserve per-turn order while any output is unbound. bind later replays
   * these envelopes and releases counters. emit already checked combined queued/held capacity.
   */
  private holdForBinding(event: AhpEventPayload, scope: EventScope, turnId: string | undefined, output: Output | undefined): boolean {
    const needsBinding = !output && [...this.outputs.values()].some(value => !value.turnId)
    if (turnId && needsBinding && (event.type.startsWith('item/') || event.type === 'turn/completed')) {
      const held = this.pending.get(turnId) ?? []
      held.push({ event, scope })
      this.pending.set(turnId, held)
      this.heldCount++
      this.heldBytes += Buffer.byteLength(JSON.stringify(event))
      return true
    }
    return false
  }
  /**
   * accept routes output-associated events through this projection before publication. Retain
   * snapshots/deltas under the output budget and return other events unchanged. undefined means
   * a native final was withheld until terminal validation. Retention failures reject accept.
   */
  private projectItemEvent(event: AhpEventPayload, output: Output): AhpEventPayload | undefined {
    if (event.type === 'item/started' || event.type === 'item/completed') return this.projectItemSnapshot(event, output)
    if (event.type === 'item/delta') return this.projectItemDelta(event, output)
    return event
  }
  /**
   * projectItemEvent retains message snapshots and downgrades visible messages to commentary.
   * Withhold completed native finals until terminal validation so accepted output can preserve the
   * identity used by authoritative history. Budget failures throw before publication to accept.
   */
  private projectItemSnapshot(event: Extract<AhpEventPayload, { type: 'item/started' | 'item/completed' }>, output: Output): AhpEventPayload | undefined {
    const item = event.payload.item
    if (item.type !== 'agentMessage') return event
    this.rememberText(output, item.id, item.text)
    if (item.phase === 'final') output.finalIds.add(item.id)
    if (output.mode === 'native' && event.type === 'item/completed' && item.phase === 'final') {
      const previous = output.finalItems.get(item.id)
      this.retain(output, Buffer.byteLength(JSON.stringify(item)) - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0))
      output.finalItems.set(item.id, item)
      return undefined
    }
    return { ...event, payload: { item: { ...item, phase: 'commentary' } } }
  }
  /**
   * projectItemEvent assembles streamed text and agent-message patches here for terminal parsing.
   * Preserve final identities but expose patches as commentary until commitment. Budget failures
   * throw through accept; unrelated deltas pass through unchanged.
   */
  private projectItemDelta(event: Extract<AhpEventPayload, { type: 'item/delta' }>, output: Output): AhpEventPayload {
    if (event.payload.kind === 'text' && event.payload.text !== undefined) {
      const text = (output.text.get(event.payload.itemId) ?? '') + event.payload.text
      if (Buffer.byteLength(text) > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
      this.rememberText(output, event.payload.itemId, text)
    }
    const value = event.payload.value
    if (event.payload.kind === 'patch' && value && typeof value === 'object' && !Array.isArray(value) && value.type === 'agentMessage') {
      this.rememberText(output, event.payload.itemId, String(value.text ?? ''))
      if (value.phase === 'final') output.finalIds.add(event.payload.itemId)
      return { ...event, payload: { ...event.payload, value: { ...value, phase: 'commentary' } } }
    }
    return event
  }
  /**
   * accept awaits this for a real turn/completed event and then publishes the returned terminal.
   * Close candidate admission, disable the direct tool, publish accepted output or withheld commentary,
   * then reclaim associations and release the fallback lane. Validation can replace success with a
   * failed terminal. Tool/sink failures reject before remaining cleanup, leaving disposal to reclaim
   * resources. Host result timeouts never enter this terminal path.
   */
  private async completeTurn(event: Extract<AhpEventPayload, { type: 'turn/completed' }>, output: Output | undefined, turnId: string | undefined): Promise<AhpEventPayload> {
    if (output) {
      output.finished = true
      if (output.mode === 'tool') await this.backend!.structuredOutputTool!.configure()
    }
    if (output && event.payload.status === 'completed') event = await this.publishOutput(event, output, turnId)
    if (output && event.payload.status !== 'completed') await this.publishCommentaryFinals(output, turnId)
    this.recordTerminal({ terminalTurnId: event.payload.turnId, associatedTurnId: turnId, output })
    return event
  }
  /**
   * completeTurn records the native terminal after tool cleanup and item publication succeed.
   * Bound the terminal markers used by late binding and reclaim the associated submissions and lane.
   * Use the payload ID for active, terminal and turn-index records. Match retained candidates and
   * the lane using the envelope's resolved association ID.
   */
  private recordTerminal({ terminalTurnId, associatedTurnId, output }: {
    terminalTurnId: string; associatedTurnId: string | undefined; output: Output | undefined
  }): void {
    this.active.delete(terminalTurnId)
    this.terminalVersions.set(terminalTurnId, ++this.terminalVersion)
    if (this.terminalVersions.size > (this.limits.maxSubmissions ?? 1024)) {
      const oldest = this.terminalVersions.keys().next()
      if (!oldest.done) this.terminalVersions.delete(oldest.value)
    }
    if (!output) return
    for (const [id, value] of this.outputs) if (value.turnId === associatedTurnId) this.drop(id)
    this.byTurn.delete(terminalTurnId)
    if (this.locked?.turnId === associatedTurnId) this.locked = undefined
  }
  /**
   * completeTurn awaits this only for native success with output state. Convert validation failures
   * into a failed terminal, or publish commentary followed by one accepted final before returning
   * success. Reuse the sole completed native final's identity when available. Sink publication failures
   * reject completeTurn directly, preserving their infrastructure-failure semantics.
   */
  private async publishOutput(event: Extract<AhpEventPayload, { type: 'turn/completed' }>, output: Output, turnId: string | undefined): Promise<Extract<AhpEventPayload, { type: 'turn/completed' }>> {
    let text: string | undefined
    try {
      if (output.error) throw new HarnessSdkError(output.error.code)
      const value = this.outputValue(output)
      output.schema.check(value)
      const json = JSON.stringify(value)
      text = this.sink.projectOutput?.(this.redact(json)) ?? this.redact(json)
      try { output.schema.parse(text) } catch { throw new HarnessSdkError('STRUCTURED_OUTPUT_REDACTED') }
    } catch (cause) {
      const error = sdkError(cause, 'STRUCTURED_OUTPUT_INVALID')
      return { ...event, payload: { ...event.payload, status: 'failed', error: failure(error.code, error.details) } }
    }
    if (text !== undefined) {
      const original = output.mode === 'native' && output.finalItems.size === 1 ? [...output.finalItems.values()][0] : undefined
      // Skip an await when there is no commentary to publish before the final.
      for (const item of output.finalItems.values()) {
        if (item.id !== original?.id) await this.emitCommentaryFinal(item, turnId)
      }
      const item: Item = { ...(original ?? { id: `anureo-result:${randomBytes(24).toString('hex')}`, type: 'agentMessage' }), phase: 'final', text, status: 'completed' }
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId })
    }
    return event
  }
  /**
   * publishOutput obtains its candidate here before final schema/privacy checks. Parse the
   * joined native final texts, or return the first retained tool/MCP value. Missing values throw
   * STRUCTURED_OUTPUT_MISSING or STRUCTURED_OUTPUT_INVALID according to prior schema attempts.
   */
  private outputValue(output: Output): unknown {
    if (output.mode === 'native') return output.schema.parse([...output.finalIds].map(id => output.text.get(id) ?? '').join('\n'))
    if (output.hasValue) return output.value
    throw new HarnessSdkError(output.attempts ? 'STRUCTURED_OUTPUT_INVALID' : 'STRUCTURED_OUTPUT_MISSING')
  }
  /**
   * completeTurn awaits this for non-success terminals, including failures from final validation.
   * Emit retained native items as commentary in insertion order. Publication failures reject before
   * completeTurn records the terminal and reclaims its associations.
   */
  private async publishCommentaryFinals(output: Output, turnId: string | undefined): Promise<void> {
    for (const item of output.finalItems.values()) await this.emitCommentaryFinal(item, turnId)
  }
  /**
   * publishOutput and publishCommentaryFinals await Session.emit directly. Preserve the native
   * item identity while emitting commentary, and let publication failure halt the terminal path.
   */
  private emitCommentaryFinal(item: Extract<Item, { type: 'agentMessage' }>, turnId: string | undefined): Promise<void> {
    return this.sink.emit({ type: 'item/completed', payload: { item: { ...item, phase: 'commentary' } } }, { turnId })
  }
  /**
   * prepareBridge registers a queued handler with OutputBridgeManager.create. The manager's MCP
   * CallTool handler awaits this result. Check the active MCP output, envelope and exact outputId
   * before submitCandidate, returning an MCP acceptance or safe retry guidance. Envelope/ID failures
   * consume no schema attempts. Infrastructure failures reject the registered MCP handler.
   */
  private submitValue(args: unknown) {
    const output = this.locked
    if (this.disposed || !output || output.mode !== 'mcp' || output.finished) return toolError('STRUCTURED_OUTPUT_EXPIRED')
    const invalidArguments = () => toolError('STRUCTURED_OUTPUT_INVALID_ARGUMENTS', undefined,
      'Pass exactly two top-level arguments: outputId (a nonempty string copied exactly from the current task output contract) and value (the final JSON result). Do not nest the argument envelope inside value. Correct the arguments and call this tool again within this execution.')
    if (!args || typeof args !== 'object' || Array.isArray(args)) return invalidArguments()
    const value = args as Record<string, unknown>
    if (typeof value.outputId !== 'string' || !value.outputId || !Object.hasOwn(value, 'value') || Object.keys(value).some(key => key !== 'outputId' && key !== 'value')) return invalidArguments()
    if (output.outputId !== value.outputId) return toolError('STRUCTURED_OUTPUT_ID_MISMATCH', undefined,
      'The supplied outputId does not match the current task. This does not mean the task has expired. Copy outputId exactly from the current task output contract, preserving every character, and call this tool again within this execution. Do not reuse an ID from another task.')
    const result = this.submitCandidate(output, value.value)
    return result.accepted ? { content: [{ type: 'text' as const, text: '{"accepted":true}' }] } : toolError(result.error.code, result.error.details?.issues)
  }
  /**
   * submitValue formats this decision for MCP. prepareOutput supplies the native tool port with a
   * queued callback capturing the exact Output. Pi's createOutputTool awaits it and translates
   * acceptance into a termination request or returns an error for correction. A structurally equal
   * retry is accepted without storing a second value. The third schema mismatch before acceptance
   * exhausts retries. Return policy failures as decisions, while clone failure rejects the callback.
   * Acceptance remains provisional until publishOutput revalidates the projected result.
   */
  private submitCandidate(output: Output, value: unknown): StructuredOutputToolResult {
    const rejected = (code: string, details?: Record<string, unknown>): StructuredOutputToolResult => ({ accepted: false, error: failure(code, details) })
    if (this.disposed || output.finished || this.locked !== output) return rejected('STRUCTURED_OUTPUT_EXPIRED')
    if (output.error) return { accepted: false, error: output.error }
    if (output.hasValue) return isDeepStrictEqual(output.value, value) ? { accepted: true } : rejected('STRUCTURED_OUTPUT_ALREADY_SUBMITTED')
    let bytes: number
    try { bytes = Buffer.byteLength(JSON.stringify(value)) } catch { return rejected('STRUCTURED_OUTPUT_INVALID') }
    if (bytes > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) return this.rejectCandidateBudget(output)
    try { output.schema.check(value) } catch (cause) {
      if (++output.attempts >= 3) output.error = failure('STRUCTURED_OUTPUT_RETRIES_EXCEEDED')
      return rejected(output.error?.code ?? 'STRUCTURED_OUTPUT_INVALID', sdkError(cause).details)
    }
    try { this.retain(output, bytes) } catch { return this.rejectCandidateBudget(output) }
    output.value = structuredClone(value)
    output.hasValue = true
    return { accepted: true }
  }
  /** submitCandidate reports either byte-budget failure immediately and retains it for later calls and terminal validation. */
  private rejectCandidateBudget(output: Output): StructuredOutputToolResult {
    output.error = failure('RESULT_BUDGET_EXCEEDED')
    return { accepted: false, error: output.error }
  }
  /**
   * routeEarlyEvent calls this for rejected status, and rejectDispatch calls after a definite request
   * failure. Remove unresolved admission, then finish/reclaim an unbound output and release its lane.
   * Bound execution remains owned until its terminal. Tool-disable failures reject before reclamation,
   * allowing the caller to report cleanup failure and later disposal to attempt release.
   */
  private async reject(submissionId: string): Promise<void> {
    this.unresolved.delete(submissionId)
    const output = this.outputs.get(submissionId)
    if (output?.turnId) return // A rejection cannot undo an execution already observed.
    if (output) output.finished = true
    if (output?.mode === 'tool') await this.backend!.structuredOutputTool!.configure()
    this.drop(submissionId)
    if (this.locked === output) this.locked = undefined
  }
  /**
   * execute awaits this after checking backend attachment and before native frame/capability checks.
   * Transform schema-bearing input and record the captured input/review ID as unresolved only
   * after preparation succeeds. Return params for native validation and dispatch. Setup
   * failures reject execute, which still knows the original submission ID for definite-failure cleanup.
   */
  private async prepareSubmission<M extends SessionMethod>(method: M, params: AhpRequestMap[M], submissionId: string | undefined): Promise<AhpRequestMap[M]> {
    if (method === 'input/submit') {
      const input = params as AhpRequestMap['input/submit']
      if (input.outputSchema !== undefined) params = await this.prepareOutput(input, input.outputSchema) as AhpRequestMap[M]
    }
    if (submissionId !== undefined) this.unresolved.add(submissionId)
    return params
  }
  /**
   * prepareSubmission awaits this for schema-bearing input using the attached backend. Compile the
   * schema, enforce mode-specific admission and reserve retention, then return native params or
   * configure the locked fallback before returning transformed input. The native tool callback is registered here
   * and captures this exact Output. Capacity, schema, exclusivity and registration failures reject to
   * execute's recovery path, which reclaims definite failures. Dispatch and result observation remain
   * with execute and Session.
   */
  private async prepareOutput(input: AhpRequestMap['input/submit'], schemaSource: JsonSchema): Promise<AhpRequestMap['input/submit']> {
    if (this.outputs.size >= (this.limits.maxSubmissions ?? 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    const schema = compileOutputSchema(schemaSource)
    const output = this.admitOutput(input.submissionId, schema)
    if (output.mode === 'native') return input
    this.locked = output
    const prepared = fallbackInput(input, output)
    if (output.mode === 'tool') await this.backend!.structuredOutputTool!.configure({
      name: 'anureo_submit_result',
      description: 'Submit the final result for the current task. Correct validation errors and retry. Acceptance ends this execution.',
      schema: structuredClone(schema.schema),
      execute: value => this.enqueue(async () => this.submitCandidate(output, value)),
    })
    return prepared
  }
  /**
   * prepareOutput calls this after capacity checking and schema compilation, before fallback setup.
   * Prefer native schemas, then a direct tool, then MCP; reject unavailable or conflicting lanes
   * before reserving schema bytes and storing the submission. execute has established backend
   * attachment. Its definite-failure path owns reclaiming state if later setup or dispatch rejects.
   */
  private admitOutput(submissionId: string, schema: PreparedSchema): Output {
    const backend = this.backend!
    const mode = backend.capabilities.turn?.outputSchema ? 'native' : backend.structuredOutputTool ? 'tool' : 'mcp'
    if (mode === 'mcp' && !this.lease) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    if (mode !== 'native' && (this.active.size || this.unresolved.size)) throw new HarnessSdkError('STRUCTURED_OUTPUT_BUSY')
    if (mode === 'native' && [...this.outputs.values()].some(output => !isDeepStrictEqual(output.schema.schema, schema.schema))) throw new HarnessSdkError('SESSION_BUSY')
    const output: Output = {
      submissionId,
      outputId: `anureo_output_${randomBytes(24).toString('hex')}`,
      mode,
      schema,
      attempts: 0,
      hasValue: false,
      text: new Map(),
      finalIds: new Set(),
      finalItems: new Map(),
      retainedBytes: 0,
      admittedVersion: this.terminalVersion,
    }
    this.retain(output, Buffer.byteLength(JSON.stringify(schema.schema)))
    this.outputs.set(submissionId, output)
    return output
  }
  /**
   * execute awaits this after a native close receipt and dispose awaits it before backend
   * disposal. Clear retention, associations and held-event accounting, detach the lease, then attempt
   * lease disposal and native tool disabling together. Clear the lane before invoking either so
   * queued candidates expire at receipt time. Classify promise rejections after both settle.
   * Session still owns observation closure, and OutputSession.dispose owns backend release.
   */
  private async release(): Promise<void> {
    this.outputs.clear()
    this.byTurn.clear()
    this.pending.clear()
    this.unresolved.clear()
    this.active.clear()
    this.locked = undefined
    this.terminalVersions.clear()
    this.outputBytes = 0
    this.heldBytes = 0
    this.heldCount = 0
    const lease = this.lease
    this.lease = undefined
    checkRelease(await Promise.allSettled([lease?.dispose(), this.backend?.structuredOutputTool?.configure()]))
  }
}

/**
 * projectCapabilities adds this extension for Session attachment and projected state when an MCP
 * lease supplies fallback support. The native schema capability takes precedence over this marker.
 */
const EXTENSION = { name: 'x-anureo/structured-output-mcp', version: '1' }
/** admitOutput retains these compiler closures for submitCandidate, outputValue and publishOutput. */
type PreparedSchema = ReturnType<typeof compileOutputSchema>
/**
 * admitOutput allocates one submission's schema, candidate and retained native messages. bind
 * associates it with execution state, and completeTurn/reject reclaim its accounted bytes. Native
 * submissions sharing an execution use byTurn's first output for final commitment.
 */
interface Output {
  submissionId: string
  /** Opaque fallback contract identity, replaced by redact in projected observations. */
  outputId: string
  mode: 'native' | 'tool' | 'mcp'
  /** Candidate admission closes before terminal publication or definite rejection cleanup. */
  finished?: boolean
  schema: PreparedSchema
  /** Absent until a native binding event or dispatch receipt associates this submission. */
  turnId?: string
  /** Distinguishes accepted falsy JSON values from an absent candidate. */
  hasValue: boolean
  value?: unknown
  /** Counts schema-invalid candidates only, up to the correction limit. */
  attempts: number
  /** Sticky admission failure that takes precedence over a successful native terminal. */
  error?: HarnessError
  /** Latest native text by item identity, assembled from snapshots and deltas for final parsing. */
  text: Map<string, string>
  /** Message identities ever marked final, including streamed patches. */
  finalIds: Set<string>
  /** Completed native finals withheld until terminal validation. */
  finalItems: Map<string, Extract<Item, { type: 'agentMessage' }>>
  /** Includes schema, text snapshots, withheld items and the accepted candidate. */
  retainedBytes: number
  /** Terminal sequence at admission, used to reject bindings to earlier executions. */
  admittedVersion: number
}
/** emit clones these pairs, holdForBinding retains them and bind replays them through accept in order. */
interface Envelope { event: AhpEventPayload; scope: EventScope }

/**
 * execute captures input/review identity once for unresolved admission, receipt binding and
 * definite-failure cleanup. Other methods have no submission tracked by the output wrapper.
 */
function requestSubmissionId<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): string | undefined {
  if (method === 'input/submit' || method === 'review/start') return (params as AhpRequestMap['input/submit'] | AhpRequestMap['review/start']).submissionId
  return undefined
}

/**
 * prepareOutput strips the unsupported native schema field and appends the selected fallback
 * contract before dispatch. Preserve the original blocks and opaque output identity; the caller
 * owns tool registration, locking and cleanup. Only fallback modes are passed here.
 */
function fallbackInput(input: AhpRequestMap['input/submit'], output: Output): AhpRequestMap['input/submit'] {
  const { outputSchema: _, ...native } = input
  const contract = output.mode === 'tool' ? [
    'After completing the task, you MUST call anureo_submit_result with your final result matching its parameter schema.',
    'Correct any validation errors and call it again within this execution. A text answer does not complete the task.',
  ].join('\n') : [
    'Required Anureo final-output protocol:',
    `After completing the task, you MUST invoke the ${OUTPUT_SERVER_NAME} MCP submit_result tool. Its exposed name may have an editor/server prefix and ends with submit_result.`,
    'Pass the outputId below and your final JSON value as the value argument. A plain text or JSON answer does not complete this task.',
    'Copy outputId exactly, preserving every character. Pass outputId and value as separate top-level arguments; do not put outputId inside value.',
    'If the tool reports validation errors, correct the value and call it again within this execution. Once it acknowledges accepted:true, end the task.',
    'Do not substitute files or shell commands for submitting through this tool.',
    `outputId: ${output.outputId}`,
    `JSON Schema: ${JSON.stringify(output.schema.schema)}`,
  ].join('\n')
  return { ...native, input: [...input.input, { type: 'text', text: contract }] }
}
