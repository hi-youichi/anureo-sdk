/** Owns adapter negotiation, session process startup and independent read-only probes. */
import { AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, type Capabilities, type InitializeParams, type InitializeResult, type SessionBinding, type SessionOpenParams } from '@anureo/protocol'
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

/**
 * Connect an SDK client to Codex over stdio. Pass this adapter to createClient to let the SDK
 * initialize it, open sessions and release it during client disposal. Direct hosts must await
 * initialization before opening sessions and dispose the adapter after use.
 */
export class CodexNativeAdapter implements HarnessAdapter {
  /** Retain the caller's launch settings without I/O. Subsequent operations read the same options object. */
  constructor(readonly options: CodexAdapterOptions) {}

  /**
   * Negotiate AHP v1 and advertise capabilities for the configured or discovered binary version.
   * Invalid negotiation throws synchronously. Valid calls share the first probe result or rejection,
   * and the first call's clientInfo is used for native session handshakes. A disposed adapter
   * rejects with RUNTIME_DISPOSED. No app-server session is opened.
   */
  initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('RUNTIME_DISPOSED'))
    assertRequest("initialize", params)
    negotiateVersion(params.protocolVersions)
    return this.initialized ??= (async () => {
      this.version = await probeVersion(this.options)
      this.clientInfo = params.clientInfo
      if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      return {
        protocolVersion: 1,
        protocolContract: AHP_PROTOCOL_CONTRACT,
        runtime: { name: 'codex', version: this.version, adapter: 'codex-native/0.1.0' },
        capabilities: codexCapabilities(this.version),
      }
    })()
  }

  /**
   * Discover models, including hidden entries, in native order from a fresh read-only connection.
   * Omitted cwd uses the adapter default. You can call this before initialization. The promise
   * settles after probe cleanup and rejects on launch, handshake, query or cleanup failures.
   */
  async listModels(cwd = this.options.cwd): Promise<CodexModel[]> {
    return this.runProbe({ kind: 'models', cwd, query: readCodexModels })
  }

  /**
   * Check whether the configured environment is ready, requires authentication, or lacks native
   * account status support. Uses a fresh connection without refreshing credentials or requiring
   * initialization. SDK handshake and query errors have a definite outcome. Launch and cleanup
   * failures propagate as received.
   */
  async readAuthStatus(): Promise<'unknown'|'required'|'ready'> {
    return this.runProbe({
      kind: 'auth',
      cwd: this.options.cwd,
      query: readAccountStatus,
      onFailure: cause => {
        if (cause instanceof HarnessSdkError) {
          throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false, cause.details)
        }
        throw cause
      },
    })
  }

  /**
   * Read terminal evidence for an exact native turn on an idle Codex thread, without resuming it.
   * An absent turn ID or non-Codex binding skips the probe. Inconclusive evidence and handshake or
   * read failures return stopped:false. Omitted cwd uses the adapter default. Any opened probe is
   * released before completion, and launch or cleanup errors can reject.
   */
  async inspectExecution(binding: SessionBinding, nativeTurnId?: string, cwd = this.options.cwd): Promise<ExecutionInspection> {
    if (!nativeTurnId || !hasCodexNativeRef(binding)) return { stopped: false }
    return this.runProbe<ExecutionInspection>({
      kind: 'reconcile',
      cwd,
      query: async client => {
        const response = record(await client.request('thread/read', { threadId: binding.nativeRef.value, includeTurns: true }))
        return inspectThread(record(response.thread), { threadId: binding.nativeRef.value, nativeTurnId })
      },
      onFailure: () => ({ stopped: false }),
    })
  }

  /**
   * Open a new, resumed or forked session after initialization, using SDK-validated params.
   * OutputSession.open supplies a sink and adopts the backend after native handshake and thread
   * restoration. The sink can receive callbacks before open resolves. Unsupported modes, missing
   * fork evidence and native setup failures reject. The adapter disposes the client after handshake
   * or thread-open failure and tracks successful backends for adapter teardown.
   */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    if (!this.clientInfo) throw new HarnessSdkError('NOT_INITIALIZED')

    const capabilities = codexCapabilities(this.version)
    const native = resolveCodexProfile(this.version)
    const prepared = this.prepareSessionOpen(params, capabilities)
    const process = await this.launchProcess(prepared.params.cwd)
    if (this.disposed) {
      await process.dispose()
      throw new HarnessSdkError('RUNTIME_DISPOSED')
    }

    const { session, client } = this.attachSessionClient({
      prepared, process, sink, capabilities,
      native: { profile: native.profile ?? CODEX_PROFILES[0], verified: native.verified },
    })
    try {
      await this.initializeClient(client, this.clientInfo)
      await session.open()
      // Registration follows open so aggregate disposal only sees fully opened sessions.
      this.sessions.add(session)
      return session
    } catch (cause) {
      await client.dispose()
      throw cause
    }
  }

  /**
   * Close initialization and session-open admission and concurrently dispose the registered sessions.
   * After they settle, clear registration and reject the first cleanup failure in registration order.
   * Independent probes and opens already past the launch check can finish separately. Disposal
   * releases local resources without establishing that native execution stopped.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([...this.sessions].map(session => session.dispose()))
    this.sessions.clear()
    const failure = results.find((value): value is PromiseRejectedResult => value.status === 'rejected')
    if (failure) throw failure.reason
  }

  private disposed = false
  private version = ''
  private clientInfo?: InitializeParams['clientInfo']
  private initialized?: Promise<InitializeResult>
  private readonly sessions = new Set<CodexBackendSession>()

  /**
   * Check mode capabilities before openSession launches a process. Forks use an explicit native
   * turn ID or resolve the canonical boundary against the registered source. Reject a missing
   * identity with BOUNDARY_NATIVE_ID_REQUIRED. Carry the source forward to seed the new session.
   */
  private prepareSessionOpen(params: SessionOpenParams, capabilities: Capabilities): PreparedSessionOpen {
    if (params.mode === 'resume' && !capabilities.session?.resume) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    if (params.mode !== 'fork') return { params }

    // Client.validateOpen requires fork data in this mode. The generated request type leaves it optional.
    const { fork } = params as SessionOpenParams & { fork: NonNullable<SessionOpenParams['fork']> }
    if (!capabilities.session?.fork?.includes(fork.boundary.relation)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    const source = [...this.sessions].find(session => session.binding.sessionId === fork.sourceSessionId)
    const nativeTurnId = fork.boundary.nativeTurnId ?? source?.resolveNativeTurn(fork.boundary.turnId)
    if (!nativeTurnId) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED')
    return { params: { ...params, fork: { ...fork, boundary: { ...fork.boundary, nativeTurnId } } }, source }
  }

  /**
   * Build and attach openSession's transport before the handshake, seeding fork identity maps before
   * reads begin. CodexJsonlClient invokes the registered handlers to project native notifications,
   * answer interactions and report connection failures through the SDK sink. The session owns the
   * attached client for backend disposal. Until open succeeds, openSession uses the client to
   * release failed handshakes and thread opens.
   */
  private attachSessionClient({ prepared, process, sink, native, capabilities }: {
    prepared: PreparedSessionOpen
    process: HarnessProcess
    sink: SessionEventSink
    native: ConstructorParameters<typeof CodexBackendSession>[0]['native']
    capabilities: Capabilities
  }): { session: CodexBackendSession; client: CodexJsonlClient } {
    const session = new CodexBackendSession({ params: prepared.params, sink, native, capabilities, options: this.options })
    if (prepared.source) session.importTurnMap(prepared.source)
    const client = new CodexJsonlClient(process, {
      notification: (method, values) => session.notification(method, values),
      request: (request, reply, reject) => session.serverRequest(request, reply, reject),
      failure: cause => session.failure(cause),
      diagnostic: this.options.diagnostic,
    }, this.options)
    session.attach(client)
    return { session, client }
  }

  /** Start the configured app server for an open or probe. Propagate launch failures and transfer cleanup of the returned process to the caller. */
  private launchProcess(cwd: string | undefined): Promise<HarnessProcess> {
    return (this.options.processFactory ?? spawnHarnessProcess)({
      command: this.options.command, args: this.options.args ?? ['app-server'], cwd, env: this.options.env,
    })
  }

  /**
   * Run an adapter read on a fresh connection. The JSONL client rejects any server interaction
   * using the probe's wire message. Only handshake and query failures reach onFailure, when
   * supplied. Always await client disposal, whose failure takes precedence over the query outcome.
   */
  private async runProbe<T>({ kind, cwd, query, onFailure }: {
    kind: keyof typeof PROBES
    cwd: string | undefined
    query: (client: CodexJsonlClient) => Promise<T>
    onFailure?: (cause: unknown) => T
  }): Promise<T> {
    const process = await this.launchProcess(cwd)
    const { name, interactionError } = PROBES[kind]
    const client = new CodexJsonlClient(process, {
      notification: async () => {},
      request: async (_request, _reply, reject) => { await reject(-32601, interactionError) },
      failure: async () => {},
      diagnostic: kind === 'auth' ? undefined : this.options.diagnostic,
    }, this.options)
    try {
      const clientInfo = (kind === 'auth' ? undefined : this.clientInfo) ?? { name, version: '0.1.0' }
      await this.initializeClient(client, clientInfo)
      return await query(client)
    } catch (cause) {
      if (onFailure) return onFailure(cause)
      throw cause
    } finally {
      await client.dispose()
    }
  }

  /** Send the native handshake before session or probe RPCs. Await the initialize reply and initialized notification write. Callers handle failures and release the client. */
  private async initializeClient(client: CodexJsonlClient, clientInfo: InitializeParams['clientInfo']): Promise<void> {
    await client.request('initialize', { clientInfo, capabilities: { experimentalApi: true } })
    await client.notify('initialized')
  }
}

/** Construct a Codex adapter for createClient without I/O. If managing it directly, initialize it before opening sessions and await disposal after use. */
export function createCodexAdapter(options: CodexAdapterOptions): CodexNativeAdapter {
  return new CodexNativeAdapter(options)
}

type PreparedSessionOpen = { params: SessionOpenParams; source?: CodexBackendSession }

/** Only exact terminal evidence permits a caller to treat an execution as stopped. */
type ExecutionInspection = { stopped: false } | { stopped: true; status: 'completed'|'interrupted'|'failed'; turnId: string }

const PROBES = {
  models: { name: 'anureo-harness-models', interactionError: 'No interactive surface during model discovery' },
  auth: { name: 'anureo-harness-auth', interactionError: 'Account status is non-interactive' },
  reconcile: { name: 'anureo-harness-reconcile', interactionError: 'Reconciliation is non-interactive' },
}

/** Admit inspectExecution probes only for Codex bindings so a foreign native ID is never sent to the app server. */
function hasCodexNativeRef(binding: SessionBinding): binding is SessionBinding & { nativeRef: NonNullable<SessionBinding['nativeRef']> } {
  return binding.nativeRef?.provider === 'codex'
}

/** Compare native terminal status using string coercion. Reconciliation returns the status from the native snapshot. */
function isTerminalStatus(status: unknown): boolean {
  return ['completed', 'interrupted', 'failed'].includes(String(status))
}

/** Evaluate inspectExecution's thread/read reply. Require matching thread and turn identities, explicit idle state and terminal status for every turn. */
function inspectThread(thread: NativeRecord, { threadId, nativeTurnId }: { threadId: string; nativeTurnId: string }): ExecutionInspection {
  if (thread.id !== threadId || record(thread.status).type !== 'idle' || !Array.isArray(thread.turns)) return { stopped: false }
  const turns = thread.turns.map(record)
  if (turns.some(turn => !isTerminalStatus(turn.status))) return { stopped: false }
  const target = turns.find(turn => turn.id === nativeTurnId)
  if (!target || !isTerminalStatus(target.status)) return { stopped: false }
  return { stopped: true, status: target.status as 'completed'|'interrupted'|'failed', turnId: nativeTurnId }
}
