import { randomUUID } from 'node:crypto'
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, validateJsonSchema,
  type AhpRequestMap, type AhpResultMap, type Boundary, type Capabilities, type HistoryItem,
  type InitializeParams, type InitializeResult, type Item, type JsonObject, type SessionBinding, type SessionOpenParams, type SessionState,
} from '@anureo/protocol'
import { HarnessSdkError, sdkError, type BackendSession, type HarnessAdapter, type SessionEventSink, type SessionMethod } from '@anureo/sdk'
import { createPiHost, type PiHostEntry, type PiHostEvent, type PiHostFactory, type PiHostMessage, type PiSessionHost } from './host'
import {
  PERMISSION_MODES, completeTool, contentText, createRedactor, historyItems, nativeInput, permissionTools, piTurnError, toolItem, turnStarts, usageOf,
  type Redactor,
} from './mapping'

export { createPiHost, type PiSessionHost, type PiHostEvent, type PiHostFactory, type PiHostOpenOptions, type PiHostMessage, type PiHostEntry, type PiHostModel } from './host'
export { createRedactor, permissionTools, piTurnError, historyItems, usageOf } from './mapping'
export { createPiCatalogSession, type PiModel } from './catalog'

/** Pi SDK releases whose behaviour is verified. Newer releases in the same major keep working; older ones get the baseline set. */
export const VERIFIED_PI_VERSIONS = ['1.5.2'] as const
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export interface PiProfile { since: string; resume: boolean; fork: boolean; compact: boolean; verified: boolean }
const versionParts = (version: string): [number, number, number] => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
}
const compareVersion = (a: string, b: string): number => {
  const left = versionParts(a), right = versionParts(b)
  for (let index = 0; index < 3; index++) if (left[index]! !== right[index]!) return left[index]! - right[index]!
  return 0
}
/** Newest profile whose `since` the version reaches; anything unknown gets the safe baseline. */
export function resolvePiProfile(version?: string): PiProfile {
  if (version && compareVersion(version, '1.5.2') >= 0 && versionParts(version)[0] === 1) {
    return { since: '1.5.2', resume: true, fork: true, compact: true, verified: (VERIFIED_PI_VERSIONS as readonly string[]).includes(version) }
  }
  return { since: '0.0.0', resume: false, fork: false, compact: false, verified: false }
}

export interface PiAdapterOptions {
  /** Pi SDK version, from a trusted probe. Defaults to the installed SDK's own VERSION. */
  version?: string
  /** Host factory; defaults to embedding Pi in-process. Inject a fake in tests or a subprocess host for isolation. */
  createHost?: PiHostFactory
  /** Pi's global config directory (auth.json, models.json, settings). */
  agentDir?: string
  /** Directory for Pi session files. */
  sessionDir?: string
  /** Keep sessions on disk so resume and fork work. Default true. */
  persistSessions?: boolean
  /** Credential values that must never appear in events, history or errors. */
  secrets?: string[]
  maxHistoryItems?: number
  diagnostic?: (code: string) => void
}

function capabilities(profile: PiProfile, persist: boolean): Capabilities {
  const stored = persist && profile.resume
  return {
    session: { resume: stored, fork: stored && profile.fork ? ['before', 'through'] : [], history: true },
    input: { delivery: ['native', 'afterTurn'], interrupt: { targets: ['session'], reportsPendingInputs: false } },
    turn: { outputSchema: false, overrides: [], inputModalities: ['text', 'image'] },
    ...(profile.compact ? { compact: true } : {}),
    config: { options: [
      { id: 'model', title: 'Model', scope: 'session', schema: { type: 'string', minLength: 1 } },
      { id: 'thinkingLevel', title: 'Thinking level', scope: 'session', schema: { type: 'string', enum: [...THINKING_LEVELS] } },
      { id: 'permissionMode', title: 'Permissions', scope: 'session', schema: { type: 'string', enum: [...PERMISSION_MODES], default: 'agent-full-access' } },
    ] },
  }
}

export class PiAdapter implements HarnessAdapter {
  readonly options: PiAdapterOptions
  readonly profile: PiProfile
  private readonly sessions = new Set<PiBackendSession>()
  /** Turn ids by Pi session id → user entry id, so forks and history use the ids seen live. */
  readonly turnMaps = new Map<string, Map<string, string>>()
  readonly redact: Redactor
  private readonly factory: PiHostFactory
  private disposed = false
  private version: string | undefined
  constructor(options: PiAdapterOptions = {}) {
    this.options = options
    this.version = options.version
    this.profile = resolvePiProfile(options.version)
    this.factory = options.createHost ?? createPiHost
    this.redact = createRedactor(options.secrets)
  }
  get persist(): boolean { return this.options.persistSessions ?? true }
  get capabilities(): Capabilities { return capabilities(this.profile, this.persist) }
  hostFactory(): PiHostFactory { return this.factory }
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest('initialize', params)
    negotiateVersion(params.protocolVersions)
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'pi', version: this.version ?? 'unknown', adapter: 'pi-native/0.1.0' }, capabilities: this.capabilities }
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    if (params.binding.adapterId !== 'pi') throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    const session = new PiBackendSession(this, params, sink)
    try { await session.open() } catch (cause) { await session.dispose().catch(() => {}); throw cause }
    this.sessions.add(session)
    return session
  }
  forget(session: PiBackendSession): void { this.sessions.delete(session) }
  /** The live session owning a Pi session id, if one is open here. */
  liveHost(nativeId: string): PiSessionHost | undefined { for (const session of this.sessions) if (session.nativeId === nativeId) return session.host }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const results = await Promise.allSettled([...this.sessions].map(session => session.dispose()))
    this.sessions.clear()
    const failed = results.find((value): value is PromiseRejectedResult => value.status === 'rejected')
    if (failed) throw failed.reason
  }
}

interface ActiveTurn {
  id: string
  /** Pi assistant messages seen so far; item ids derive from this counter. */
  assistant: number
  items: Map<string, Item>
  messages: PiHostMessage[]
  lastAssistant?: PiHostMessage
  stopped: Map<string, 'interrupted'>
  firstUserSeen: boolean
  error?: ReturnType<typeof piTurnError>
}

export class PiBackendSession implements BackendSession {
  host!: PiSessionHost
  binding: SessionBinding
  readonly capabilities: Capabilities
  private readonly redact: Redactor
  private unsubscribe?: () => void
  private active?: ActiveTurn
  private pending: string[] = []
  private closed = false
  private release?: Promise<void>
  private config: JsonObject
  private model?: string
  private capabilityRevision = 1
  private title?: string | null
  private tail: Promise<void> = Promise.resolve()
  private turns = new Map<string, string>()
  private snapshots = new Map<string, HistoryItem[]>()
  private compactions = 0
  /** Entry ids that existed before the current run, so the run's own user entry can be told apart. */
  private known = new Set<string>()
  private markKnown(): void { this.known = new Set(this.host.entries().map(entry => entry.id)) }
  constructor(private readonly adapter: PiAdapter, private readonly params: SessionOpenParams, private readonly sink: SessionEventSink) {
    this.binding = { ...params.binding }
    this.capabilities = adapter.capabilities
    this.redact = adapter.redact
    this.config = structuredClone(params.config ?? {})
    this.model = params.model ?? (typeof this.config.model === 'string' ? this.config.model : undefined)
    for (const [key, value] of Object.entries(this.config)) {
      const option = this.capabilities.config?.options.find(entry => entry.id === key)
      if (!option) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Unknown Pi config option')
      if (!validateJsonSchema(option.schema, value)) throw new HarnessSdkError('INVALID_PARAMS', 'Invalid Pi config value')
    }
  }
  get nativeId(): string { return this.binding.nativeRef?.value ?? '' }

  async open(): Promise<void> {
    const { params } = this
    const mode = this.permissionMode()
    const tools = permissionTools(mode)
    const common = {
      cwd: params.cwd, persist: this.adapter.persist && this.adapter.profile.resume,
      ...(this.model ? { model: this.model } : {}),
      ...(typeof this.config.thinkingLevel === 'string' ? { thinkingLevel: this.config.thinkingLevel } : {}),
      ...(tools ? { tools } : {}),
      ...(params.instructions ? { instructions: params.instructions } : {}),
      ...(this.adapter.options.agentDir ? { agentDir: this.adapter.options.agentDir } : {}),
      ...(this.adapter.options.sessionDir ? { sessionDir: this.adapter.options.sessionDir } : {}),
    }
    const factory = this.adapter.hostFactory()
    try {
      if (params.mode === 'fork') {
        if (!this.adapter.profile.fork || !common.persist) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Pi fork requires persisted sessions')
        const source = params.fork?.nativeRef?.value
        if (!source) throw new HarnessSdkError('SESSION_NOT_FOUND')
        this.host = await this.forkHost(source, params.fork!.boundary, factory, common)
      } else if (params.mode === 'resume') {
        const id = params.binding.nativeRef?.value
        if (!id || !this.adapter.profile.resume || !common.persist) throw new HarnessSdkError('SESSION_NOT_FOUND')
        this.host = await factory({ ...common, mode: 'resume', sessionId: id })
        this.turns = this.adapter.turnMaps.get(id) ?? new Map()
      } else this.host = await factory({ ...common, mode: 'new' })
    } catch (cause) { throw cause instanceof HarnessSdkError ? cause : sdkError(cause, 'PI_SESSION_OPEN_FAILED') }
    this.binding = { ...this.binding, nativeRef: { provider: 'pi', value: this.host.sessionId } }
    this.model = this.host.model ?? this.model
    this.adapter.turnMaps.set(this.nativeId, this.turns)
    this.markKnown()
    this.unsubscribe = this.host.subscribe(event => this.enqueue(event))
  }
  private permissionMode(): string | undefined {
    const value = this.config.permissionMode ?? this.params.permissionMode
    if (value === undefined) return undefined
    if (!(PERMISSION_MODES as readonly string[]).includes(String(value))) throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Pi permission mode')
    return String(value)
  }

  // ---- fork ---------------------------------------------------------------
  private async forkHost(sourceId: string, boundary: Boundary, factory: PiHostFactory, common: Omit<Parameters<PiHostFactory>[0], 'mode'>): Promise<PiSessionHost> {
    const live = this.adapter.liveHost(sourceId)
    const source = live ?? await factory({ ...common, mode: 'resume', sessionId: sourceId })
    try {
      const turns = this.adapter.turnMaps.get(sourceId) ?? new Map<string, string>()
      const entries = source.entries()
      const starts = turnStarts(entries, turns)
      const startId = boundary.nativeTurnId ?? [...turns].find(([, turn]) => turn === boundary.turnId)?.[0]
      if (!startId || !starts.has(startId)) throw new HarnessSdkError('TURN_NOT_FOUND', 'No verified native turn boundary')
      const index = entries.findIndex(entry => entry.id === startId)
      let leaf: string | null
      if (boundary.relation === 'before') leaf = entries[index]!.parentId
      else {
        const next = entries.findIndex((entry, position) => position > index && starts.has(entry.id))
        leaf = entries[(next >= 0 ? next : entries.length) - 1]!.id
      }
      const forked = await source.fork(leaf)
      this.turns = new Map([...turns].filter(([entryId]) => entries.findIndex(entry => entry.id === entryId) <= entries.findIndex(entry => entry.id === leaf)))
      return forked
    } finally { if (!live) await source.dispose().catch(() => {}) }
  }

  // ---- events -------------------------------------------------------------
  private enqueue(event: PiHostEvent): void {
    this.tail = this.tail.then(() => this.closed ? undefined : this.handle(event)).catch(cause => this.sink.fail(sdkError(cause, 'PI_EVENT_FAILED', true)).catch(() => {}))
  }
  private snapshot(): SessionState {
    return {
      ...(this.title !== undefined ? { metadata: { title: this.title } } : {}),
      binding: structuredClone(this.binding), status: this.active ? 'running' : 'ready', config: structuredClone(this.config),
      capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, ...(this.model ? { model: this.model } : {}),
      activeTurnIds: this.active ? [this.active.id] : [],
    }
  }
  private scope() { return this.active ? { turnId: this.active.id } : {} }
  private async beginTurn(): Promise<ActiveTurn> {
    if (this.active) return this.active
    this.active = { id: randomUUID(), assistant: 0, items: new Map(), messages: [], stopped: new Map(), firstUserSeen: false }
    await this.sink.emit({ type: 'turn/started', payload: { turnId: this.active.id } })
    for (const submissionId of this.pending.splice(0)) await this.sink.bindSubmission(submissionId, this.active.id)
    return this.active
  }
  private async handle(event: PiHostEvent): Promise<void> {
    switch (event.type) {
      case 'agent_start': await this.beginTurn(); return
      case 'agent_end': return
      case 'message_start': {
        if (event.message.role === 'assistant') (await this.beginTurn()).assistant++
        return
      }
      case 'message_update': return this.messageUpdate(await this.beginTurn(), event)
      case 'message_end': return this.messageEnd(await this.beginTurn(), event.message)
      case 'tool_start': {
        const active = await this.beginTurn()
        const item = toolItem(this.redact, event.id, event.name, event.args, 'running')
        active.items.set(item.id, item)
        await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId: active.id })
        return
      }
      case 'tool_update': {
        const active = this.active, previous = active?.items.get(event.id)
        if (!active || previous?.type !== 'toolCall') return
        const text = this.redact.text(typeof event.partial === 'string' ? event.partial : contentText((event.partial as { content?: never })?.content ?? ''))
        await this.sink.emit({ type: 'item/delta', payload: { itemId: event.id, kind: 'output', text } }, { turnId: active.id })
        return
      }
      case 'tool_end': {
        const active = this.active, previous = active?.items.get(event.id)
        if (!active || previous?.type !== 'toolCall') return
        const item = completeTool(this.redact, previous, event.result, event.isError, active.stopped.get(event.id))
        active.items.set(item.id, item)
        await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
        return
      }
      // Items need a turn scope; compaction outside a run is reported as notices instead.
      case 'compaction_start': {
        const active = this.active
        if (!active) { await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'PI_COMPACTION_STARTED', message: `Pi compaction started (${event.reason})` } }); return }
        const id = `${active.id}:compaction:${++this.compactions}`
        await this.sink.emit({ type: 'item/started', payload: { item: { id, type: 'compaction', status: 'running', trigger: event.reason } } }, { turnId: active.id })
        return
      }
      case 'compaction_end': {
        const active = this.active, failed = event.aborted || !!event.errorMessage
        if (!active) { await this.sink.emit({ type: 'notice', payload: { severity: failed ? 'warning' : 'info', code: failed ? 'PI_COMPACTION_FAILED' : 'PI_COMPACTION_COMPLETED', message: `Pi compaction ${failed ? 'did not complete' : 'completed'} (${event.reason})` } }); return }
        const item: Item = { id: `${active.id}:compaction:${this.compactions}`, type: 'compaction', status: failed ? 'failed' : 'completed', trigger: event.reason, ...(event.summary ? { summary: this.redact.text(event.summary) } : {}) }
        await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
        return
      }
      case 'retry':
        await this.sink.emit({ type: 'notice', payload: { severity: event.phase === 'start' || event.success === false ? 'warning' : 'info', code: event.phase === 'start' ? 'PI_AUTO_RETRY' : 'PI_AUTO_RETRY_END', message: `Pi retry attempt ${event.attempt}` } }, this.scope())
        return
      case 'session_name':
        this.title = event.name ?? null
        await this.sink.emit({ type: 'session/metadata', payload: { title: this.title } })
        return
      case 'failed': await this.sink.fail(new HarnessSdkError(event.code, 'Pi source failed', false, true)); return
      case 'error': {
        if (!this.active) { await this.sink.fail(new HarnessSdkError('PI_RUN_FAILED', 'Pi run failed', false, true)); return }
        this.active.error = { code: 'PI_RUN_FAILED', message: 'Pi run failed', retryable: false, outcomeUnknown: false }
        await this.finishTurn(false)
        return
      }
      case 'settled': {
        if (this.active) await this.finishTurn(event.aborted)
        else for (const submissionId of this.pending.splice(0)) {
          await this.sink.emit({ type: 'submission/status', payload: { submissionId, status: 'rejected', error: { code: 'NATIVE_INPUT_NOT_EXECUTED', message: 'Input ended without an execution', retryable: false, outcomeUnknown: false } } })
        }
        return
      }
    }
  }
  private itemId(active: ActiveTurn, index: number): string { return `${active.id}:a${active.assistant}:${index}` }
  private async messageUpdate(active: ActiveTurn, event: Extract<PiHostEvent, { type: 'message_update' }>): Promise<void> {
    const { update } = event
    if (update.kind === 'toolcall') return // tool items start at execution, when name and arguments are final
    const id = this.itemId(active, update.index)
    const part = Array.isArray(event.message.content) ? event.message.content[update.index] : undefined
    if (update.phase === 'start') {
      const item: Item = update.kind === 'text' ? { id, type: 'agentMessage', text: '', phase: 'commentary', status: 'running' } : { id, type: 'reasoning', text: '', status: 'running' }
      active.items.set(id, item)
      await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId: active.id })
    } else if (update.phase === 'delta') {
      const previous = active.items.get(id)
      if (!previous || (previous.type !== 'agentMessage' && previous.type !== 'reasoning')) return
      const text = this.redact.text(update.delta ?? '')
      previous.text = (previous.text ?? '') + text
      await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: previous.type === 'reasoning' ? 'reasoningSummary' : 'text', text } }, { turnId: active.id })
    } else if (update.kind === 'thinking') {
      const item: Item = { id, type: 'reasoning', status: 'completed', text: this.redact.text(part?.type === 'thinking' ? part.thinking : active.items.get(id)?.type === 'reasoning' ? (active.items.get(id) as { text?: string }).text ?? '' : '') }
      active.items.set(id, item)
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
    }
    // text completion waits for message_end, when the final/commentary phase is known
  }
  private async messageEnd(active: ActiveTurn, message: PiHostMessage): Promise<void> {
    if (message.role === 'user') {
      if (!active.firstUserSeen) {
        active.firstUserSeen = true
        // The first user entry not present before this run is the one that started it.
        const entry = this.host.entries().find(candidate => candidate.kind === 'message' && candidate.message?.role === 'user' && !this.known.has(candidate.id))
        if (entry) this.turns.set(entry.id, active.id)
      }
      return
    }
    if (message.role !== 'assistant') return
    active.messages.push(message); active.lastAssistant = message
    const error = piTurnError(message)
    if (error) active.error = error
    else if (message.stopReason === 'stop' || message.stopReason === 'toolUse') active.error = undefined
    const content = Array.isArray(message.content) ? message.content : []
    const hasTools = content.some(part => part.type === 'toolCall')
    for (let index = 0; index < content.length; index++) {
      const part = content[index]!
      if (part.type !== 'text') continue
      const id = this.itemId(active, index)
      const item: Item = { id, type: 'agentMessage', status: 'completed', text: this.redact.text(part.text), phase: !hasTools && message.stopReason === 'stop' ? 'final' : 'commentary' }
      if (!active.items.has(id)) await this.sink.emit({ type: 'item/started', payload: { item: { ...item, status: 'running', text: '' } } }, { turnId: active.id })
      active.items.set(id, item)
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
    }
  }
  private async finishTurn(aborted: boolean): Promise<void> {
    const active = this.active
    if (!active) return
    const interrupted = aborted || active.lastAssistant?.stopReason === 'aborted'
    const error = interrupted ? undefined : active.error
    for (const item of active.items.values()) {
      if (item.type === 'toolCall' && item.status === 'running') {
        const stopped: Item = { ...item, status: interrupted ? 'interrupted' : 'failed' }
        await this.sink.emit({ type: 'item/completed', payload: { item: stopped } }, { turnId: active.id })
      }
    }
    const usage = usageOf(active.messages)
    await this.sink.emit({ type: 'usage/updated', payload: usage }, { turnId: active.id })
    this.active = undefined
    this.markKnown()
    await this.sink.emit({ type: 'turn/completed', payload: { turnId: active.id, status: interrupted ? 'interrupted' : error ? 'failed' : 'completed', usage, ...(error ? { error } : {}) } })
    await this.sink.emit({ type: 'session/state', payload: this.snapshot() })
  }

  // ---- methods ------------------------------------------------------------
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED')
    let result: AhpResultMap[SessionMethod]
    switch (method) {
      case 'input/submit': return await this.submit(params as AhpRequestMap['input/submit']) as AhpResultMap[M]
      case 'session/interrupt': {
        try { await this.host.abort() } catch (cause) { throw sdkError(cause, 'PI_ABORT_FAILED', true) }
        result = { accepted: true }; break
      }
      case 'turn/interrupt': case 'turn/steer': throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Pi controls target the session, not an atomically matched turn')
      case 'session/config/set': result = await this.setConfig((params as AhpRequestMap['session/config/set']).patch); break
      case 'history/read': result = await this.readHistory(params as AhpRequestMap['history/read']); break
      case 'compact/start': {
        if (!this.capabilities.compact) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
        try { await this.host.compact() } catch (cause) { throw sdkError(cause, 'PI_COMPACT_FAILED', true) }
        result = { maintenanceId: randomUUID(), status: 'completed' }; break
      }
      case 'session/close': await this.dispose(); result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' }; break
      default: throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    }
    return result as AhpResultMap[M]
  }
  private async submit(start: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (start.outputSchema !== undefined) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Pi does not support structured output schemas')
    const { text, images } = nativeInput(start.input)
    const imageArg = images.length ? images : undefined
    const id = start.submissionId
    try {
      if (!this.host.busy && !this.active && !this.pending.length) {
        this.pending.push(id)
        let disposition
        try { disposition = await this.host.prompt(text, imageArg) } catch (cause) { this.pending = this.pending.filter(entry => entry !== id); throw cause }
        if (disposition === 'handled') { this.pending = this.pending.filter(entry => entry !== id); return { submissionId: id, accepted: true, disposition: 'accepted' } }
        return { submissionId: id, disposition: 'dispatched' }
      }
      const disposition = start.delivery === 'afterTurn' ? await this.host.followUp(text, imageArg) : await this.host.steer(text, imageArg)
      if (disposition === 'handled') return { submissionId: id, accepted: true, disposition: 'accepted' }
      if (this.active) return { submissionId: id, accepted: true, disposition: 'joined', turnId: this.active.id }
      this.pending.push(id)
      return { submissionId: id, disposition: 'dispatched' }
    } catch (cause) { throw cause instanceof HarnessSdkError ? cause : sdkError(cause, 'PI_SUBMIT_FAILED') }
  }
  private async setConfig(patch: JsonObject): Promise<SessionState> {
    for (const key of Object.keys(patch)) if (!this.capabilities.config?.options.some(option => option.id === key)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Unknown Pi config option')
    const models = patch.model !== undefined || patch.thinkingLevel !== undefined ? await this.host.listModels() : []
    if (patch.model !== undefined && (typeof patch.model !== 'string' || !models.some(model => model.ref === patch.model))) throw new HarnessSdkError('INVALID_PARAMS', 'Model is not available in Pi')
    if (patch.thinkingLevel !== undefined) {
      const target = models.find(model => model.ref === (patch.model ?? this.model ?? this.host.model))
      const levels = target?.thinkingLevels ?? this.host.availableThinkingLevels()
      if (typeof patch.thinkingLevel !== 'string' || !levels.includes(patch.thinkingLevel)) throw new HarnessSdkError('INVALID_PARAMS', 'Thinking level is not available for this model')
    }
    const tools = patch.permissionMode !== undefined ? (() => { if (!(PERMISSION_MODES as readonly string[]).includes(String(patch.permissionMode))) throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Pi permission mode'); return permissionTools(patch.permissionMode) })() : undefined
    try {
      if (patch.model !== undefined) { await this.host.setModel(patch.model as string); this.model = patch.model as string }
      if (patch.thinkingLevel !== undefined) this.host.setThinkingLevel(patch.thinkingLevel as string)
      if (tools) this.host.setActiveTools(tools)
    } catch (cause) { throw sdkError(cause, 'PI_CONFIG_FAILED', true) }
    this.config = { ...this.config, ...patch }
    this.capabilityRevision++
    const state = this.snapshot()
    await this.sink.emit({ type: 'session/state', payload: state })
    return state
  }
  private async readHistory(request: AhpRequestMap['history/read']): Promise<AhpResultMap['history/read']> {
    let token = request.snapshotToken
    if (!token) {
      const limit = this.adapter.options.maxHistoryItems ?? 5000
      const items = historyItems(this.redact, this.host.entries(), this.turns).slice(-limit)
      token = randomUUID(); this.snapshots.set(token, items)
      if (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value!)
    }
    const snapshot = this.snapshots.get(token)
    if (!snapshot) throw new HarnessSdkError('CURSOR_EXPIRED')
    const offset = request.cursor === undefined ? 0 : Number(request.cursor)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.length) throw new HarnessSdkError('CURSOR_INVALID')
    const page = snapshot.slice(offset, offset + Math.min(request.limit ?? 200, 1000))
    return { items: structuredClone(page), ...(offset + page.length < snapshot.length ? { nextCursor: String(offset + page.length) } : {}), snapshotToken: token, source: this.binding.nativeRef }
  }
  async dispose(): Promise<void> {
    return this.release ??= (async () => {
      this.closed = true
      this.unsubscribe?.(); this.unsubscribe = undefined
      this.pending = []
      const host = this.host
      if (host) {
        if (host.busy) await host.abort().catch(() => {})
        await host.dispose()
      }
      this.adapter.forget(this)
    })()
  }
}

export function createPiAdapter(options?: PiAdapterOptions): PiAdapter { return new PiAdapter(options) }
export type { PiHostEntry as PiEntry }
