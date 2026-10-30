import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import { randomUUID } from 'node:crypto'
import {
  negotiateVersion, publicInteraction, type ApprovalOption, type Capabilities, type AhpRequestMap, type AhpResultMap,
  type GoalState, type HistoryItem, type HistoryPage, type InitializeParams, type InitializeResult,
  type InteractionRequested, type InteractionResponse, type Item, type JsonObject, type SessionBinding,
  type SessionOpenParams, type SessionState, type Usage,
} from '@anureo/protocol'
import { HarnessSdkError, type BackendSession, type HarnessAdapter, type SessionEventSink, type SessionMethod } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess, type HarnessProcessOptions } from '@anureo/sdk/process'
import { CodexJsonlClient, CodexRpcError, record, string, type JsonlOptions, type NativeRecord, type NativeRequest } from './jsonl'
import { json, mapItems, mapUsage, mapTurnError, nativeInput, safe } from './mapping'
export { CodexJsonlClient, CodexRpcError } from './jsonl'
export { mapItems, mapUsage } from './mapping'

/** One `model/list` entry with the picker metadata Anureo keeps (hidden models are requested too). */
export type CodexModel = {
  id: string; name: string
  isDefault?: boolean; hidden?: boolean
  efforts?: Array<{ id: string; description?: string }>
  defaultEffort?: string
  /** Service tiers the model accepts; 'priority' is Codex's fast tier. */
  serviceTiers?: string[]
}

export interface CodexAdapterOptions extends JsonlOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Explicit binary version from a trusted host probe, primarily for injected transports. */
  version?: string;
  processFactory?: (options: HarnessProcessOptions) => Promise<HarnessProcess>;
  diagnostic?: (code: string) => void;
  maxHistoryItems?: number;
}
const versionNumber = (value: string) => /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$|[-+])/.exec(value)?.[1] ?? value
const PERMISSION_MODES = ['read-only', 'agent', 'agent-full-access'] as const
function permissionSettings(value: unknown): { approvalPolicy: string; sandbox: string; sandboxPolicy: JsonObject } | undefined {
  if (value === undefined) return undefined
  switch (value) {
    case 'read-only': return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
    case 'agent': return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }
    case 'agent-full-access': return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    default: throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Codex permission mode')
  }
}
/**
 * Native behaviour per Codex line. A version uses the newest profile whose `since` it reaches, so a
 * patch or newer release keeps working; `verified` is only true for the exact versions in VERIFIED_VERSIONS.
 */
export type CodexProfile = {
  since: string
  fork: Array<'before' | 'through'>
  /** thread/read (0.148) or thread/turns/list (0.164+) for full turn snapshots. */
  turns: 'thread/read' | 'thread/turns/list'
  /** thread/rollback(numTurns) or thread/revert(beforeTurnId). */
  revert: 'thread/rollback' | 'thread/revert'
  /** Paged thread/items/list, or history rebuilt from turns. */
  history: 'thread/items/list' | 'turns'
  /** Live session settings: thread/settings/update, or per-turn overrides applied to the next turn. */
  settings: 'thread/settings/update' | 'per-turn'
}
const CODEX_PROFILES: CodexProfile[] = [
  { since: '0.148.0', fork: ['through'], turns: 'thread/read', revert: 'thread/rollback', history: 'turns', settings: 'per-turn' },
  { since: '0.164.0', fork: ['before', 'through'], turns: 'thread/turns/list', revert: 'thread/revert', history: 'thread/items/list', settings: 'thread/settings/update' },
]
/** Exact versions checked against the pinned native schema. Anything else runs on a profile but is reported unverified. */
const VERIFIED_VERSIONS: readonly string[] = ['0.148.0', '0.164.0']
const compareVersions = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}
export function resolveCodexProfile(version: string): { profile?: CodexProfile; verified: boolean } {
  const profile = [...CODEX_PROFILES].reverse().find(item => compareVersions(version, item.since) >= 0)
  return { profile, verified: profile !== undefined && VERIFIED_VERSIONS.includes(version) }
}

/** Anureo's fastMode boolean maps to Codex's priority service tier; standard speed is the thread default (null). */
const FAST_TIER = 'priority'
const serviceTierFor = (fast: unknown) => fast === true ? FAST_TIER : null

export function codexCapabilities(version: string): Capabilities {
  const { profile } = resolveCodexProfile(version)
  // Below the oldest profile nothing is known about the native schema: publish only the safe baseline.
  if (!profile) return {
    session: { resume: false, fork: [], revert: [], history: false },
    turn: { interrupt: true, steer: false, outputSchema: false, inputModalities: ['text', 'image', 'file'], overrides: [] },
    interactions: ['approval'],
    config: { options: [] },
  }
  // The baseline and the optional native methods are open for any profiled version. A method the
  // runtime rejects as method-not-found is closed at call time (see `optional`), not by version number.
  return {
    session: { resume: true, fork: profile.fork, revert: ['conversation'], history: true },
    turn: { interrupt: true, steer: true, outputSchema: true, inputModalities: ['text', 'image', 'file'], overrides: ['model','effort','summary','approvalPolicy','sandboxPolicy','serviceTier'] },
    goal: { actions: ['set','clear'] as ['set','clear'] }, compact: true, review: true, subagents: { events: 'nested' as const },
    interactions: ['approval','userInput','elicitation','dynamicTool'],
    config: { options: [
      { id: 'permissionMode', title: 'Permissions', scope: 'session', schema: { type: 'string', enum: [...PERMISSION_MODES] } },
      ...['model','effort','summary','approvalPolicy'].map(id => ({ id, scope: 'session' as const, schema: { type: 'string' } })),
      { id: 'fastMode', title: 'Fast mode', scope: 'session' as const, schema: { type: 'boolean', default: false } },
    ] },
  }
}
async function probeVersion(options: CodexAdapterOptions): Promise<string> {
  if (options.version) return versionNumber(options.version)
  const process = await (options.processFactory ?? spawnHarnessProcess)({ command: options.command, args: ['--version'], cwd: options.cwd, env: options.env })
  try {
    const read = async () => {
      const decoder = new TextDecoder(); let output = ''
      for await (const chunk of process.stdout) { output += decoder.decode(chunk, { stream: true }); if (output.length > 4096) throw new HarnessSdkError('PROTOCOL_ERROR') }
      const exit = await process.exited
      if (exit.code !== 0) throw new HarnessSdkError('HARNESS_UNAVAILABLE')
      return versionNumber(output.trim())
    }
    return await Promise.race([read(), new Promise<string>((_, reject) => { const timeout = setTimeout(() => reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Codex version probe timed out')), options.timeoutMs ?? 30_000); timeout.unref?.() })])
  } finally { await process.dispose() }
}

async function readAccountStatus(client: CodexJsonlClient): Promise<'unknown'|'required'|'ready'> {
  try {
    const response = record(await client.request('account/read', { refreshToken: false }))
    if (response.requiresOpenaiAuth === false) return 'ready'
    if (typeof record(response.account).type === 'string' && String(record(response.account).type).trim()) return 'ready'
    if (response.account === null && response.requiresOpenaiAuth === true) return 'required'
    throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid native account status')
  } catch (cause) {
    if (cause instanceof CodexRpcError && cause.rpcCode === -32601) return 'unknown'
    // This read precedes turn dispatch; its failure cannot make the turn uncertain.
    if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false, cause.details)
    throw cause
  }
}

export class CodexNativeAdapter implements HarnessAdapter {
  private version = ''
  private clientInfo?: InitializeParams['clientInfo']
  private initialized?: Promise<InitializeResult>
  private readonly sessions = new Set<CodexBackendSession>()
  constructor(readonly options: CodexAdapterOptions) {}
  initialize(params: InitializeParams): Promise<InitializeResult> {
    negotiateVersion(params.protocolVersions)
    return this.initialized ??= (async () => {
      this.version = await probeVersion(this.options); this.clientInfo = params.clientInfo
      // Read-only version/handshake is safe. No mutating method is used to discover optional support.
      return { protocolVersion: 1, runtime: { name: 'codex', version: this.version, adapter: 'codex-native/0.1.0' }, capabilities: codexCapabilities(this.version) }
    })()
  }
  /** Read-only model discovery uses a short-lived native process and never creates a thread. */
  async listModels(cwd = this.options.cwd): Promise<CodexModel[]> {
    const child = await (this.options.processFactory ?? spawnHarnessProcess)({ command: this.options.command, args: this.options.args ?? ['app-server'], cwd, env: this.options.env })
    const client = new CodexJsonlClient(child, {
      notification: async () => {}, request: async (_request, _reply, reject) => { await reject(-32601, 'No interactive surface during model discovery') },
      failure: async () => {}, diagnostic: this.options.diagnostic,
    }, this.options)
    try {
      await client.request('initialize', { clientInfo: this.clientInfo ?? { name: 'anureo-harness-models', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      await client.notify('initialized')
      return await readCodexModels(client)
    } finally { await client.dispose() }
  }
  /** Read-only account metadata from this runtime's explicit environment/home. */
  async readAuthStatus(): Promise<'unknown'|'required'|'ready'> {
    const child = await (this.options.processFactory ?? spawnHarnessProcess)({ command: this.options.command, args: this.options.args ?? ['app-server'], cwd: this.options.cwd, env: this.options.env })
    const client = new CodexJsonlClient(child, { notification: async () => {}, request: async (_request, _reply, reject) => { await reject(-32601, 'Account status is non-interactive') }, failure: async () => {} }, this.options)
    try {
      await client.request('initialize', { clientInfo: { name: 'anureo-harness-auth', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      await client.notify('initialized')
      return await readAccountStatus(client)
    } catch (cause) {
      if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false, cause.details)
      throw cause
    } finally { await client.dispose() }
  }
  /** Reconciliation never resumes or mutates a thread; absent live evidence remains unknown. */
  async inspectExecution(binding: SessionBinding, nativeTurnId?: string, cwd = this.options.cwd): Promise<{ stopped: false } | { stopped: true; status: 'completed'|'interrupted'|'failed'; turnId: string }> {
    if (!nativeTurnId || binding.nativeRef?.provider !== 'codex') return { stopped: false }
    const child = await (this.options.processFactory ?? spawnHarnessProcess)({ command: this.options.command, args: this.options.args ?? ['app-server'], cwd, env: this.options.env })
    const client = new CodexJsonlClient(child, { notification: async () => {}, request: async (_request, _reply, reject) => { await reject(-32601, 'Reconciliation is non-interactive') }, failure: async () => {}, diagnostic: this.options.diagnostic }, this.options)
    try {
      await client.request('initialize', { clientInfo: this.clientInfo ?? { name: 'anureo-harness-reconcile', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      await client.notify('initialized')
      const response = record(await client.request('thread/read', { threadId: binding.nativeRef.value, includeTurns: true }))
      const thread = record(response.thread)
      if (thread.id !== binding.nativeRef.value || record(thread.status).type !== 'idle' || !Array.isArray(thread.turns)) return { stopped: false }
      const turns = thread.turns.map(record)
      if (turns.some(turn => !['completed','interrupted','failed'].includes(String(turn.status)))) return { stopped: false }
      const target = turns.find(turn => turn.id === nativeTurnId)
      if (!target || !['completed','interrupted','failed'].includes(String(target.status))) return { stopped: false }
      return { stopped: true, status: target.status as 'completed'|'interrupted'|'failed', turnId: nativeTurnId }
    } catch { return { stopped: false } }
    finally { await client.dispose() }
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (!this.clientInfo) throw new HarnessSdkError('NOT_INITIALIZED')
    const capabilities = codexCapabilities(this.version)
    const native = resolveCodexProfile(this.version)
    if (params.mode === 'resume' && !capabilities.session?.resume || params.mode === 'fork' && !capabilities.session?.fork?.includes(params.fork!.boundary.relation)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    let source: CodexBackendSession | undefined
    if (params.mode === 'fork') {
      source = [...this.sessions].find(session => session.binding.sessionId === params.fork!.sourceSessionId)
      const nativeTurnId = params.fork!.boundary.nativeTurnId ?? source?.resolveNativeTurn(params.fork!.boundary.turnId)
      if (!nativeTurnId) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED')
      params = { ...params, fork: { ...params.fork!, boundary: { ...params.fork!.boundary, nativeTurnId } } }
    }
    const process = await (this.options.processFactory ?? spawnHarnessProcess)({ command: this.options.command, args: this.options.args ?? ['app-server'], cwd: params.cwd, env: this.options.env })
    const session = new CodexBackendSession(params, sink, { profile: native.profile ?? CODEX_PROFILES[0]!, verified: native.verified }, capabilities, this.options)
    if (source) session.importTurnMap(source)
    const client = new CodexJsonlClient(process, {
      notification: (method, values) => session.notification(method, values),
      request: (request, reply, reject) => session.serverRequest(request, reply, reject),
      failure: cause => session.failure(cause), diagnostic: this.options.diagnostic,
    }, this.options)
    session.attach(client)
    try {
      await client.request('initialize', { clientInfo: this.clientInfo, capabilities: { experimentalApi: true } })
      await client.notify('initialized')
      await session.open()
      this.sessions.add(session); return session
    } catch (cause) { await client.dispose(); throw cause }
  }
  async dispose(): Promise<void> { await Promise.all([...this.sessions].map(session => session.dispose())); this.sessions.clear() }
}
export function createCodexAdapter(options: CodexAdapterOptions): CodexNativeAdapter { return new CodexNativeAdapter(options) }

class CodexBackendSession implements BackendSession {
  binding: SessionBinding
  readonly capabilities: Capabilities
  private client!: CodexJsonlClient
  private threadId = ''
  private active?: { canonical: string; native?: string }
  private turnMap = new Map<string, string>()
  private nativeMap = new Map<string, string>()
  private started = new Set<string>()
  private items = new Set<string>()
  private executionOutput = new Map<string, string>()
  private itemStartedAt = new Map<string, string>()
  private state: SessionState
  private history = new Map<string, HistoryItem[]>()
  private lastUsage?: Usage
  private plan?: Item
  private maintenanceTurns = new Set<string>()
  private maintenance?: { resolve(): void; reject(cause: unknown): void; timer: ReturnType<typeof setTimeout> }
  private closing = false
  private unverifiedNoticed = false
  private capabilityRevision = 1
  constructor(private readonly params: SessionOpenParams, private readonly sink: SessionEventSink, private readonly native: { profile: CodexProfile; verified: boolean }, capabilities: Capabilities, private readonly options: CodexAdapterOptions) {
    this.binding = structuredClone(params.binding); this.capabilities = structuredClone(capabilities)
    const model = params.model ?? string(params.config?.model)
    this.state = { binding: this.binding, status: 'ready', config: params.config ?? {}, capabilities: this.capabilities, capabilityRevision: 1, ...(model ? { model } : {}) }
  }
  attach(client: CodexJsonlClient): void { this.client = client }
  resolveNativeTurn(canonical: string): string | undefined { return this.nativeMap.get(canonical) }
  importTurnMap(source: CodexBackendSession): void { this.turnMap = new Map(source.turnMap); this.nativeMap = new Map(source.nativeMap) }
  async open(): Promise<void> {
    const config: NativeRecord = { ...(this.params.config ?? {}) }
    const mode = config.permissionMode ?? (PERMISSION_MODES.includes(this.params.permissionMode as typeof PERMISSION_MODES[number]) ? this.params.permissionMode : undefined)
    const permissions = permissionSettings(mode)
    if (typeof mode === 'string') this.state.config = { ...this.state.config, permissionMode: mode }
    delete config.permissionMode
    if (permissions) { config.sandbox_mode = permissions.sandbox; config.approval_policy = permissions.approvalPolicy }
    if (this.params.mcpServers) config.mcp_servers = Object.fromEntries(this.params.mcpServers.map(server => [server.name, server.type === 'stdio' ? { command: server.command, args: server.args ?? [], env: server.env ?? {} } : { url: server.url, http_headers: server.headers ?? {} }]))
    const fastMode = config.fastMode; delete config.fastMode
    const common = { cwd: this.params.cwd, ...(fastMode !== undefined ? { serviceTier: serviceTierFor(fastMode) } : {}), ...(this.params.model ? { model: this.params.model } : {}), ...(this.params.instructions ? { developerInstructions: this.params.instructions } : {}), config, ...(this.params.permissionMode ? { approvalPolicy: this.params.permissionMode } : {}), ...(permissions ? { approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox } : {}) }
    let result: unknown
    if (this.params.mode === 'new') result = await this.client.request('thread/start', common)
    else if (this.params.mode === 'resume') {
      this.threadId = this.params.binding.nativeRef!.value
      result = await this.client.request('thread/resume', { ...common, threadId: this.threadId })
    } else {
      const fork = this.params.fork!
      const nativeId = fork.boundary.nativeTurnId
      if (!nativeId) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED', 'Fork requires a resolved native turn identity')
      const sourceNative = fork.nativeRef?.value ?? this.params.binding.nativeRef?.value
      if (!sourceNative) throw new HarnessSdkError('SESSION_NATIVE_REF_REQUIRED', 'Fork requires the source native reference')
      result = await this.client.request('thread/fork', { ...common, threadId: sourceNative, ...(fork.boundary.relation === 'before' ? { beforeTurnId: nativeId } : { lastTurnId: nativeId }) })
    }
    this.threadId = string(record(record(result).thread).id) ?? this.threadId
    if (!this.threadId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native thread identity missing')
    this.binding = { ...this.binding, nativeRef: { provider: 'codex', value: this.threadId } }
    this.state.binding = this.binding
    const thread = record(record(result).thread)
    if (typeof thread.name === 'string' || thread.name === null) this.state.metadata = { title: thread.name }
    if (this.state.metadata) await this.sink.emit({ type: 'session/metadata', payload: this.state.metadata })
  }
  private nativeTurn(canonical: string, provided?: string): string {
    const native = provided ?? this.nativeMap.get(canonical)
    if (!native) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED', 'Native turn identity is not known')
    return native
  }
  private canonicalTurn(native: string): string {
    const known = this.turnMap.get(native)
    if (known) return known
    if (this.active && !this.active.native) {
      this.active.native = native; this.turnMap.set(native, this.active.canonical); this.nativeMap.set(this.active.canonical, native); this.state.status = 'running'; this.state.activeTurnId = this.active.canonical; return this.active.canonical
    }
    return native
  }
  private async ensureStarted(nativeId: string): Promise<string> {
    const turnId = this.canonicalTurn(nativeId)
    if (!this.started.has(turnId)) { this.started.add(turnId); await this.sink.emit({ type: 'turn/started', payload: { turnId, nativeTurnId: nativeId } }, { turnId }) }
    return turnId
  }
  private scope(params: NativeRecord): string | undefined { const native = string(params.turnId); return native ? this.canonicalTurn(native) : this.active?.canonical }
  private async optional<T>(method: string, params: NativeRecord, disable: () => void): Promise<T> {
    try { return await this.client.request<T>(method, params) }
    catch (cause) {
      if (cause instanceof CodexRpcError && cause.rpcCode === -32601) {
        disable(); this.state.capabilityRevision = ++this.capabilityRevision; this.state.capabilities = this.capabilities
        await this.sink.emit({ type: 'session/state', payload: structuredClone(this.state) })
        throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
      }
      throw cause
    }
  }
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    let result: AhpResultMap[SessionMethod]
    const p = params as AhpRequestMap[SessionMethod]
    switch (method) {
      case 'turn/start': {
        const start = p as AhpRequestMap['turn/start']
        if (await readAccountStatus(this.client) === 'required') throw new HarnessSdkError('AUTH_REQUIRED', 'Sign in to the independent Codex runtime before sending')
        if (!this.native.verified && !this.unverifiedNoticed) { this.unverifiedNoticed = true; await this.sink.emit({ type: 'notice', payload: { severity: 'warning', code: 'CODEX_VERSION_UNVERIFIED', message: `Codex ${this.native.profile.since}+ behaviour is used for this version; it has not been verified against the native schema.` } }) }
        this.active = { canonical: start.turnId }; this.lastUsage = undefined
        try {
          const permissions = permissionSettings(this.state.config.permissionMode)
          const value = record(await this.client.request('turn/start', { ...Object.fromEntries(Object.entries(this.state.config).filter(([key]) => this.capabilities.turn?.overrides?.includes(key))), ...(permissions ? { approvalPolicy: permissions.approvalPolicy, sandboxPolicy: permissions.sandboxPolicy } : {}), ...('fastMode' in this.state.config ? { serviceTier: serviceTierFor(this.state.config.fastMode) } : {}), ...start.overrides, threadId: this.threadId, input: nativeInput(start.input), ...(start.outputSchema !== undefined ? { outputSchema: start.outputSchema } : {}) }))
          const native = string(record(value.turn).id)
          if (!native) throw new HarnessSdkError('PROTOCOL_ERROR')
          await this.ensureStarted(native)
          result = { turnId: start.turnId, accepted: true }
        } catch (cause) { if (!(cause instanceof HarnessSdkError && cause.outcomeUnknown)) this.active = undefined; throw cause }
        break
      }
      case 'turn/steer': {
        const steer = p as AhpRequestMap['turn/steer']; const native = this.nativeTurn(steer.expectedTurnId)
        const response = record(await this.optional('turn/steer', { threadId: this.threadId, expectedTurnId: native, input: nativeInput(steer.input) }, () => { this.capabilities.turn!.steer = false }))
        if (response.turnId !== native) throw new HarnessSdkError('TURN_MISMATCH', 'Native steer did not target the same turn', false, true)
        result = { turnId: steer.expectedTurnId, accepted: true }; break
      }
      case 'turn/interrupt': {
        const interrupt = p as AhpRequestMap['turn/interrupt']
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.nativeTurn(interrupt.turnId) })
        result = { accepted: true, turnId: interrupt.turnId }; break
      }
      case 'session/config/set': {
        const patch = (p as AhpRequestMap['session/config/set']).patch
        const permissions = permissionSettings(patch.permissionMode)
        const nativePatch: NativeRecord = { ...patch }; delete nativePatch.permissionMode
        if (patch.fastMode !== undefined) {
          if (typeof patch.fastMode !== 'boolean') throw new HarnessSdkError('INVALID_PARAMS')
          nativePatch.serviceTier = serviceTierFor(patch.fastMode); delete nativePatch.fastMode
        }
        if (permissions) { nativePatch.approvalPolicy = permissions.approvalPolicy; nativePatch.sandboxPolicy = permissions.sandboxPolicy }
        if (this.native.profile.settings === 'thread/settings/update') await this.optional('thread/settings/update', { ...nativePatch, threadId: this.threadId }, () => { this.capabilities.config = { options: [] } })
        // 0.148 has no thread/settings/update; its native per-turn settings apply to subsequent turns.
        this.state.config = { ...this.state.config, ...patch }; this.state.capabilityRevision = this.capabilityRevision
        if (typeof patch.model === 'string') this.state.model = patch.model
        result = structuredClone(this.state); break
      }
      case 'session/revert': result = await this.revert(p as AhpRequestMap['session/revert']); break
      case 'history/read': result = await this.readHistory(p as AhpRequestMap['history/read']); break
      case 'goal/set': {
        const value = record(await this.optional('thread/goal/set', { ...Object.fromEntries(Object.entries((p as AhpRequestMap['goal/set']).goal).filter(([key]) => ['objective','status','tokenBudget'].includes(key))), threadId: this.threadId }, () => { this.capabilities.goal = { actions: [] } }))
        result = { goal: json(value.goal) as JsonObject, status: 'active' }; this.state.goal = result as GoalState; break
      }
      case 'goal/clear': await this.optional('thread/goal/clear', { threadId: this.threadId }, () => { this.capabilities.goal = { actions: [] } }); result = { goal: null, status: 'cleared' }; this.state.goal = result as GoalState; break
      case 'compact/start': {
        const completion = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { this.maintenance = undefined; reject(new HarnessSdkError('REQUEST_TIMEOUT', 'Compaction outcome is unknown', false, true)) }, this.options.timeoutMs ?? 30_000)
          this.maintenance = { resolve, reject, timer }
        })
        void completion.catch(() => {})
        try { await this.optional('thread/compact/start', { threadId: this.threadId }, () => { this.capabilities.compact = false }); await completion }
        catch (cause) { if (this.maintenance) { clearTimeout(this.maintenance.timer); this.maintenance = undefined } throw cause }
        result = { maintenanceId: randomUUID(), status: 'completed' }; break
      }
      case 'review/start': {
        const review = p as AhpRequestMap['review/start']; this.active = { canonical: review.turnId }; this.lastUsage = undefined
        const value = record(await this.optional('review/start', { threadId: this.threadId, target: review.target, delivery: 'inline' }, () => { this.capabilities.review = false }))
        const native = string(record(value.turn).id); if (!native) throw new HarnessSdkError('PROTOCOL_ERROR')
        await this.ensureStarted(native); result = { turnId: review.turnId, accepted: true }; break
      }
      case 'session/close': this.closing = true; await this.client.request('thread/unsubscribe', { threadId: this.threadId }); result = { closed: true }; break
      default: throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') // interaction actions are owned by SDK registry
    }
    return result as AhpResultMap[M]
  }
  private async revert(params: AhpRequestMap['session/revert']): Promise<AhpResultMap['session/revert']> {
    if (params.scope !== 'conversation') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    const native = this.nativeTurn(params.boundary.turnId, params.boundary.nativeTurnId)
    if (this.native.profile.revert === 'thread/revert' && params.boundary.relation === 'before') {
      await this.optional('thread/revert', { threadId: this.threadId, beforeTurnId: native }, () => { this.capabilities.session!.revert = [] })
    } else {
      const turns = await this.turns()
      const index = turns.findIndex(turn => turn.id === native)
      if (index < 0) throw new HarnessSdkError('TURN_NOT_FOUND')
      const remove = turns.length - index - (params.boundary.relation === 'through' ? 1 : 0)
      if (remove > 0) {
        if (this.native.profile.revert === 'thread/revert') await this.optional('thread/revert', { threadId: this.threadId, beforeTurnId: turns[turns.length - remove]!.id }, () => { this.capabilities.session!.revert = [] })
        else await this.optional('thread/rollback', { threadId: this.threadId, numTurns: remove }, () => { this.capabilities.session!.revert = [] })
      }
    }
    this.history.clear(); return { appliedScope: 'conversation', boundary: params.boundary }
  }
  private async turns(): Promise<NativeRecord[]> {
    if (this.native.profile.turns === 'thread/read') {
      const response = record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: true }))
      const turns = record(response.thread).turns
      if (!Array.isArray(turns)) throw new HarnessSdkError('PROTOCOL_ERROR')
      return turns.map(record)
    }
    const turns: NativeRecord[] = []; let cursor: string | undefined
    do {
      const page = record(await this.client.request('thread/turns/list', { threadId: this.threadId, sortDirection: 'asc', limit: 200, ...(cursor ? { cursor } : {}) }))
      if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
      turns.push(...page.data.map(record)); if (turns.length > (this.options.maxHistoryItems ?? 10000)) throw new HarnessSdkError('HISTORY_LIMIT_EXCEEDED')
      cursor = string(page.nextCursor)
    } while (cursor)
    return turns
  }
  private async readHistory(params: AhpRequestMap['history/read']): Promise<HistoryPage> {
    let token = params.snapshotToken
    let offset = 0
    if (params.cursor) {
      try { const parsed = JSON.parse(Buffer.from(params.cursor, 'base64url').toString()) as { token: string; offset: number }; if (token && parsed.token !== token) throw new Error(); token = parsed.token; offset = parsed.offset } catch { throw new HarnessSdkError('CURSOR_INVALID') }
    }
    let items = token ? this.history.get(token) : undefined
    if (token && !items) throw new HarnessSdkError('CURSOR_EXPIRED')
    if (!items) {
      items = []
      if (this.native.profile.history === 'thread/items/list') {
        let cursor: string | undefined
        do {
          const page = record(await this.optional('thread/items/list', { threadId: this.threadId, sortDirection: 'asc', limit: 200, ...(cursor ? { cursor } : {}) }, () => { this.capabilities.session!.history = false }))
          if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
          for (const entry of page.data) { const native = record(entry); const nativeTurnId = string(native.turnId); if (!nativeTurnId) throw new HarnessSdkError('PROTOCOL_ERROR'); for (const item of mapItems(native.item, true, true, { startedAtMs: native.startedAtMs })) items.push({ turnId: this.turnMap.get(nativeTurnId) ?? nativeTurnId, nativeTurnId, nativeItemId: string(record(native.item).id), item }) }
          if (items.length > (this.options.maxHistoryItems ?? 10000)) throw new HarnessSdkError('HISTORY_LIMIT_EXCEEDED')
          cursor = string(page.nextCursor)
        } while (cursor)
      } else for (const turn of await this.turns()) {
        const nativeTurnId = string(turn.id); if (!nativeTurnId || !Array.isArray(turn.items)) continue
        for (const native of turn.items) for (const item of mapItems(native, true, true)) items.push({ turnId: this.turnMap.get(nativeTurnId) ?? nativeTurnId, nativeTurnId, nativeItemId: string(record(native).id), item })
      }
      token = randomUUID(); this.history.set(token, items)
      if (this.history.size > 8) this.history.delete(this.history.keys().next().value!)
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new HarnessSdkError('CURSOR_INVALID')
    const limit = params.limit ?? 200; const end = Math.min(offset + limit, items.length)
    return { items: structuredClone(items.slice(offset, end)), snapshotToken: token!, nextCursor: end < items.length ? Buffer.from(JSON.stringify({ token, offset: end })).toString('base64url') : null, source: this.binding.nativeRef }
  }
  async notification(method: string, params: NativeRecord): Promise<void> {
    if (typeof params.threadId === 'string' && this.threadId && params.threadId !== this.threadId) return
    if (method === 'thread/started') return
    const eventNativeTurn = string(params.turnId) ?? string(record(params.turn).id)
    if (this.maintenance && method === 'turn/started' && eventNativeTurn) this.maintenanceTurns.add(eventNativeTurn)
    if (!this.maintenance && eventNativeTurn && this.maintenanceTurns.has(eventNativeTurn)) { if (method === 'turn/completed') this.maintenanceTurns.delete(eventNativeTurn); return }
    if (method === 'thread/name/updated') {
      const title = typeof params.threadName === 'string' ? params.threadName : null
      if (this.state.metadata?.title !== title) {
        this.state.metadata = { title }
        await this.sink.emit({ type: 'session/metadata', payload: { title } })
      }
      return
    }
    if (this.maintenance && (method === 'thread/compacted' || method === 'turn/completed' || method === 'item/completed' && record(params.item).type === 'contextCompaction')) {
      const wait = this.maintenance; clearTimeout(wait.timer); this.maintenance = undefined; wait.resolve()
      await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'CONTEXT_COMPACTED', message: 'Native context compaction completed' } }); return
    }
    if (this.maintenance && (method === 'turn/started' || method.startsWith('item/'))) return
    if (method === 'turn/started') { const id = string(record(params.turn).id); if (id) await this.ensureStarted(id); return }
    const turnId = this.scope(params)
    if (method === 'turn/completed') {
      const turn = record(params.turn); const native = string(turn.id); if (!native) throw new HarnessSdkError('PROTOCOL_ERROR')
      const canonical = await this.ensureStarted(native)
      const state = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed'
      const nativeError = turn.error ? mapTurnError(turn.error) : state === 'failed' ? mapTurnError({}) : undefined
      if (this.plan) { const item = { ...this.plan, status: 'completed' as const }; this.plan = undefined; await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: canonical, itemId: item.id }) }
      await this.sink.emit({ type: 'turn/completed', payload: { turnId: canonical, status: state, ...(nativeError ? { error: nativeError } : {}), ...(this.lastUsage ? { usage: this.lastUsage } : {}) } }, { turnId: canonical })
      for (const key of this.executionOutput.keys()) if (key.startsWith(`${canonical}\0`)) this.executionOutput.delete(key)
      for (const key of this.itemStartedAt.keys()) if (key.startsWith(`${canonical}\0`)) this.itemStartedAt.delete(key)
      if (this.active?.canonical === canonical) this.active = undefined
      this.state.status = 'ready'; delete this.state.activeTurnId
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native item has no turn')
      const completed = method === 'item/completed'
      for (const sourceItem of mapItems(params.item, completed, false, { startedAtMs: completed ? undefined : params.startedAtMs })) {
        const key = `${turnId}\0${sourceItem.id}`
        // Completed snapshots omit the start time; repeated starts must not reset it.
        const startedAt = this.itemStartedAt.get(key) ?? sourceItem.startedAt
        if (startedAt !== undefined) this.itemStartedAt.set(key, startedAt)
        const timedItem = startedAt !== undefined ? { ...sourceItem, startedAt } : sourceItem
        const item = timedItem.type === 'toolCall' && timedItem.output == null && this.executionOutput.has(key) ? { ...timedItem, output: this.executionOutput.get(key)! } : timedItem
        if (completed) this.executionOutput.delete(key)
        if (!completed && this.items.has(key)) { await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: json(item) } }, { turnId, itemId: item.id }); continue }
        this.items.add(key); await this.sink.emit({ type: completed ? 'item/completed' : 'item/started', payload: { item } }, { turnId, itemId: item.id })
      }
      return
    }
    const deltaKinds: Record<string, 'text'|'reasoningSummary'|'output'|'patch'> = { 'item/agentMessage/delta': 'text', 'item/reasoning/summaryTextDelta': 'reasoningSummary', 'item/reasoning/textDelta': 'reasoningSummary', 'item/commandExecution/outputDelta': 'output', 'item/fileChange/outputDelta': 'output', 'item/plan/delta': 'text' }
    if (deltaKinds[method]) {
      const itemId = string(params.itemId); if (!itemId || !turnId) throw new HarnessSdkError('PROTOCOL_ERROR')
      const key = `${turnId}\0${itemId}`
      if (!this.items.has(key)) { this.items.add(key); await this.sink.emit({ type: 'item/started', payload: { item: method === 'item/fileChange/outputDelta' ? { id: itemId, type: 'toolCall', kind: 'fileChange', title: 'File changes', status: 'running' } : method === 'item/commandExecution/outputDelta' ? { id: itemId, type: 'toolCall', kind: 'command', title: 'Command', status: 'running' } : { id: itemId, type: 'agentMessage', phase: 'commentary', text: '', status: 'running' } } }, { turnId, itemId }) }
      const deltaText = string(params.delta) ?? ''
      if (deltaKinds[method] === 'output') {
        // Bound retained diagnostics independently; they never become patch material.
        const text = (this.executionOutput.get(key) ?? '') + deltaText
        this.executionOutput.set(key, text.length > 64 * 1024 ? text.slice(0, 64 * 1024) + '\n[Execution output truncated]\n' : text)
      }
      await this.sink.emit({ type: 'item/delta', payload: { itemId, kind: deltaKinds[method]!, text: deltaText } }, { turnId, itemId }); return
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = record(params.tokenUsage)
      this.lastUsage = mapUsage(tokenUsage.last, 'turn'); const usage = mapUsage(tokenUsage.total, 'session')
      if (typeof tokenUsage.modelContextWindow === 'number') usage.contextWindow = tokenUsage.modelContextWindow
      await this.sink.emit({ type: 'usage/updated', payload: usage }, { turnId }); return
    }
    if (method === 'turn/plan/updated' && turnId) {
      const id = `plan:${turnId}`
      const item: Item = { id, type: 'plan', status: 'completed', steps: (Array.isArray(params.plan) ? params.plan : []).map((step, i) => { const value = record(step); return { id: `${i}`, text: string(value.step) ?? '', status: value.status === 'completed' ? 'completed' : value.status === 'inProgress' ? 'inProgress' : 'pending' } }) }
      if (!this.plan) { this.plan = { ...item, status: 'running' }; await this.sink.emit({ type: 'item/started', payload: { item: this.plan } }, { turnId, itemId: id }) }
      else { this.plan = item; await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: 'patch', value: json(item) } }, { turnId, itemId: id }) }
      return
    }
    if ((method === 'hook/started' || method === 'hook/completed') && turnId) {
      const hook = record(params.hook ?? params); const id = string(hook.id) ?? string(params.hookId)
      if (id) await this.sink.emit({ type: method === 'hook/started' ? 'item/started' : 'item/completed', payload: { item: { id, type: 'hook', name: string(hook.name) ?? 'hook', status: method === 'hook/started' ? 'running' : 'completed', output: safe(hook.output) } } }, { turnId, itemId: id })
      return
    }
    await this.sink.emit({ type: 'notice', payload: { severity: method === 'error' ? 'error' : 'info', code: 'NATIVE_NOTIFICATION', message: method, raw: safe(params) } }, { turnId })
  }
  async serverRequest(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void> {
    const p = request.params
    if (p.threadId !== this.threadId) { await reject(-32602, 'Unknown thread'); return }
    const turnId = this.scope(p); const itemId = string(p.itemId)
    const id = `codex:${typeof request.id}:${request.id}`
    const common = { interactionId: id, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) }
    let interaction: InteractionRequested
    let encode: (answer: InteractionResponse | null) => unknown
    if (['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(request.method)) {
      const permissions = request.method === 'item/permissions/requestApproval'
      const advertised = Array.isArray(p.availableDecisions) ? p.availableDecisions : ['accept','acceptForSession','decline','cancel']
      const decisions = new Map<string, unknown>()
      const options = advertised.flatMap<ApprovalOption>((decision, i) => {
        if (typeof decision === 'string' && ['accept','acceptForSession','decline','cancel'].includes(decision)) { decisions.set(decision, decision); return [{ id: decision, label: decision, semantic: decision === 'accept' ? 'allowOnce' as const : decision === 'acceptForSession' ? 'allowSession' as const : decision === 'cancel' ? 'cancel' as const : 'deny' as const }] }
        if (record(decision).acceptWithExecpolicyAmendment || record(decision).applyNetworkPolicyAmendment) { const optionId = `rule:${i}`; decisions.set(optionId, decision); return [{ id: optionId, label: 'Apply supplied policy rule', semantic: 'allowWithRule' as const }] }
        return []
      })
      if (!options.length) { await reject(-32602, 'No supported approval decisions'); return }
      interaction = { ...common, kind: 'approval', title: string(p.reason) ?? 'Approval required', options, input: safe({ command: p.command, permissions: p.permissions, cwd: p.cwd }) }
      encode = answer => {
        const decision = answer?.kind === 'approval' ? decisions.get(answer.optionId) : 'cancel'
        if (permissions) return { permissions: decision === 'accept' || decision === 'acceptForSession' ? p.permissions : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
        return { decision: decision ?? 'cancel' }
      }
    } else if (request.method === 'item/tool/requestUserInput') {
      const questions = (Array.isArray(p.questions) ? p.questions : []).map(value => { const q = record(value); return { id: string(q.id) ?? '', prompt: string(q.question) ?? '', secret: q.isSecret === true, options: Array.isArray(q.options) ? q.options.map((option, index) => ({ id: String(index), label: string(record(option).label) ?? '' })) : undefined } })
      interaction = { ...common, kind: 'userInput', questions }
      encode = answer => ({ answers: answer?.kind === 'userInput' ? Object.fromEntries(Object.entries(answer.answers).map(([key, value]) => {
        const q = questions.find(question => question.id === key); const selected = Array.isArray(value) ? value : [value]
        return [key, { answers: selected.map(v => q?.options?.find(option => option.id === v)?.label ?? String(v)) }]
      })) : {} })
    } else if (request.method === 'mcpServer/elicitation/request') {
      // Newer native schemas may carry mode-specific fields through anyOf branches.
      const mode = p.mode === 'url' || typeof p.url === 'string' ? 'url' : 'form'
      interaction = { ...common, kind: 'elicitation', mode, ...(p.requestedSchema ? { schema: json(p.requestedSchema) as JsonObject } : {}), message: string(p.message) ?? 'MCP input required', ...(mode === 'url' ? { privatePayload: { url: string(p.url) ?? '' } } : {}) }
      encode = answer => ({ action: answer?.kind === 'elicitation' ? answer.action : 'cancel', content: answer?.kind === 'elicitation' && answer.action === 'accept' ? answer.content ?? null : null })
    } else if (request.method === 'item/tool/call') {
      interaction = { ...common, kind: 'dynamicTool', toolName: string(p.tool) ?? string(p.name) ?? 'unknown', arguments: json(p.arguments ?? {}) as JsonObject }
      encode = answer => ({ success: answer?.kind === 'dynamicTool' && !answer.isError, contentItems: answer?.kind === 'dynamicTool' ? answer.content.flatMap<NativeRecord>(block => block.type === 'text' ? [{ type: 'inputText', text: block.text }] : block.type === 'image' ? [{ type: 'inputImage', imageUrl: block.url ?? `data:${block.mimeType};base64,${block.data}` }] : []) : [] })
    } else { await reject(-32601, 'Unsupported native request'); return }
    try { await this.sink.requestInteraction(interaction, answer => reply(encode(answer))) }
    catch { /* Registry has already sent non-authorizing cancellation when possible. */ }
  }
  async failure(cause: HarnessSdkError): Promise<void> { if (this.maintenance) { clearTimeout(this.maintenance.timer); this.maintenance.reject(cause); this.maintenance = undefined } if (!this.closing) await this.sink.fail(cause) }
  async dispose(): Promise<void> { this.closing = true; if (this.maintenance) { clearTimeout(this.maintenance.timer); this.maintenance.reject(new HarnessSdkError('RUNTIME_DISPOSED')); this.maintenance = undefined } this.history.clear(); this.executionOutput.clear(); await this.client.dispose() }
}

async function readCodexModels(client: CodexJsonlClient): Promise<CodexModel[]> {
      const models: CodexModel[] = []; let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = record(await client.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) }))
        if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
        for (const entry of page.data) {
          const model = record(entry), id = string(model.id) ?? string(model.model); if (!id) throw new HarnessSdkError('PROTOCOL_ERROR')
          const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.flatMap(item => {
            const option = record(item), effort = string(option.reasoningEffort), description = string(option.description)
            return effort ? [{ id: effort, ...(description ? { description } : {}) }] : []
          }) : undefined
          const defaultEffort = string(model.defaultReasoningEffort)
          const serviceTiers = Array.isArray(model.serviceTiers) ? model.serviceTiers.flatMap(item => string(record(item).id) ?? []) : undefined
          models.push({
            id, name: string(model.displayName) ?? string(model.name) ?? id,
            ...(model.isDefault === true ? { isDefault: true } : {}), ...(model.hidden === true ? { hidden: true } : {}),
            ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}), ...(serviceTiers ? { serviceTiers } : {}),
          })
        }
        if (models.length > 10_000) throw new HarnessSdkError('MODEL_LIMIT_EXCEEDED')
        cursor = string(page.nextCursor)
        if (cursor && seen.has(cursor)) throw new HarnessSdkError('PROTOCOL_ERROR', 'Repeated native model cursor')
        if (cursor) seen.add(cursor)
      } while (cursor)
      return models
}

/** Dedicated read-only directory owner; no thread or turn is ever created here. */
export function createCodexCatalogSession(options: CodexAdapterOptions) {
  let client: CodexJsonlClient | undefined, pending: Promise<void> | undefined, closing: Promise<void> | undefined, disposing: Promise<void> | undefined
  const closeConnection = (): Promise<void> => {
    if (closing) return closing
    const current = client; client = undefined
    return closing = (current?.dispose() ?? Promise.resolve()).finally(() => { closing = undefined })
  }
  const dispose = (): Promise<void> => disposing ??= (async () => {
    await closeConnection()
    await pending?.catch(() => {})
    await closeConnection()
  })().finally(() => { disposing = undefined })
  const guarded = async <T>(context: CatalogProbeOptions, work: () => Promise<T>): Promise<T> => {
    const abort = () => { void dispose().catch(() => {}) }
    if (context.signal?.aborted) throw new HarnessSdkError('RPC_ABORTED')
    context.signal?.addEventListener('abort', abort, { once: true })
    try { return await work() } finally { context.signal?.removeEventListener('abort', abort) }
  }
  const prepare = (context: CatalogProbeOptions = {}): Promise<void> => guarded(context, async () => {
    await disposing; await closing
    if (pending) { await pending; return }
    if (client) return
    let spawned: HarnessProcess | undefined
    await (pending ??= (async () => {
      await catalogPhase(context, 'spawn', async () => { spawned = await (options.processFactory ?? spawnHarnessProcess)({ command: options.command, args: options.args ?? ['app-server'], cwd: options.cwd, env: options.env }) })
      const child = spawned!
      if (context.signal?.aborted) { await child.dispose(); throw new HarnessSdkError('RPC_ABORTED') }
      const connected = new CodexJsonlClient(child, { notification: async () => {}, request: async (_request, _reply, reject) => { await reject(-32601, 'Catalog queries are non-interactive') }, failure: async () => {}, diagnostic: options.diagnostic }, { ...options, timeoutMs: context.timeoutMs ?? 10_000 })
      client = connected
      void connected.finished.then(() => { if (client === connected) { client = undefined; closing = connected.dispose().finally(() => { closing = undefined }); void closing.catch(() => {}) } })
      await catalogPhase(context, 'handshake', async () => {
        await connected.request('initialize', { clientInfo: { name: 'anureo-catalog', version: '1' }, capabilities: { experimentalApi: true } })
        await connected.notify('initialized')
      })
    })().catch(async cause => { await closeConnection(); await spawned?.dispose(); throw cause }).finally(() => { pending = undefined }))
  })
  return {
    prepare,
    listModels: (context: CatalogProbeOptions = {}) => guarded(context, async () => { await prepare(context); return await catalogPhase(context, 'models', () => readCodexModels(client!)) }),
    readAuthStatus: (context: CatalogProbeOptions = {}) => guarded(context, async () => { await prepare(context); return await readAccountStatus(client!) }),
    dispose,
  }
}
