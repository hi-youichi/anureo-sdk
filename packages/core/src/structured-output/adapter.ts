import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assertEvent, type AhpEventPayload, type AhpRequestMap, type AhpResultMap, type Capabilities, type HarnessError, type Item, type JsonObject, type SessionOpenParams, type SessionState } from '@anureo/protocol'
import { HarnessSdkError, sdkError } from '../errors'
import { guardRequest } from '../guard'
import type { BackendSession, EventScope, HarnessAdapter, SessionEventSink, SessionMethod, StructuredOutputToolResult } from '../ports'
import type { QueueLimits } from '../queue'
import { OutputBridgeManager, OUTPUT_SERVER_NAME, toolError, type OutputBridgeLease } from './bridge'
import { compileOutputSchema } from './schema'

const EXTENSION = { name: 'x-anureo/structured-output-mcp', version: '1' }
type PreparedSchema = ReturnType<typeof compileOutputSchema>
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
interface Envelope { event: AhpEventPayload; scope: EventScope }
function failure(code: string, details?: Record<string, unknown>): HarnessError {
  return { code, message: code, retryable: false, outcomeUnknown: false, ...(details ? { details: details as JsonObject } : {}) }
}
function checkRelease(results: PromiseSettledResult<unknown>[]): void {
  const causes = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => sdkError(result.reason, 'RESOURCE_RELEASE_FAILED', true))
  if (causes.length === 1) throw causes[0]
  if (causes.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output resources could not be released', false,
    causes.some(error => error.outcomeUnknown), { errors: causes.flatMap(error => error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors) ? error.details.errors : [{ code: error.code, outcomeUnknown: error.outcomeUnknown }]) })
}

/** Adapter-local composition keeps both SDK request entry points on the same route. */
interface OutputLimits { queue?: QueueLimits; maxSubmissions?: number; maxResultBytes?: number; maxItems?: number }
export function withStructuredOutput(adapter: HarnessAdapter, limits: OutputLimits = {}): HarnessAdapter {
  const manager = new OutputBridgeManager(limits.queue?.maxFrameBytes)
  const sessions = new Set<OutputSession>()
  let nativeOutput = false
  return {
    async initialize(params) { const result = await adapter.initialize(params); nativeOutput = result.capabilities.turn?.outputSchema === true; return result },
    async openSession(params, sink) {
      const session = new OutputSession(params, sink, manager, limits, () => sessions.delete(session))
      sessions.add(session)
      try { return await session.open(adapter, nativeOutput) }
      catch (cause) { try { await session.dispose() } catch { throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output setup cleanup failed', false, sdkError(cause).outcomeUnknown) }; throw cause }
    },
    async dispose() {
      const results = await Promise.allSettled([...sessions].map(session => session.dispose()))
      results.push(...await Promise.allSettled([manager.dispose(), adapter.dispose()]))
      checkRelease(results)
    },
  }
}

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
  constructor(private readonly params: SessionOpenParams, private readonly sink: SessionEventSink,
    private readonly manager: OutputBridgeManager, private readonly limits: OutputLimits, private readonly forget: () => void) {}
  get binding() { return this.backend?.binding ?? this.params.binding }
  get capabilities(): Capabilities { return this.projectCapabilities(this.backend?.capabilities ?? {}) }
  get state(): SessionState | undefined { return this.backend?.state ? this.redact(this.projectState(this.backend.state)) : undefined }
  private projectCapabilities(raw: Capabilities): Capabilities {
    const extension = this.backend?.structuredOutputTool ? { name: 'x-anureo/structured-output-tool', version: '1' } : this.lease ? EXTENSION : undefined
    if (raw.turn?.outputSchema || !extension || this.disposed) return structuredClone(raw)
    return { ...structuredClone(raw), turn: { ...raw.turn, outputSchema: true }, extensions: [...(raw.extensions ?? []).filter(value => value.name !== extension.name), extension] }
  }
  private projectState(state: SessionState): SessionState {
    return { ...state, capabilities: this.projectCapabilities(state.capabilities), capabilityRevision: state.capabilityRevision + (this.lease || this.backend?.structuredOutputTool ? 1 : 0) }
  }
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
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.chain.then(work)
    this.chain = operation.then(() => {}, () => {})
    return operation
  }
  private emit(event: AhpEventPayload, scope: EventScope = {}): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (bytes > (this.limits.queue?.maxFrameBytes ?? 8 * 1024 * 1024) || this.queuedBytes + this.heldBytes + bytes > (this.limits.queue?.maxBytes ?? 16 * 1024 * 1024) || this.queuedEvents + this.heldCount >= (this.limits.queue?.maxEvents ?? 2048)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    const copy = structuredClone({ event, scope })
    this.queuedBytes += bytes; this.queuedEvents++
    const operation = this.enqueue(() => this.accept(copy))
    return operation.catch(async cause => { await this.sink.fail(cause); throw cause }).finally(() => { this.queuedBytes -= bytes; this.queuedEvents-- })
  }
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
  private redact<T>(value: T): T {
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
  private retain(output: Output, bytes: number): void {
    if (this.outputBytes + bytes > (this.limits.maxResultBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
    this.outputBytes += bytes; output.retainedBytes += bytes
  }
  private rememberText(output: Output, id: string, text: string): void {
    if (!output.text.has(id) && output.text.size >= (this.limits.maxItems ?? 2048)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED')
    this.retain(output, Buffer.byteLength(text) - Buffer.byteLength(output.text.get(id) ?? ''))
    output.text.set(id, text)
  }
  private drop(submissionId: string): void {
    const output = this.outputs.get(submissionId)
    if (output) this.outputBytes -= output.retainedBytes
    this.outputs.delete(submissionId)
  }
  private async accept({ event, scope }: Envelope): Promise<void> {
    if (this.disposed) throw new HarnessSdkError('STREAM_CLOSED')
    // Validate before touching association/buffering state, even when a terminal is deferred.
    assertEvent({ ...scope, sessionId: this.binding.sessionId, streamId: 'output-validation', seq: 1, timestamp: new Date().toISOString(), ...event })
    if (event.type === 'submission/bound') {
      await this.sink.emit(event, scope)
      await this.bind(event.payload.submissionId, event.payload.turnId)
      return
    }
    if (event.type === 'submission/status' && event.payload.status === 'rejected') await this.reject(event.payload.submissionId)
    if (event.type === 'session/state') { await this.sink.emit(this.redact({ ...event, payload: this.projectState(event.payload) }), scope); return }
    const turnId = scope.turnId ?? (event.type === 'turn/started' || event.type === 'turn/completed' ? event.payload.turnId : undefined)
    if (turnId && this.terminalVersions.has(turnId) && (event.type === 'turn/started' || event.type === 'turn/completed')) {
      await this.sink.emit(this.redact(event), scope)
      return
    }
    if (event.type === 'turn/started') this.active.add(event.payload.turnId)
    const output = turnId ? this.byTurn.get(turnId) : undefined
    const needsBinding = !output && [...this.outputs.values()].some(value => !value.turnId)
    if (turnId && needsBinding && (event.type.startsWith('item/') || event.type === 'turn/completed')) {
      const held = this.pending.get(turnId) ?? []; held.push({ event, scope }); this.pending.set(turnId, held)
      this.heldCount++; this.heldBytes += Buffer.byteLength(JSON.stringify(event))
      return
    }
    if (output && (event.type === 'item/started' || event.type === 'item/completed')) {
      const item = event.payload.item
      if (item.type === 'agentMessage') {
        this.rememberText(output, item.id, item.text)
        if (item.phase === 'final') output.finalIds.add(item.id)
        if (output.mode === 'native' && event.type === 'item/completed' && item.phase === 'final') {
          // Preserve the native final identity used by authoritative history. Publish it only after validation.
          this.retain(output, Buffer.byteLength(JSON.stringify(item)) - (output.finalItems.has(item.id) ? Buffer.byteLength(JSON.stringify(output.finalItems.get(item.id))) : 0))
          output.finalItems.set(item.id, item)
          return
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
    if (event.type === 'turn/completed') {
      if (output) {
        output.finished = true
        if (output.mode === 'tool') await this.backend!.structuredOutputTool!.configure()
      }
      if (output && event.payload.status === 'completed') {
        let text: string | undefined
        try {
          if (output.error) throw new HarnessSdkError(output.error.code)
          const value = output.mode === 'native'
            ? output.schema.parse([...output.finalIds].map(id => output.text.get(id) ?? '').join('\n'))
            : output.hasValue ? output.value : (() => { throw new HarnessSdkError(output.attempts ? 'STRUCTURED_OUTPUT_INVALID' : 'STRUCTURED_OUTPUT_MISSING') })()
          output.schema.check(value)
          text = this.sink.projectOutput?.(this.redact(JSON.stringify(value))) ?? this.redact(JSON.stringify(value))
          try { output.schema.parse(text) } catch { throw new HarnessSdkError('STRUCTURED_OUTPUT_REDACTED') }
        } catch (cause) {
          const error = sdkError(cause, 'STRUCTURED_OUTPUT_INVALID')
          event = { ...event, payload: { ...event.payload, status: 'failed', error: failure(error.code, error.details) } }
        }
        if (text !== undefined && event.payload.status === 'completed') {
          const original = output.mode === 'native' && output.finalItems.size === 1 ? [...output.finalItems.values()][0] : undefined
          for (const item of output.finalItems.values()) if (item.id !== original?.id) await this.sink.emit({ type: 'item/completed', payload: { item: { ...item, phase: 'commentary' } } }, { turnId })
          const item: Item = { ...(original ?? { id: `anureo-result:${randomBytes(24).toString('hex')}`, type: 'agentMessage' }), phase: 'final', text, status: 'completed' }
          await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId })
        }
      }
      if (output && event.payload.status !== 'completed') for (const item of output.finalItems.values()) await this.sink.emit({ type: 'item/completed', payload: { item: { ...item, phase: 'commentary' } } }, { turnId })
      this.active.delete(event.payload.turnId)
      this.terminalVersions.set(event.payload.turnId, ++this.terminalVersion)
      if (this.terminalVersions.size > (this.limits.maxSubmissions ?? 1024)) this.terminalVersions.delete(this.terminalVersions.keys().next().value!)
      if (output) {
        for (const [id, value] of this.outputs) if (value.turnId === turnId) this.drop(id)
        this.byTurn.delete(event.payload.turnId)
        if (this.locked?.turnId === turnId) this.locked = undefined
      }
    }
    await this.sink.emit(this.redact(event), scope)
  }
  private submitValue(args: unknown) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return toolError('STRUCTURED_OUTPUT_EXPIRED')
    const value = args as Record<string, unknown>
    const output = this.locked
    if (!output || output.mode !== 'mcp' || output.outputId !== value.outputId || !Object.hasOwn(value, 'value') || Object.keys(value).some(key => key !== 'outputId' && key !== 'value')) return toolError('STRUCTURED_OUTPUT_EXPIRED')
    const result = this.submitCandidate(output, value.value)
    return result.accepted ? { content: [{ type: 'text' as const, text: '{"accepted":true}' }] } : toolError(result.error.code, result.error.details?.issues)
  }
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
  private async reject(submissionId: string): Promise<void> {
    this.unresolved.delete(submissionId)
    const output = this.outputs.get(submissionId)
    if (output?.turnId) return // A rejection cannot undo an execution already observed.
    if (output) output.finished = true
    if (output?.mode === 'tool') await this.backend!.structuredOutputTool!.configure()
    this.drop(submissionId)
    if (this.locked === output) this.locked = undefined
  }
  async execute<M extends SessionMethod>(method: M, original: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.disposed || !this.backend) throw new HarnessSdkError('SESSION_CLOSED')
    let params = structuredClone(original)
    if (this.locked && ['input/submit', 'review/start', 'compact/start', 'session/config/set', 'session/revert'].includes(method)) throw new HarnessSdkError('STRUCTURED_OUTPUT_BUSY')
    let submissionId: string | undefined
    try {
      if (method === 'input/submit') {
        const input = params as AhpRequestMap['input/submit']
        submissionId = input.submissionId
        if (input.outputSchema !== undefined) {
          if (this.outputs.size >= (this.limits.maxSubmissions ?? 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
          const schema = compileOutputSchema(input.outputSchema)
          const mode = this.backend.capabilities.turn?.outputSchema ? 'native' : this.backend.structuredOutputTool ? 'tool' : 'mcp'
          if (mode === 'mcp' && !this.lease) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
          if (mode !== 'native' && (this.active.size || this.unresolved.size)) throw new HarnessSdkError('STRUCTURED_OUTPUT_BUSY')
          if (mode === 'native' && [...this.outputs.values()].some(output => !isDeepStrictEqual(output.schema.schema, schema.schema))) throw new HarnessSdkError('SESSION_BUSY')
          const output: Output = { submissionId, outputId: `anureo_output_${randomBytes(24).toString('hex')}`, mode, schema, attempts: 0, hasValue: false, text: new Map(), finalIds: new Set(), finalItems: new Map(), retainedBytes: 0, admittedVersion: this.terminalVersion }
          this.retain(output, Buffer.byteLength(JSON.stringify(schema.schema)))
          this.outputs.set(submissionId, output)
          if (mode !== 'native') {
            this.locked = output
            const { outputSchema: _, ...native } = input
            const contract = mode === 'tool' ? [
              'After completing the task, you MUST call anureo_submit_result with your final result matching its parameter schema.',
              'Correct any validation errors and call it again within this execution. A text answer does not complete the task.',
            ].join('\n') : [
              'Required Anureo final-output protocol:',
              `After completing the task, you MUST invoke the ${OUTPUT_SERVER_NAME} MCP submit_result tool. Its exposed name may have an editor/server prefix and ends with submit_result.`,
              'Pass the outputId below and your final JSON value as the value argument. A plain text or JSON answer does not complete this task.',
              'If the tool reports validation errors, correct the value and call it again within this execution. Once it acknowledges accepted:true, end the task.',
              'Do not substitute files or shell commands for submitting through this tool.',
              `outputId: ${output.outputId}`,
              `JSON Schema: ${JSON.stringify(schema.schema)}`,
            ].join('\n')
            params = { ...native, input: [...input.input, { type: 'text', text: contract }] } as AhpRequestMap[M]
            if (mode === 'tool') await this.backend.structuredOutputTool!.configure({
              name: 'anureo_submit_result',
              description: 'Submit the final result for the current task. Correct validation errors and retry. Acceptance ends this execution.',
              schema: structuredClone(schema.schema),
              execute: value => this.enqueue(async () => this.submitCandidate(output, value)),
            })
          }
        }
        this.unresolved.add(submissionId)
      } else if (method === 'review/start') { submissionId = (params as AhpRequestMap['review/start']).submissionId; this.unresolved.add(submissionId) }
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
  private async release(): Promise<void> {
    this.outputs.clear(); this.byTurn.clear(); this.pending.clear(); this.unresolved.clear(); this.active.clear(); this.locked = undefined
    this.terminalVersions.clear()
    this.outputBytes = 0; this.heldBytes = 0; this.heldCount = 0
    const lease = this.lease; this.lease = undefined
    checkRelease(await Promise.allSettled([lease?.dispose(), this.backend?.structuredOutputTool?.configure()]))
  }
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
