/** Owns Pi session admission and ordered host-event publication through the SDK adapter ports. */
import { randomUUID } from 'node:crypto'
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, validateJsonSchema,
  type AhpRequestMap, type AhpResultMap, type Boundary, type Capabilities, type HistoryItem,
  type InitializeParams, type InitializeResult, type Item, type JsonObject, type SessionBinding, type SessionOpenParams, type SessionState,
} from '@anureo/protocol'
import { HarnessSdkError, sdkError, type BackendSession, type HarnessAdapter, type SessionEventSink, type SessionMethod, type StructuredOutputToolPort } from '@anureo/sdk'
import { createPiHost, type PiHostEntry, type PiHostEvent, type PiHostFactory, type PiHostMessage, type PiHostOpenOptions, type PiSessionHost } from './host'
import {
  PERMISSION_MODES, completeTool, contentText, createRedactor, historyItems, nativeInput, permissionTools, piTurnError, toolItem, turnStarts, usageOf,
  type Redactor,
} from './mapping'

export { createPiHost, type PiSessionHost, type PiHostEvent, type PiHostFactory, type PiHostOpenOptions, type PiHostMessage, type PiHostEntry, type PiHostModel } from './host'
export { createRedactor, permissionTools, piTurnError, historyItems, usageOf } from './mapping'
export { createPiCatalogSession, type PiModel } from './catalog'

/** Exact Pi releases verified for the optional profile; newer major-1 releases select it without verification. */
export const VERIFIED_PI_VERSIONS = ['1.5.2'] as const
/** Capabilities selected from a trusted Pi version, before persistence settings are applied. */
export interface PiProfile {
  /** Minimum release for this capability set; `0.0.0` denotes the baseline. */
  since: string
  resume: boolean
  fork: boolean
  compact: boolean
  /** True only for an exact version in VERIFIED_PI_VERSIONS. */
  verified: boolean
}
/** Select the 1.5.2 profile for major-1 versions at or above it; omitted, unparseable or other versions get the baseline. */
export function resolvePiProfile(version?: string): PiProfile {
  if (version && compareVersion(version, '1.5.2') >= 0 && versionParts(version)[0] === 1) {
    return { since: '1.5.2', resume: true, fork: true, compact: true, verified: (VERIFIED_PI_VERSIONS as readonly string[]).includes(version) }
  }
  return { since: '0.0.0', resume: false, fork: false, compact: false, verified: false }
}

/** Configure host creation, persistence and adapter-side history/redaction policy. */
export interface PiAdapterOptions {
  /** Trusted Pi SDK version. Omission reports `unknown` and selects the baseline, including for the embedded host. */
  version?: string
  /** Host factory; defaults to embedding Pi in-process. Inject a fake in tests or a subprocess host for isolation. */
  createHost?: PiHostFactory
  /** Pi's global config directory (auth.json, models.json, settings). */
  agentDir?: string
  /** Directory for Pi session files. */
  sessionDir?: string
  /** Allow disk persistence when the version profile supports resume. Default true; the baseline stays in memory. */
  persistSessions?: boolean
  /** Secret values to redact from mapped message/tool content and history; untyped native error messages are discarded. */
  secrets?: string[]
  /** Most recent history items per snapshot (default 5000); zero retains all. At most eight snapshots are kept per session. */
  maxHistoryItems?: number
  /** Currently unused; the adapter does not invoke this callback. */
  diagnostic?: (code: string) => void
}

/** Create an adapter for createClient; await client disposal to release its Pi hosts. No host opens until session admission. */
export function createPiAdapter(options?: PiAdapterOptions): PiAdapter { return new PiAdapter(options) }

/** Host history entry shape, also available as PiHostEntry. */
export type { PiHostEntry as PiEntry }

/**
 * Connect createClient to Pi hosts. Client negotiates and opens through the SDK's output wrapper;
 * disposal releases tracked sessions. Applications normally use createPiAdapter and let Client own cleanup.
 */
export class PiAdapter implements HarnessAdapter {
  /** Capture host policy without I/O; version omission initially selects the baseline. */
  constructor(options: PiAdapterOptions = {}) {
    this.options = options
    this.version = options.version
    this.profile = resolvePiProfile(options.version)
    this.factory = options.createHost ?? createPiHost
    this.redact = createRedactor(options.secrets)
  }
  /** Requested persistence policy, default true; session opening also requires profile.resume. */
  get persist(): boolean { return this.options.persistSessions ?? true }
  /** Native capability set for negotiation; the SDK may add structured output when a host exposes its tool port. */
  get capabilities(): Capabilities { return capabilities(this.profile, this.persist) }
  /** Supply PiBackendSession acquisition with the configured factory; the resulting backend owns host disposal. */
  hostFactory(): PiHostFactory { return this.factory }
  /** Negotiate the SDK contract without opening Pi; incompatible requests or a disposed adapter reject. Client stores the capabilities. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest('initialize', params)
    negotiateVersion(params.protocolVersions)
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'pi', version: this.version ?? 'unknown', adapter: 'pi-native/0.1.0' }, capabilities: this.capabilities }
  }
  /**
   * Acquire a backend for OutputSession.open and register ordered forwarding to its sink. Reject
   * disposed, non-Pi or MCP opens before host acquisition; setup failures attempt backend disposal
   * before rethrowing the original error. The returned backend remains owned by the output wrapper.
   */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    if (params.mcpServers?.length) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Pi uses direct tools and does not accept MCP servers')
    if (params.binding.adapterId !== 'pi') throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    const session = new PiBackendSession(this, params, sink)
    try { await session.open() } catch (cause) { await session.dispose().catch(() => {}); throw cause }
    this.sessions.add(session)
    return session
  }
  /** Remove a backend after PiBackendSession.dispose releases its host; turn maps remain available for resume/fork. */
  forget(session: PiBackendSession): void { this.sessions.delete(session) }
  /** Borrow a tracked source for PiBackendSession.forkHost; the borrower must not dispose this host. */
  liveHost(nativeId: string): PiSessionHost | undefined { for (const session of this.sessions) if (session.nativeId === nativeId) return session.host }
  /** Release every tracked backend concurrently; after all settle, reject the first failure. Later calls are no-ops. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const results = await Promise.allSettled([...this.sessions].map(session => session.dispose()))
    this.sessions.clear()
    const failed = results.find((value): value is PromiseRejectedResult => value.status === 'rejected')
    if (failed) throw failed.reason
  }
  /** Original option object retained by reference; host paths/history limits are read when used. */
  readonly options: PiAdapterOptions
  /** Version-derived capabilities captured at construction. */
  readonly profile: PiProfile
  private readonly sessions = new Set<PiBackendSession>()
  /** Turn ids by Pi session id → user entry id, so forks and history use the ids seen live. */
  readonly turnMaps = new Map<string, Map<string, string>>()
  /** Content redactor shared by backends, captured from the constructor options. */
  readonly redact: Redactor
  private readonly factory: PiHostFactory
  private disposed = false
  private version: string | undefined
}

/**
 * Backend returned by PiAdapter.openSession to OutputSession.open. Receipts acknowledge native input
 * separately from sink events; agent_end alone does not complete a turn. The owning wrapper disposes
 * this backend and configures any direct output tool around structured submissions.
 */
export class PiBackendSession implements BackendSession {
  /**
   * PiAdapter.openSession captures one open request and its sink here without acquiring a host.
   * Unknown config options throw CAPABILITY_UNSUPPORTED and invalid schema values throw
   * INVALID_PARAMS. The adapter must await open and dispose this object on setup failure.
   */
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
  /**
   * Expose host tool registration to OutputSession when available. The wrapper awaits configure
   * before dispatch and disables the tool on terminal/rejection/cleanup; host registration failures
   * reject that operation. Candidate callbacks and schema validation remain owned by the wrapper.
   */
  get structuredOutputTool(): StructuredOutputToolPort | undefined {
    return this.host?.setOutputTool ? { configure: tool => this.host.setOutputTool!(tool) } : undefined
  }
  /** Pi identity after open, or the requested native reference/empty string before acquisition. */
  get nativeId(): string { return this.binding.nativeRef?.value ?? '' }

  /**
   * PiAdapter.openSession calls once before returning this backend. Acquire and bind the host,
   * retain pre-run entries and subscribe in that order so new user entries can identify live turns.
   * Acquisition failures use sdkError with PI_SESSION_OPEN_FAILED as fallback. The adapter owns
   * disposal if binding or subscription setup fails after acquisition.
   */
  async open(): Promise<void> {
    const common = this.hostOptions()
    const factory = this.adapter.hostFactory()
    try { this.host = await this.acquireHost({ common, factory }) }
    catch (cause) { throw cause instanceof HarnessSdkError ? cause : sdkError(cause, 'PI_SESSION_OPEN_FAILED') }
    this.binding = { ...this.binding, nativeRef: { provider: 'pi', value: this.host.sessionId } }
    this.model = this.host.model ?? this.model
    this.adapter.turnMaps.set(this.nativeId, this.turns)
    this.markKnown()
    this.unsubscribe = this.host.subscribe(event => this.enqueue(event))
  }
  /**
   * Dispatch one SDK-validated request from OutputSession.execute after open. Submission resolves
   * on native acceptance, interrupt after abort, and compact after native compaction; sink events
   * independently report execution completion. Unsupported/closed requests and native failures
   * reject without automatic retry. Close releases observation with execution stop unconfirmed.
   */
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
  /**
   * Share one cleanup attempt across callers. Stop admission, unsubscribe and discard pending
   * inputs before best-effort abort and awaited host disposal. Host disposal failure rejects the
   * shared promise and leaves adapter tracking intact; cleanup does not await event-tail drainage.
   */
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

  /** Acquired by open; backend disposal owns its release, including partially completed setup. */
  host!: PiSessionHost
  /** Requested SDK identity, with the native reference replaced after acquisition. */
  binding: SessionBinding
  /** Native capabilities captured for attachment; direct output support is projected by the SDK wrapper. */
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
  /** Snapshot entry ids at open/turn completion so the next run can associate its first new user entry. */
  private markKnown(): void { this.known = new Set(this.host.entries().map(entry => entry.id)) }

  /** Build host options before native-open error wrapping, preserving validation failures as parameter errors. */
  private hostOptions(): Omit<PiHostOpenOptions, 'mode'> {
    const { params } = this
    const tools = permissionTools(this.permissionMode())
    return {
      cwd: params.cwd, persist: this.adapter.persist && this.adapter.profile.resume,
      ...(this.model ? { model: this.model } : {}),
      ...(typeof this.config.thinkingLevel === 'string' ? { thinkingLevel: this.config.thinkingLevel } : {}),
      ...(tools ? { tools } : {}),
      ...(params.instructions ? { instructions: params.instructions } : {}),
      ...(this.adapter.options.agentDir ? { agentDir: this.adapter.options.agentDir } : {}),
      ...(this.adapter.options.sessionDir ? { sessionDir: this.adapter.options.sessionDir } : {}),
    }
  }
  /** Acquire a new, resumed or forked host; open publishes its binding only after acquisition succeeds. */
  private async acquireHost({ common, factory }: { common: Omit<PiHostOpenOptions, 'mode'>; factory: PiHostFactory }): Promise<PiSessionHost> {
    const { params } = this
    if (params.mode === 'fork') {
      if (!this.adapter.profile.fork || !common.persist) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Pi fork requires persisted sessions')
      const fork = params.fork
      if (!fork?.nativeRef?.value) throw new HarnessSdkError('SESSION_NOT_FOUND')
      return this.forkHost({ sourceId: fork.nativeRef.value, boundary: fork.boundary, factory, common })
    }
    if (params.mode === 'resume') {
      const id = params.binding.nativeRef?.value
      if (!id || !this.adapter.profile.resume || !common.persist) throw new HarnessSdkError('SESSION_NOT_FOUND')
      const host = await factory({ ...common, mode: 'resume', sessionId: id })
      this.turns = this.adapter.turnMaps.get(id) ?? new Map()
      return host
    }
    return factory({ ...common, mode: 'new' })
  }
  /** Resolve config before the open request's permission mode; omission keeps native host defaults. */
  private permissionMode(): string | undefined {
    const value = this.config.permissionMode ?? this.params.permissionMode
    assertPermissionMode(value)
    return value === undefined ? undefined : String(value)
  }

  /** Fork a verified turn boundary, releasing only a temporarily resumed source, even when forking fails. */
  private async forkHost({ sourceId, boundary, factory, common }: {
    sourceId: string
    boundary: Boundary
    factory: PiHostFactory
    common: Omit<PiHostOpenOptions, 'mode'>
  }): Promise<PiSessionHost> {
    const live = this.adapter.liveHost(sourceId)
    const source = live ?? await factory({ ...common, mode: 'resume', sessionId: sourceId })
    try {
      const turns = this.adapter.turnMaps.get(sourceId) ?? new Map<string, string>()
      const entries = source.entries()
      const starts = turnStarts(entries, turns)
      const startId = boundary.nativeTurnId ?? [...turns].find(([, turn]) => turn === boundary.turnId)?.[0]
      if (!startId || !starts.has(startId)) throw new HarnessSdkError('TURN_NOT_FOUND', 'No verified native turn boundary')
      const index = entries.findIndex(entry => entry.id === startId)
      const leaf = forkLeaf(entries, starts, index, boundary.relation)
      const forked = await source.fork(leaf)
      this.turns = new Map([...turns].filter(([entryId]) => entries.findIndex(entry => entry.id === entryId) <= entries.findIndex(entry => entry.id === leaf)))
      return forked
    } finally { if (!live) await source.dispose().catch(() => {}) }
  }

  /**
   * The listener registered by open appends host callbacks here without blocking Pi. Await each
   * handler in arrival order; skip queued work after close and fail observation on mapping/publication
   * rejection. Disposal unsubscribes but does not drain this tail or fabricate a terminal.
   */
  private enqueue(event: PiHostEvent): void {
    this.tail = this.tail.then(() => this.closed ? undefined : this.handle(event)).catch(cause => this.sink.fail(sdkError(cause, 'PI_EVENT_FAILED', true)).catch(() => {}))
  }
  /** Return detached mutable state for config receipts and post-terminal publication; capability identity is shared. */
  private snapshot(): SessionState {
    return {
      ...(this.title !== undefined ? { metadata: { title: this.title } } : {}),
      binding: structuredClone(this.binding), status: this.active ? 'running' : 'ready', config: structuredClone(this.config),
      capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, ...(this.model ? { model: this.model } : {}),
      activeTurnIds: this.active ? [this.active.id] : [],
    }
  }
  private scope() { return this.active ? { turnId: this.active.id } : {} }
  /** Publish a new turn before binding pending inputs; retries/continuations reuse the active turn until settlement. */
  private async beginTurn(): Promise<ActiveTurn> {
    if (this.active) return this.active
    this.active = { id: randomUUID(), assistant: 0, items: new Map(), messages: [], firstUserSeen: false }
    await this.sink.emit({ type: 'turn/started', payload: { turnId: this.active.id } })
    for (const submissionId of this.pending.splice(0)) await this.sink.bindSubmission(submissionId, this.active.id)
    return this.active
  }
  /** Route serialized callbacks; agent_end alone is nonterminal because native retries or continuations may follow. */
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
      case 'tool_start': return this.startTool(event)
      case 'tool_update': return this.updateTool(event)
      case 'tool_end': return this.endTool(event)
      case 'compaction_start': return this.startCompaction(event)
      case 'compaction_end': return this.endCompaction(event)
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
      case 'settled': return this.settle(event.aborted)
    }
  }
  /** Start tool items only at execution, when Pi has finalized the name and arguments. */
  private async startTool(event: Extract<PiHostEvent, { type: 'tool_start' }>): Promise<void> {
    const active = await this.beginTurn()
    const item = toolItem(this.redact, event.id, event.name, event.args, 'running')
    active.items.set(item.id, item)
    await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId: active.id })
  }
  /** Ignore updates without a running turn's matching tool item; publish redacted output deltas otherwise. */
  private async updateTool(event: Extract<PiHostEvent, { type: 'tool_update' }>): Promise<void> {
    const active = this.active, previous = active?.items.get(event.id)
    if (!active || previous?.type !== 'toolCall') return
    const text = this.redact.text(typeof event.partial === 'string' ? event.partial : contentText((event.partial as { content?: never })?.content ?? ''))
    await this.sink.emit({ type: 'item/delta', payload: { itemId: event.id, kind: 'output', text } }, { turnId: active.id })
  }
  /** Complete only tool items already observed in the active turn. */
  private async endTool(event: Extract<PiHostEvent, { type: 'tool_end' }>): Promise<void> {
    const active = this.active, previous = active?.items.get(event.id)
    if (!active || previous?.type !== 'toolCall') return
    const item = completeTool(this.redact, previous, event.result, event.isError)
    active.items.set(item.id, item)
    await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
  }
  /** Outside a turn, report compaction as a notice because item events require a turn scope. */
  private async startCompaction(event: Extract<PiHostEvent, { type: 'compaction_start' }>): Promise<void> {
    const active = this.active
    if (!active) { await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'PI_COMPACTION_STARTED', message: `Pi compaction started (${event.reason})` } }); return }
    const id = `${active.id}:compaction:${++this.compactions}`
    await this.sink.emit({ type: 'item/started', payload: { item: { id, type: 'compaction', status: 'running', trigger: event.reason } } }, { turnId: active.id })
  }
  /** Match the latest compaction item inside a turn, or publish an unscoped completion/failure notice. */
  private async endCompaction(event: Extract<PiHostEvent, { type: 'compaction_end' }>): Promise<void> {
    const active = this.active, failed = event.aborted || !!event.errorMessage
    if (!active) { await this.sink.emit({ type: 'notice', payload: { severity: failed ? 'warning' : 'info', code: failed ? 'PI_COMPACTION_FAILED' : 'PI_COMPACTION_COMPLETED', message: `Pi compaction ${failed ? 'did not complete' : 'completed'} (${event.reason})` } }); return }
    const item: Item = { id: `${active.id}:compaction:${this.compactions}`, type: 'compaction', status: failed ? 'failed' : 'completed', trigger: event.reason, ...(event.summary ? { summary: this.redact.text(event.summary) } : {}) }
    await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
  }
  /** Native settlement completes the active turn, or rejects inputs that never acquired an execution. */
  private async settle(aborted: boolean): Promise<void> {
    if (this.active) await this.finishTurn(aborted)
    else for (const submissionId of this.pending.splice(0)) {
      await this.sink.emit({ type: 'submission/status', payload: { submissionId, status: 'rejected', error: { code: 'NATIVE_INPUT_NOT_EXECUTED', message: 'Input ended without an execution', retryable: false, outcomeUnknown: false } } })
    }
  }
  private itemId(active: ActiveTurn, index: number): string { return `${active.id}:a${active.assistant}:${index}` }
  /** Accumulate streamed text/reasoning with stable item ids; final text completion waits for message_end to select its phase. */
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
      const previous = active.items.get(id)
      const text = part?.type === 'thinking' ? part.thinking : previous?.type === 'reasoning' ? previous.text ?? '' : ''
      const item: Item = { id, type: 'reasoning', status: 'completed', text: this.redact.text(text) }
      active.items.set(id, item)
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id })
    }
    // text completion waits for message_end, when the final/commentary phase is known
  }
  /**
   * Associate the first new user entry with this turn, then retain assistant usage/error outcomes
   * and publish final text items. Successful assistant continuations clear earlier attempt failures;
   * tool calls become items only when their execution starts.
   */
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
  /**
   * Complete unfinished tool items, then publish usage, the terminal and ready state in order.
   * Native interruption takes precedence over a recorded failure. Clear active state before terminal
   * publication so the emitted snapshot is ready; publication failures flow to enqueue's sink failure.
   */
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

  /**
   * Reserve idle input before prompt can emit events; remove that reservation on rejection or
   * extension handling. Busy inputs use followUp/steer and join an active turn or wait for binding.
   * A handled input is accepted without inventing an execution. Native failures use sdkError with
   * PI_SUBMIT_FAILED as fallback; output-schema policy belongs to the SDK wrapper before dispatch.
   */
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
  /**
   * Validate every requested option before applying model, thinking and tools in order, then publish
   * and return the new state. Host mutation failures use sdkError with PI_CONFIG_FAILED and an
   * unknown-outcome default. Earlier mutations are not rolled back; config/revision commit only
   * after all host calls succeed.
   */
  private async setConfig(patch: JsonObject): Promise<SessionState> {
    for (const key of Object.keys(patch)) if (!this.capabilities.config?.options.some(option => option.id === key)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Unknown Pi config option')
    const models = patch.model !== undefined || patch.thinkingLevel !== undefined ? await this.host.listModels() : []
    if (patch.model !== undefined && (typeof patch.model !== 'string' || !models.some(model => model.ref === patch.model))) throw new HarnessSdkError('INVALID_PARAMS', 'Model is not available in Pi')
    if (patch.thinkingLevel !== undefined) {
      const target = models.find(model => model.ref === (patch.model ?? this.model ?? this.host.model))
      const levels = target?.thinkingLevels ?? this.host.availableThinkingLevels()
      if (typeof patch.thinkingLevel !== 'string' || !levels.includes(patch.thinkingLevel)) throw new HarnessSdkError('INVALID_PARAMS', 'Thinking level is not available for this model')
    }
    assertPermissionMode(patch.permissionMode)
    const tools = permissionTools(patch.permissionMode)
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
  /**
   * Return detached pages of a redacted active-branch snapshot; reuse snapshotToken with nextCursor.
   * New reads retain the configured history suffix and evict the oldest of eight snapshots. Pages default to 200 items, capped at
   * 1000; invalid offsets reject CURSOR_INVALID and unavailable tokens reject CURSOR_EXPIRED.
   */
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
}

/** Backend opening and config updates share this check so unsupported modes always fail with INVALID_PARAMS. */
function assertPermissionMode(value: unknown): void {
  if (value === undefined) return
  if (!(PERMISSION_MODES as readonly string[]).includes(String(value))) throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Pi permission mode')
}

/** Select the parent before a turn or the last entry before the next verified turn begins. */
function forkLeaf(entries: PiHostEntry[], starts: Set<string>, index: number, relation: Boundary['relation']): string | null {
  if (relation === 'before') return entries[index]!.parentId
  const next = entries.findIndex((entry, position) => position > index && starts.has(entry.id))
  return entries[(next >= 0 ? next : entries.length) - 1]!.id
}

/** Mutable execution state owned by the serialized event tail from beginTurn through finishTurn. */
interface ActiveTurn {
  id: string
  /** Pi assistant messages seen so far; item ids derive from this counter. */
  assistant: number
  items: Map<string, Item>
  messages: PiHostMessage[]
  lastAssistant?: PiHostMessage
  firstUserSeen: boolean
  error?: ReturnType<typeof piTurnError>
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Read the first numeric release triple, treating unparseable versions as the baseline. */
const versionParts = (version: string): [number, number, number] => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
}
/** Compare release triples only; prerelease/build suffixes do not change capability selection. */
const compareVersion = (a: string, b: string): number => {
  const left = versionParts(a), right = versionParts(b)
  for (let index = 0; index < 3; index++) if (left[index]! !== right[index]!) return left[index]! - right[index]!
  return 0
}
/** Apply persistence policy to native resume/fork support; schema support is added separately by the SDK output wrapper. */
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
