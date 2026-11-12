import { HarnessSdkError, type HarnessAdapter, type SessionEventSink } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, type InitializeParams, type InitializeResult, type SessionOpenParams } from '@anureo/protocol'
import { attachGateway } from './attach'
import { describe } from './native'
import { HermesRpc } from './rpc'
import { HermesSession, hermesCapabilities } from './session'
import { validateOptions, type HermesAdapterOptions } from './options'
export type { HermesAdapterOptions } from './options'

export class HermesAdapter implements HarnessAdapter {
  private initialized?: Promise<InitializeResult>
  private profileId?: string
  private editorMcp = false
  private disposed = false
  private readonly abort = new AbortController()
  private probe?: HermesRpc
  private readonly sessions = new Set<HermesSession>()
  readonly options: HermesAdapterOptions
  outputBridgeTransport(params: SessionOpenParams): 'http' | undefined {
    return this.editorMcp && params.mode === 'new' ? 'http' : undefined
  }
  constructor(options: HermesAdapterOptions = {}) {
    try { validateOptions(options) } catch { throw new HarnessSdkError('INVALID_PARAMS', 'Invalid Hermes adapter options') }
    this.options = { ...options, ...(options.args ? { args: [...options.args] } : {}), ...(options.env ? { env: { ...options.env } } : {}) }
  }
  initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('RUNTIME_DISPOSED'))
    assertRequest('initialize', params); negotiateVersion(params.protocolVersions)
    return this.initialized ??= (async () => {
      const grant = await attachGateway(this.options, this.options.startup ?? 'start', this.abort.signal)
      let channel: HermesRpc | undefined
      channel = await HermesRpc.connect(grant, { event: async () => {}, request: async request => { await channel?.reject(request.id) }, failure: () => {} }, this.options, this.abort.signal)
      if (this.disposed) { channel.dispose(); throw new HarnessSdkError('RUNTIME_DISPOSED') }
      this.probe = channel
      try {
        const description = describe(await channel.request('runtime.describe'), grant)
        if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
        this.profileId = description.profileId
        this.editorMcp = description.editorMcp
        return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT,
          runtime: { name: 'hermes', version: grant.version, adapter: 'hermes-gateway/0.2.0' }, capabilities: hermesCapabilities() }
      } catch (cause) {
        if (cause instanceof HarnessSdkError) throw new HarnessSdkError(cause.code, cause.message, cause.retryable, false)
        throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Hermes gateway description')
      } finally { channel.dispose(); if (this.probe === channel) this.probe = undefined }
    })()
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<HermesSession> {
    if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
    if (!this.profileId) throw new HarnessSdkError('NOT_INITIALIZED')
    assertRequest('session/open', params)
    if (params.mode === 'fork' || params.instructions !== undefined || params.permissionMode !== undefined || params.mcpServers !== undefined && (!this.editorMcp || params.mode !== 'new') || Object.keys(params.config ?? {}).length) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    if (params.mode === 'resume' && params.binding.nativeRef?.provider !== 'hermes') throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    const session = new HermesSession(params, sink, this.options, this.profileId, () => this.sessions.delete(session))
    this.sessions.add(session)
    try {
      await session.open()
      if (this.disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      return session
    } catch (cause) { await session.dispose(); throw cause }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.probe?.dispose()
    await Promise.all([...this.sessions].map(value => value.dispose()))
    this.sessions.clear()
  }
}

export function createHermesAdapter(options: HermesAdapterOptions = {}): HermesAdapter { return new HermesAdapter(options) }
