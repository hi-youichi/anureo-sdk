// Coordinates structured-output admission and publication for adapters; must not own bridge transport or schema compilation.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap, type Capabilities, type HarnessError, type Item, type JsonObject, type JsonSchema, type SessionOpenParams, type SessionState } from '@anureo/protocol'
import { HarnessSdkError, sdkError } from '../errors'
import { guardRequest } from '../requests/guard'
import type { BackendSession, EventScope, HarnessAdapter, SessionEventSink, SessionMethod, StructuredOutputToolResult } from '../ports'
import type { QueueLimits } from '../queue'
import { OutputBridgeManager, type OutputBridgeLease } from './bridge'
import { OUTPUT_SERVER_NAME, toolError } from './tool'
import { compileOutputSchema } from './schema'

/** Advertised only while this session has a usable MCP fallback; native output support keeps its own capability contract. */
const EXTENSION = { name: 'x-anureo/structured-output-mcp', version: '1' }
/** Compiled session schema used for both candidate checks and final privacy-projected text validation. */
type PreparedSchema = ReturnType<typeof compileOutputSchema>
/** Per-submission output state; retainedBytes participates in the session budget and admittedVersion prevents binding to an execution that ended before admission. */
interface Output {
  submissionId: string
  outputId: string
  mode: 'native' | 'tool' | 'mcp'
  finished?: boolean
  schema: PreparedSchema
  turnId?: string
  hasValue: boolean
  value?: unknown
  attempts: number
  error?: HarnessError
  text: Map<string, string>
  finalIds: Set<string>
  finalItems: Map<string, Extract<Item, { type: 'agentMessage' }>>
  retainedBytes: number
  admittedVersion: number
}
/** Cloned event/scope pair retained until submission association allows ordered publication. */
interface Envelope { event: AhpEventPayload; scope: EventScope }
/** Build a safe protocol output failure from a code and already-sanitized details; never include native exception messages or perform cleanup. */
function failure(code: string, details?: Record<string, unknown>): HarnessError {
  return { code, message: code, retryable: false, outcomeUnknown: false, ...(details ? { details: details as JsonObject } : {}) }
}
/** Inspect all completed cleanup attempts; rethrow a single safe failure or aggregate multiple release codes. Preserve output-layer unknown-outcome flags rather than forcing runtime teardown policy. */
function checkRelease(results: PromiseSettledResult<unknown>[]): void {
  const causes = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => sdkError(result.reason, 'RESOURCE_RELEASE_FAILED', true))
  if (causes.length === 1) throw causes[0]
  if (causes.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output resources could not be released', false,
    causes.some(error => error.outcomeUnknown), { errors: causes.flatMap(error => error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors) ? error.details.errors : [{ code: error.code, outcomeUnknown: error.outcomeUnknown }]) })
}

/** Resource budgets passed from the client to each structured-output session; defaults remain at the resource admission sites. */
interface OutputLimits { queue?: QueueLimits; maxSubmissions?: number; maxResultBytes?: number; maxItems?: number }
/** Wrap an owned adapter with structured-output sessions and one lazy bridge manager; callers initialize/open/dispose through the wrapper. Dispose attempts every session, manager and underlying adapter release before reporting failure. */
export function withStructuredOutput(adapter: HarnessAdapter, limits: OutputLimits = {}): HarnessAdapter {
  const manager = new OutputBridgeManager(limits.queue?.maxFrameBytes)
  const sessions = new Set<OutputSession>()
  let nativeOutput = false
  return {
    /** Negotiate once through the adapter and remember native output support for subsequent session preparation; native failures propagate. */
    async initialize(params) { const result = await adapter.initialize(params); nativeOutput = result.capabilities.turn?.outputSchema === true; return result },
    /** Own a wrapper before opening so failures release partially acquired output resources before rejection. */
    async openSession(params, sink) {
      const session = new OutputSession({ params, sink, manager, limits, forget: () => sessions.delete(session) })
      sessions.add(session)
      try { return await session.open(adapter, nativeOutput) }
      catch (cause) { try { await session.dispose() } catch { throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output setup cleanup failed', false, sdkError(cause).outcomeUnknown) }; throw cause }
    },
    /** Attempt all session cleanup before concurrently releasing the shared manager/adapter; reject safe aggregated failures. */
    async dispose() {
      const results = await Promise.allSettled([...sessions].map(session => session.dispose()))
      results.push(...await Promise.allSettled([manager.dispose(), adapter.dispose()]))
      checkRelease(results)
    },
  }
}

/** Owns one adapter session’s structured-output associations and serialized publication; bridge transport and schema compilation remain delegated. */
class OutputSession implements BackendSession {
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
  /** Capture session dependencies without native I/O; forget removes this session from its wrapper after disposal attempts complete. */
  constructor(input: { params: SessionOpenParams; sink: SessionEventSink; manager: OutputBridgeManager; limits: OutputLimits; forget: () => void }) {
    this.params = input.params
    this.sink = input.sink
    this.manager = input.manager
    this.limits = input.limits
    this.forget = input.forget
  }
  private readonly params: SessionOpenParams
  private readonly sink: SessionEventSink
  private readonly manager: OutputBridgeManager
  private readonly limits: OutputLimits
  private readonly forget: () => void
  /** Expose the native binding once attached, otherwise the immutable open identity needed by early native callbacks. */
  get binding() { return this.backend?.binding ?? this.params.binding }
  /** Advertise fallback output support only when a usable session tool/lease exists; never mutate native capabilities. */
  get capabilities(): Capabilities { return this.projectCapabilities(this.backend?.capabilities ?? {}) }
  /** Return projected native state when available, with bridge credentials removed and fallback capability revision applied. */
  get state(): SessionState | undefined { return this.backend?.state ? this.redact(this.projectState(this.backend.state)) : undefined }
  /** Clone capabilities and add only the active fallback extension; preserve native support and suppress synthetic support after disposal. */
  private projectCapabilities(raw: Capabilities): Capabilities {
    const extension = this.backend?.structuredOutputTool ? { name: 'x-anureo/structured-output-tool', version: '1' } : this.lease ? EXTENSION : undefined
    if (raw.turn?.outputSchema || !extension || this.disposed) return structuredClone(raw)
    return { ...structuredClone(raw), turn: { ...raw.turn, outputSchema: true }, extensions: [...(raw.extensions ?? []).filter(value => value.name !== extension.name), extension] }
  }
  /** Project fallback capabilities and revision together so observers cannot see synthetic support with an unchanged revision. */
  private projectState(state: SessionState): SessionState {
    return { ...state, capabilities: this.projectCapabilities(state.capabilities), capabilityRevision: state.capabilityRevision + (this.lease || this.backend?.structuredOutputTool ? 1 : 0) }
  }
  /** Prepare an optional session bridge before native open, warning on preparation failure; adopt/dispose late backends safely. Reject reserved names, native open and cleanup failure. */
  async open(adapter: HarnessAdapter, nativeOutput: boolean): Promise<this> {
    // The optional port is an execution-location attestation, not a provider-name heuristic.
    const transport = nativeOutput ? undefined : adapter.outputBridgeTransport?.(this.params)
    let open = this.params
    if (transport) {
      if (this.params.mcpServers?.some(server => server.name === OUTPUT_SERVER_NAME)) throw new HarnessSdkError('INVALID_PARAMS', 'Reserved MCP server name')
      try {
        this.lease = await this.manager.create(transport, args => this.enqueue(async () => this.submitValue(args)))
        const config = this.lease.config
        if (config.type === 'http') { this.privateStrings.add(config.url); Object.values(config.headers ?? {}).forEach(value => this.privateStrings.add(value)) }
        else Object.values(config.env ?? {}).forEach(value => this.privateStrings.add(value))
        open = { ...this.params, mcpServers: [...(this.params.mcpServers ?? []), config] }
      } catch {
        await this.lease?.dispose(); this.lease = undefined
        await this.sink.emit({ type: 'notice', payload: { severity: 'warning', code: 'STRUCTURED_OUTPUT_BRIDGE_UNAVAILABLE', message: 'Structured output bridge could not be prepared' } })
      }
    }
    const bridgeSink: SessionEventSink = {
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
    const backend = await adapter.openSession(structuredClone(open), bridgeSink)
    this.backend = backend
    if (this.disposed) { await backend.dispose(); throw new HarnessSdkError('SESSION_CLOSED') }
    backend.state?.activeTurnIds.forEach(id => this.active.add(id))
    return this
  }
  /** Serialize state work after all previously queued work; return each outcome while keeping the chain usable after rejection. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(work)
    this.chain = operation.then(() => {}, () => {})
    return operation
  }
  /** Clone/count a native event before serialized acceptance; throw admission overflow and fail the public sink on asynchronous processing errors. Release queued counters after settlement. */
  private emit(event: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > (this.limits.queue?.maxFrameBytes ?? 8 * 1024 * 1024) || this.queuedBytes + this.heldBytes + bytes > (this.limits.queue?.maxBytes ?? 16 * 1024 * 1024) || this.queuedEvents + this.heldCount >= (this.limits.queue?.maxEvents ?? 2048)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    const copy = structuredClone({ event, scope })
    this.queuedBytes += bytes; this.queuedEvents++
    const operation = this.enqueue(() => this.accept(copy))
    return operation.catch(async cause => { await this.sink.fail(cause); throw cause }).finally(() => { this.queuedBytes -= bytes; this.queuedEvents-- })
  }
  /** Bind output to native execution and replay held events in order; reject conflicting or temporally impossible binding without associating earlier terminal work. */
  private async bind(submissionId: string, turnId: string): Promise<void> {
    this.unresolved.delete(submissionId)
    const output = this.outputs.get(submissionId)
    if (output) {
      if (output.turnId && output.turnId !== turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting structured output binding')
      const endedAt = this.terminalVersions.get(turnId)
      if (endedAt !== undefined) {
        if (output.admittedVersion >= endedAt) throw new HarnessSdkError('PROTOCOL_ERROR', 'Structured submission bound to an earlier execution')
        // Equal-schema native inputs can acquire their shared binding after that execution ended.
        this.drop(submissionId)
        return
      }
      output.turnId = turnId
      const previous = this.byTurn.get(turnId)
      if (previous && !isDeepStrictEqual(previous.schema.schema, output.schema.schema)) previous.error = failure('STRUCTURED_OUTPUT_BINDING_CONFLICT')
      else this.byTurn.set(turnId, previous ?? output)
    }
    // Receipt-only backends can bind after emitting all their execution events.
    const held = this.pending.get(turnId)
    if (held) {
      this.pending.delete(turnId)
      for (const envelope of held) {
        this.heldCount--; this.heldBytes -= Buffer.byteLength(JSON.stringify(envelope.event))
        await this.accept(envelope)
      }
    }
  }
  /** Return a recursive credential/output-ID projection of session data; never expose bridge credentials or mutate retained native values. */
  private redact<T>(value: T): T {
    /** Recursively project bridge secrets from string values while preserving non-string values and object keys. */
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
  /** Apply a retained-byte delta to session and output accounting only within budget; throw RESULT_BUDGET_EXCEEDED before mutation. */
  private retain(output: Output, bytes: number): void {
    if (this.outputBytes + bytes > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
    this.outputBytes += bytes; output.retainedBytes += bytes
  }
  /** Retain the current item text with replacement byte accounting; throw budget failure before exceeding distinct-item or byte caps. */
  private rememberText(output: Output, id: string, text: string): void {
    if (!output.text.has(id) && output.text.size >= (this.limits.maxItems ?? 2048)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
    this.retain(output, Buffer.byteLength(text) - Buffer.byteLength(output.text.get(id) ?? ''))
    output.text.set(id, text)
  }
  /** Remove one submission’s retained output and subtract its accounted bytes; association maps are managed by the caller’s lifecycle path. */
  private drop(submissionId: string): void {
    const output = this.outputs.get(submissionId)
    if (output) this.outputBytes -= output.retainedBytes
    this.outputs.delete(submissionId)
  }
  /** Validate, route and publish one serialized event; delegate each lifecycle phase so buffering and terminal cleanup remain ordered. Reject protocol, schema or budget failure. */
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
  /** Validate the event contract before changing association or buffering state, including events that will be held. */
  private validateEnvelope(event: AhpEventPayload, scope: EventScope): void {
    assertEvent({ ...scope, sessionId: this.binding.sessionId, streamId: 'output-validation', seq: 1, timestamp: new Date().toISOString(), ...event })
  }
  /** Forward binding before replay, release rejected submissions, and redact/project state snapshots; return true when the event is fully handled. */
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
  /** Derive execution identity from explicit scope first, falling back to turn lifecycle payloads. */
  private eventTurnId(event: AhpEventPayload, scope: EventScope): string | undefined {
    return scope.turnId ?? (event.type === 'turn/started' || event.type === 'turn/completed' ? event.payload.turnId : undefined)
  }
  /** Publish duplicate lifecycle events after their first terminal without reopening or mutating completed output state. */
  private isLateTerminal(event: AhpEventPayload, turnId: string | undefined): boolean {
    return Boolean(turnId && this.terminalVersions.has(turnId) && (event.type === 'turn/started' || event.type === 'turn/completed'))
  }
  /** Hold item/terminal events while a submission may still acquire its turn binding; preserve their original order for replay. */
  private holdForBinding(event: AhpEventPayload, scope: EventScope, turnId: string | undefined, output: Output | undefined): boolean {
    const needsBinding = !output && [...this.outputs.values()].some(value => !value.turnId)
    if (turnId && needsBinding && (event.type.startsWith('item/') || event.type === 'turn/completed')) {
      const held = this.pending.get(turnId) ?? []; held.push({ event, scope }); this.pending.set(turnId, held)
      this.heldCount++; this.heldBytes += Buffer.byteLength(JSON.stringify(event))
      return true
    }
    return false
  }
  /** Retain native final identity for validation and downgrade streamed final markers to commentary until an accepted result is published. */
  private projectItemEvent(event: AhpEventPayload, output: Output): AhpEventPayload | undefined {
    if (output && (event.type === 'item/started' || event.type === 'item/completed')) {
      const item = event.payload.item
      if (item.type === 'agentMessage') {
        this.rememberText(output, item.id, item.text)
        if (item.phase === 'final') output.finalIds.add(item.id)
        if (output.mode === 'native' && event.type === 'item/completed' && item.phase === 'final') {
          // Preserve the native final identity used by authoritative history. Publish it only after validation.
          this.retain(output, Buffer.byteLength(JSON.stringify(item)) - (output.finalItems.has(item.id) ? Buffer.byteLength(JSON.stringify(output.finalItems.get(item.id))) : 0))
          output.finalItems.set(item.id, item)
          return undefined
        }
        event = { ...event, payload: { item: { ...item, phase: 'commentary' } } }
      }
    } else if (output && event.type === 'item/delta') {
      if (event.payload.kind === 'text' && event.payload.text !== undefined) {
        const text = (output.text.get(event.payload.itemId) ?? '') + event.payload.text
        if (Buffer.byteLength(text) > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
        this.rememberText(output, event.payload.itemId, text)
      }
      const value = event.payload.value
      if (event.payload.kind === 'patch' && value && typeof value === 'object' && !Array.isArray(value) && value.type === 'agentMessage') {
        this.rememberText(output, event.payload.itemId, String(value.text ?? ''))
        if (value.phase === 'final') output.finalIds.add(event.payload.itemId)
        event = { ...event, payload: { ...event.payload, value: { ...value, phase: 'commentary' } } }
      }
    }
    return event
  }
  /** Validate the candidate against the final projected JSON, publish accepted final items, then clear turn associations before forwarding its terminal. */
  private async completeTurn(event: Extract<AhpEventPayload, { type: 'turn/completed' }>, output: Output | undefined, turnId: string | undefined): Promise<AhpEventPayload> {
    if (output) {
      output.finished = true
      if (output.mode === 'tool') await this.backend!.structuredOutputTool!.configure()
    }
    if (output && event.payload.status === 'completed') event = await this.publishOutput(event, output, turnId)
    if (output && event.payload.status !== 'completed') await this.publishCommentaryFinals(output, turnId)
    this.active.delete(event.payload.turnId)
    this.terminalVersions.set(event.payload.turnId, ++this.terminalVersion)
    if (this.terminalVersions.size > (this.limits.maxSubmissions ?? 1024)) this.terminalVersions.delete(this.terminalVersions.keys().next().value!)
    if (output) {
      for (const [id, value] of this.outputs) if (value.turnId === turnId) this.drop(id)
      this.byTurn.delete(event.payload.turnId)
      if (this.locked?.turnId === turnId) this.locked = undefined
    }
    return event
  }
  /** Accept only schema-valid, privacy-projected JSON; convert candidate failures into a safe failed terminal. */
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
      for (const item of output.finalItems.values()) if (item.id !== original?.id) await this.sink.emit({ type: 'item/completed', payload: { item: { ...item, phase: 'commentary' } } }, { turnId })
      const item: Item = { ...(original ?? { id: `anureo-result:${randomBytes(24).toString('hex')}`, type: 'agentMessage' }), phase: 'final', text, status: 'completed' }
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId })
    }
    return event
  }
  /** Parse native final text or require the first accepted tool/MCP value; distinguish missing from exhausted-invalid submission. */
  private outputValue(output: Output): unknown {
    if (output.mode === 'native') return output.schema.parse([...output.finalIds].map(id => output.text.get(id) ?? '').join('\n'))
    if (output.hasValue) return output.value
    throw new HarnessSdkError(output.attempts ? 'STRUCTURED_OUTPUT_INVALID' : 'STRUCTURED_OUTPUT_MISSING')
  }
  /** Downgrade retained native finals after a failed/interrupted execution so they cannot appear as accepted output. */
  private async publishCommentaryFinals(output: Output, turnId: string | undefined): Promise<void> {
    for (const item of output.finalItems.values()) await this.sink.emit({ type: 'item/completed', payload: { item: { ...item, phase: 'commentary' } } }, { turnId })
  }
  /** Validate the MCP envelope and current output identity, then route its candidate through shared submission policy; return safe MCP errors with retry guidance. */
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
  /** Apply the same lifecycle, replay, schema, retry and budget rules to tool/MCP candidates; return acceptance or safe failure and retain a cloned first accepted value. */
  private submitCandidate(output: Output, value: unknown): StructuredOutputToolResult {
    const rejected = (code: string, details?: Record<string, unknown>): StructuredOutputToolResult => ({ accepted: false, error: failure(code, details) })
    if (this.disposed || output.finished || this.locked !== output) return rejected('STRUCTURED_OUTPUT_EXPIRED')
    if (output.error) return { accepted: false, error: output.error }
    if (output.hasValue) return isDeepStrictEqual(output.value, value) ? { accepted: true } : rejected('STRUCTURED_OUTPUT_ALREADY_SUBMITTED')
    let bytes: number
    try { bytes = Buffer.byteLength(JSON.stringify(value)) } catch { return rejected('STRUCTURED_OUTPUT_INVALID') }
    if (bytes > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) { output.error = failure('RESULT_BUDGET_EXCEEDED'); return { accepted: false, error: output.error } }
    try { output.schema.check(value) } catch (cause) {
      if (++output.attempts >= 3) output.error = failure('STRUCTURED_OUTPUT_RETRIES_EXCEEDED')
      return rejected(output.error?.code ?? 'STRUCTURED_OUTPUT_INVALID', sdkError(cause).details)
    }
    try { this.retain(output, bytes) } catch { output.error = failure('RESULT_BUDGET_EXCEEDED'); return { accepted: false, error: output.error } }
    output.value = structuredClone(value); output.hasValue = true
    return { accepted: true }
  }
  /** Release an unbound definitively rejected submission and disable its tool; never undo an execution already bound. Propagate tool cleanup failure. */
  private async reject(submissionId: string): Promise<void> {
    this.unresolved.delete(submissionId)
    const output = this.outputs.get(submissionId)
    if (output?.turnId) return // A rejection cannot undo an execution already observed.
    if (output) output.finished = true
    if (output?.mode === 'tool') await this.backend!.structuredOutputTool!.configure()
    this.drop(submissionId)
    if (this.locked === output) this.locked = undefined
  }
  /** Prepare structured-output state before dispatch; mark submission IDs unresolved only after policy setup succeeds. */
  private async prepareSubmission<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<{ params: AhpRequestMap[M]; submissionId?: string }> {
    let submissionId: string | undefined
    if (method === 'input/submit') {
      const input = params as AhpRequestMap['input/submit']
      submissionId = input.submissionId
      if (input.outputSchema !== undefined) params = await this.prepareOutput(input, input.outputSchema) as AhpRequestMap[M]
      this.unresolved.add(submissionId)
    } else if (method === 'review/start') {
      submissionId = (params as AhpRequestMap['review/start']).submissionId
      this.unresolved.add(submissionId)
    }
    return { params, submissionId }
  }
  /** Compile and retain one schema, choose native/tool/MCP policy, then configure the fallback contract before dispatch. */
  private async prepareOutput(input: AhpRequestMap['input/submit'], schemaSource: JsonSchema): Promise<AhpRequestMap['input/submit']> {
    if (this.outputs.size >= (this.limits.maxSubmissions ?? 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    const schema = compileOutputSchema(schemaSource)
    const backend = this.backend!
    const mode = backend.capabilities.turn?.outputSchema ? 'native' : backend.structuredOutputTool ? 'tool' : 'mcp'
    if (mode === 'mcp' && !this.lease) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    if (mode !== 'native' && (this.active.size || this.unresolved.size)) throw new HarnessSdkError('STRUCTURED_OUTPUT_BUSY')
    if (mode === 'native' && [...this.outputs.values()].some(output => !isDeepStrictEqual(output.schema.schema, schema.schema))) throw new HarnessSdkError('SESSION_BUSY')
    const output: Output = { submissionId: input.submissionId, outputId: `anureo_output_${randomBytes(24).toString('hex')}`, mode, schema, attempts: 0, hasValue: false, text: new Map(), finalIds: new Set(), finalItems: new Map(), retainedBytes: 0, admittedVersion: this.terminalVersion }
    this.retain(output, Buffer.byteLength(JSON.stringify(schema.schema)))
    this.outputs.set(input.submissionId, output)
    if (mode === 'native') return input
    this.locked = output
    const { outputSchema: _, ...native } = input
    const contract = mode === 'tool' ? [
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
      `JSON Schema: ${JSON.stringify(schema.schema)}`,
    ].join('\n')
    const prepared = { ...native, input: [...input.input, { type: 'text' as const, text: contract }] }
    if (mode === 'tool') await backend.structuredOutputTool!.configure({
      name: 'anureo_submit_result',
      description: 'Submit the final result for the current task. Correct validation errors and retry. Acceptance ends this execution.',
      schema: structuredClone(schema.schema),
      execute: value => this.enqueue(async () => this.submitCandidate(output, value)),
    })
    return prepared
  }
  /** Prepare output policy before native input, validate transformed requests against native capabilities, then execute once; bind late receipts and release on close. Reject original failures with safe cleanup details. */
  async execute<M extends SessionMethod>(method: M, original: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.disposed || !this.backend) throw new HarnessSdkError('SESSION_CLOSED')
    let params = structuredClone(original)
    if (this.locked && ['input/submit', 'review/start', 'compact/start', 'session/config/set', 'session/revert'].includes(method)) throw new HarnessSdkError('STRUCTURED_OUTPUT_BUSY')
    let submissionId: string | undefined
    try {
      if (method === 'input/submit') submissionId = (params as AhpRequestMap['input/submit']).submissionId
      else if (method === 'review/start') submissionId = (params as AhpRequestMap['review/start']).submissionId
      const prepared = await this.prepareSubmission(method, params)
      params = prepared.params
      submissionId = prepared.submissionId ?? submissionId
      if (Buffer.byteLength(JSON.stringify(params)) > (this.limits.queue?.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('FRAME_TOO_LARGE')
      guardRequest(method, params, this.binding.sessionId, this.backend.capabilities)
      const result = await this.backend.execute(method, params)
      if (submissionId && result && typeof result === 'object' && 'turnId' in result && typeof result.turnId === 'string') await this.enqueue(() => this.bind(submissionId!, result.turnId as string))
      if (method === 'session/config/set') return this.redact(this.projectState(result as SessionState)) as AhpResultMap[M]
      if (method === 'history/read') return this.redact(result)
      if (method === 'session/close') await this.release()
      return result
    } catch (cause) {
      if (submissionId && !sdkError(cause).outcomeUnknown) {
        try { await this.reject(submissionId) } catch (cleanup) {
          const error = sdkError(cause), release = sdkError(cleanup, 'RESOURCE_RELEASE_FAILED', true)
          throw new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown,
            { ...error.details, cleanupErrors: [{ code: release.code, outcomeUnknown: release.outcomeUnknown }] })
        }
      }
      throw cause
    }
  }
  /** Clear output retention/association state before disposing the lease and disabling the tool; await both attempts and report release failure without touching the native session. */
  private async release(): Promise<void> {
    this.outputs.clear(); this.byTurn.clear(); this.pending.clear(); this.unresolved.clear(); this.active.clear(); this.locked = undefined
    this.terminalVersions.clear()
    this.outputBytes = 0; this.heldBytes = 0; this.heldCount = 0
    const lease = this.lease; this.lease = undefined
    checkRelease(await Promise.allSettled([lease?.dispose(), this.backend?.structuredOutputTool?.configure()]))
  }
  /** Idempotently close admission, release output resources, then attempt native disposal and remove wrapper ownership; report cleanup failures after both stages settle. */
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.disposed = true
      const results = await Promise.allSettled([this.release()])
      results.push(...await Promise.allSettled([this.backend?.dispose()]))
      this.forget()
      checkRelease(results)
    })()
  }
}
