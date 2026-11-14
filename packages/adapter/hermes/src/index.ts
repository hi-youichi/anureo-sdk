import { HarnessSdkError, type HarnessAdapter, type SessionEventSink } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, type InitializeParams, type InitializeResult, type SessionOpenParams } from '@anureo/protocol'
import { attachGateway } from './attach'
import { describe } from './native'
import { HermesRpc } from './rpc'
import { HermesSession, hermesCapabilities } from './session'
import { validateOptions, type HermesAdapterOptions } from './options'
export type { HermesAdapterOptions } from './options'

/**
 * Connect SDK clients to a shared Hermes gateway owner. Pass this adapter to createClient, which
 * initializes and disposes it through the SDK's output wrapper. Direct port consumers must await
 * initialize before opening sessions and dispose the adapter when finished; disposal ends local
 * observation without stopping the shared owner or its executions.
 */
export class HermesAdapter implements HarnessAdapter {
  /** Configuration for subsequent native work. Argument, toolset and environment containers are copied at construction. */
  readonly options: HermesAdapterOptions
  /** Validate and copy configuration without native I/O; invalid options throw INVALID_PARAMS. */
  constructor(options: HermesAdapterOptions = {}) {
    try { validateOptions(options) } catch { throw new HarnessSdkError('INVALID_PARAMS', 'Invalid Hermes adapter options') }
    this.options = { ...options, ...(options.toolsets ? { toolsets: [...options.toolsets] } : {}), ...(options.args ? { args: [...options.args] } : {}), ...(options.env ? { env: { ...options.env } } : {}) }
  }
  /** Return 'http' to OutputSession.open for a new editor-capable session, or undefined when the bridge is unavailable. */
  outputBridgeTransport(params: SessionOpenParams): 'http' | undefined {
    return this.editorMcp && params.mode === 'new' ? 'http' : undefined
  }
  /**
   * Negotiate the SDK protocol and describe the ticketed Hermes owner without creating a session.
   * Cache the first native probe promise, including failure, and release its channel after description.
   * Request validation/version errors throw synchronously; disposed adapters return a rejected promise,
   * and attachment, description or concurrent disposal failures reject the probe.
   */
  initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('RUNTIME_DISPOSED'))
    assertRequest('initialize', params); negotiateVersion(params.protocolVersions)
    return this.initialized ??= this.probeRuntime()
  }
  /**
   * Open a new or resumed native observation after initialization. OutputSession.open supplies the
   * forwarding sink and owns the returned backend; callbacks can publish before this resolves.
   * Reject invalid requests, unsupported options, binding mismatches or setup failure, disposing
   * partial sessions first. Direct port consumers own cleanup of the returned observation.
   */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<HermesSession> {
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    if (!this.profileId) throw new HarnessSdkError('NOT_INITIALIZED')
    assertRequest('session/open', params)
    this.assertSupportedOpen(params)
    const session = new HermesSession({ params, sink, options: this.options, profileId: this.profileId, released: () => this.sessions.delete(session) })
    this.sessions.add(session)
    try {
      await session.open()
      if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      return session
    } catch (cause) { await session.dispose(); throw cause }
  }
  /**
   * Abort attachment and close local channels without stopping native work. The first call awaits
   * tracked session disposal. To observe completion of an in-flight initialization, await its own
   * promise, which can remain pending while the attach child is disposed. Later disposal calls return immediately.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.probe?.dispose()
    await Promise.all([...this.sessions].map(value => value.dispose()))
    this.sessions.clear()
  }

  private initialized?: Promise<InitializeResult>
  private profileId?: string
  private editorMcp = false
  private disposed = false
  private readonly abort = new AbortController()
  private probe?: HermesRpc
  private readonly sessions = new Set<HermesSession>()

  /**
   * Own the temporary channel for initialize. Ignore probe events and reject server requests once
   * the channel is available. Publish the profile and editor support only after a validated
   * description, then close the probe on either outcome. Description failures have a known outcome
   * because the probe never submits work.
   */
  private async probeRuntime(): Promise<InitializeResult> {
    const grant = await attachGateway(this.options, this.options.startup ?? 'start', this.abort.signal)
    let channel: HermesRpc | undefined
    channel = await HermesRpc.connect(grant, {
      event: async () => {},
      request: async request => { await channel?.reject(request.id) },
      failure: () => {},
    }, this.options, this.abort.signal)
    if (this.disposed) {
      channel.dispose()
      throw new HarnessSdkError('RUNTIME_DISPOSED')
    }
    this.probe = channel
    try {
      const description = describe(await channel.request('runtime.describe'), grant)
      if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      this.profileId = description.profileId
      this.editorMcp = description.editorMcp
      return {
        protocolVersion: 1,
        protocolContract: AHP_PROTOCOL_CONTRACT,
        runtime: { name: 'hermes', version: grant.version, adapter: 'hermes-gateway/0.2.0' },
        capabilities: hermesCapabilities(),
      }
    } catch (cause) {
      if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false)
      throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Hermes gateway description')
    } finally {
      channel.dispose()
      if (this.probe === channel) this.probe = undefined
    }
  }

  /** Reject unsupported features and foreign resume bindings before openSession acquires resources. */
  private assertSupportedOpen(params: SessionOpenParams): void {
    if (params.mode === 'fork' || params.instructions !== undefined || params.permissionMode !== undefined
      || (params.mcpServers !== undefined && (!this.editorMcp || params.mode !== 'new'))
      || Object.keys(params.config ?? {}).length) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    if (params.mode === 'resume' && params.binding.nativeRef?.provider !== 'hermes') throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
  }
}

/**
 * Create a Hermes adapter for createClient. Configuration is validated synchronously and invalid
 * options throw INVALID_PARAMS. Native attachment starts on initialization. Dispose the returned
 * client when finished. createClient releases the adapter if client initialization fails.
 *
 * @example
 * With the Hermes CLI on PATH and a configured default profile:
 *
 * ```ts
 * import { createHermesAdapter } from '@anureo/adapter-hermes'
 * import { createClient } from '@anureo/sdk'
 *
 * const client = await createClient({
 *   adapter: createHermesAdapter(),
 *   identity: { adapterId: 'hermes', runtimeConfigId: 'default' },
 * })
 * try {
 *   const session = await client.sessions.create({ cwd: process.cwd() })
 *   const turn = await session.submit({ input: 'Summarize this workspace.' })
 *   console.log(await turn.result())
 * } finally {
 *   await client.dispose()
 * }
 * ```
 */
export function createHermesAdapter(options: HermesAdapterOptions = {}): HermesAdapter { return new HermesAdapter(options) }
