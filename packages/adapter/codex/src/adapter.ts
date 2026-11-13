/** Owns public adapter initialization, read-only probes and session/process orchestration; it must not define native version policy or event projections. */
import { AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, type InitializeParams, type InitializeResult, type SessionBinding, type SessionOpenParams } from '@anureo/protocol'
import { HarnessSdkError, type BackendSession, type HarnessAdapter, type SessionEventSink } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { CodexJsonlClient } from './jsonl'
import { record, type NativeRecord } from './native-values'
import type { CodexAdapterOptions } from './options'
import { CODEX_PROFILES, codexCapabilities, resolveCodexProfile } from './profile'
import { probeVersion } from './version'
import { readAccountStatus } from './account'
import { readCodexModels, type CodexModel } from './models'
import { CodexBackendSession } from './session'

/** Reconciliation evidence returned to SDK hosts; an inconclusive read must never claim execution stopped. */
type ExecutionInspection = { stopped: false } | { stopped: true; status: 'completed'|'interrupted'|'failed'; turnId: string }

/** Shared terminal-status rule for reconciliation; preserve native string coercion without normalizing the returned status. */
function isTerminalStatus(status: unknown): boolean {
  return ['completed', 'interrupted', 'failed'].includes(String(status))
}

/** For inspectExecution, evaluate a read-only thread snapshot without mutation or I/O. Require exact identities, explicit idle state and no unfinished turns; absent evidence returns stopped:false. */
function inspectThread(thread: NativeRecord, { threadId, nativeTurnId }: { threadId: string; nativeTurnId: string }): ExecutionInspection {
  if (thread.id !== threadId || record(thread.status).type !== 'idle' || !Array.isArray(thread.turns)) return { stopped: false }
  const turns = thread.turns.map(record)
  if (turns.some(turn => !isTerminalStatus(turn.status))) return { stopped: false }
  const target = turns.find(turn => turn.id === nativeTurnId)
  if (!target || !isTerminalStatus(target.status)) return { stopped: false }
  return { stopped: true, status: target.status as 'completed'|'interrupted'|'failed', turnId: nativeTurnId }
}

/** Host-facing adapter owner: initialize before opening sessions, then dispose to release owned session processes. Read-only probes own separate short-lived clients; native policy and projections live below this class. */
export class CodexNativeAdapter implements HarnessAdapter {
  private disposed = false
  private version = ''
  private clientInfo?: InitializeParams['clientInfo']
  private initialized?: Promise<InitializeResult>
  private readonly sessions = new Set<CodexBackendSession>()
  /** Accept host launch options without starting a process; initialize must precede session opening and dispose releases owned sessions. */
  constructor(readonly options: CodexAdapterOptions) {}
  /** Validate every host negotiation synchronously, then share the first version-probe promise, including rejection. Disposed use rejects; the first caller supplies session clientInfo. Starts only a probe process, never a session. */
  initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('RUNTIME_DISPOSED'))
    assertRequest("initialize", params)
    negotiateVersion(params.protocolVersions)
    return this.initialized ??= (async () => {
      this.version = await probeVersion(this.options)
      this.clientInfo = params.clientInfo
      if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      // Discover the version without mutating native state; optional methods are checked only when called.
      return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'codex', version: this.version, adapter: 'codex-native/0.1.0' }, capabilities: codexCapabilities(this.version) }
    })()
  }
  /** For host discovery, return models from a fresh read-only client using the requested cwd, even before adapter initialization. Reject launch/handshake/query errors; always dispose the created client without creating a thread. */
  async listModels(cwd = this.options.cwd): Promise<CodexModel[]> {
    const child = await this.launchProcess(cwd)
    const client = this.createProbeClient(child, { interactionError: 'No interactive surface during model discovery', diagnostic: this.options.diagnostic })
    try {
      await this.initializeClient(client, this.clientInfo ?? { name: 'anureo-harness-models', version: '0.1.0' })
      return await readCodexModels(client)
    } finally { await client.dispose() }
  }
  /** For host readiness checks, query a fresh client in the configured environment without requiring initialization or authenticating. Propagate launch errors; mark SDK handshake/query failures definite and always dispose the created client, propagating cleanup errors. */
  async readAuthStatus(): Promise<'unknown'|'required'|'ready'> {
    const child = await this.launchProcess(this.options.cwd)
    const client = this.createProbeClient(child, { interactionError: 'Account status is non-interactive' })
    try {
      await this.initializeClient(client, { name: 'anureo-harness-auth', version: '0.1.0' })
      return await readAccountStatus(client)
    } catch (cause) {
      if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false, cause.details)
      throw cause
    } finally { await client.dispose() }
  }
  /** For host reconciliation, return terminal evidence only for a matching idle native thread and turn; query failures or absent evidence return stopped:false. Launch/disposal errors may reject; dispose every created client without resuming the thread. */
  async inspectExecution(binding: SessionBinding, nativeTurnId?: string, cwd = this.options.cwd): Promise<ExecutionInspection> {
    if (!nativeTurnId || binding.nativeRef?.provider !== 'codex') return { stopped: false }
    const child = await this.launchProcess(cwd)
    const client = this.createProbeClient(child, { interactionError: 'Reconciliation is non-interactive', diagnostic: this.options.diagnostic })
    try {
      await this.initializeClient(client, this.clientInfo ?? { name: 'anureo-harness-reconcile', version: '0.1.0' })
      const response = record(await client.request('thread/read', { threadId: binding.nativeRef.value, includeTurns: true }))
      return inspectThread(record(response.thread), { threadId: binding.nativeRef.value, nativeTurnId })
    } catch { return { stopped: false } }
    finally { await client.dispose() }
  }
  /** For SDK hosts after initialization, resolve validated fork params and open a session with its own process and sink. Reject unsupported modes, unknown boundaries or startup errors; dispose handshake/thread-open failures and register only fully opened sessions. */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    if (!this.clientInfo) throw new HarnessSdkError('NOT_INITIALIZED')
    const capabilities = codexCapabilities(this.version)
    const native = resolveCodexProfile(this.version)
    // SDK callers validate the mode-specific fork payload before reaching the adapter.
    if ((params.mode === 'resume' && !capabilities.session?.resume) || (params.mode === 'fork' && !capabilities.session?.fork?.includes(params.fork!.boundary.relation))) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    const resolved = params.mode === 'fork' ? this.resolveFork(params.fork!) : undefined
    if (resolved) params = { ...params, fork: resolved.fork }
    const process = await this.launchProcess(params.cwd)
    if (this.disposed) { await process.dispose(); throw new HarnessSdkError('RUNTIME_DISPOSED') }
    const session = new CodexBackendSession(params, sink, { profile: native.profile ?? CODEX_PROFILES[0]!, verified: native.verified }, capabilities, this.options)
    if (resolved?.source) session.importTurnMap(resolved.source)
    const client = new CodexJsonlClient(process, {
      notification: (method, values) => session.notification(method, values),
      request: (request, reply, reject) => session.serverRequest(request, reply, reject),
      failure: cause => session.failure(cause), diagnostic: this.options.diagnostic,
    }, this.options)
    session.attach(client)
    try {
      await this.initializeClient(client, this.clientInfo)
      await session.open()
      // Registration follows open so aggregate disposal never observes a partially opened session.
      this.sessions.add(session)
      return session
    } catch (cause) { await client.dispose(); throw cause }
  }
  /** For openSession after capability admission, resolve a required fork boundary before launching a process. Return copied fork params and its observed source without mutation or I/O; throw BOUNDARY_NATIVE_ID_REQUIRED when neither supplied nor observed evidence exists. */
  private resolveFork(fork: NonNullable<SessionOpenParams['fork']>): { fork: NonNullable<SessionOpenParams['fork']>; source?: CodexBackendSession } {
    const source = [...this.sessions].find(session => session.binding.sessionId === fork.sourceSessionId)
    const nativeTurnId = fork.boundary.nativeTurnId ?? source?.resolveNativeTurn(fork.boundary.turnId)
    if (!nativeTurnId) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED')
    return { fork: { ...fork, boundary: { ...fork.boundary, nativeTurnId } }, source }
  }
  /** Launch the configured app server for adapter probes or session opening; propagate synchronous factory throws and launch rejections. The caller takes ownership of the returned process. */
  private launchProcess(cwd: string | undefined): Promise<HarnessProcess> {
    return (this.options.processFactory ?? spawnHarnessProcess)({ command: this.options.command, args: this.options.args ?? ['app-server'], cwd, env: this.options.env })
  }
  /** Attach probe-only handlers before readers start, rejecting interactions with the caller's message. No handshake or disposal occurs here; probe methods retain their distinct error and cleanup boundaries. */
  private createProbeClient(process: HarnessProcess, { interactionError, diagnostic }: { interactionError: string; diagnostic?: CodexAdapterOptions['diagnostic'] }): CodexJsonlClient {
    return new CodexJsonlClient(process, {
      notification: async () => {},
      request: async (_request, _reply, reject) => { await reject(-32601, interactionError) },
      failure: async () => {}, diagnostic,
    }, this.options)
  }
  /** For probe/session startup, complete the native handshake in wire order before domain requests. Reject either transport step; callers own failure handling and disposal. */
  private async initializeClient(client: CodexJsonlClient, clientInfo: InitializeParams['clientInfo']): Promise<void> {
    await client.request('initialize', { clientInfo, capabilities: { experimentalApi: true } })
    await client.notify('initialized')
  }
  /** For host teardown, prevent future initialization/opening, dispose registered sessions concurrently, then clear registration. After all settle, reject the first failure in registration order; process cleanup does not claim native interruption. Already-started opens and independent probes are not awaited. */
  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([...this.sessions].map(session => session.dispose()))
    this.sessions.clear()
    const failure = results.find((value): value is PromiseRejectedResult => value.status === 'rejected')
    if (failure) throw failure.reason
  }
}
/** For SDK hosts, construct an uninitialized adapter without I/O; caller must initialize before opening sessions and dispose it after use. */
export function createCodexAdapter(options: CodexAdapterOptions): CodexNativeAdapter { return new CodexNativeAdapter(options) }
