import { HarnessSdkError, type Client, type HarnessAdapter } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, AHP_PROTOCOL_VERSION, assertRequest, negotiateVersion, type Capabilities } from '@anureo/protocol'
import { releaseSession } from './execution'
import { SwarmSession } from './session'

export interface SwarmAdapterOptions {
  /** Initialized SDK Client. The caller owns it and releases it after the swarm client. */
  backend: Client
  /** Optional SDK Clients keyed by member role. Other roles use backend. */
  memberBackends?: Readonly<Record<string, Client>>
}

const capabilities: Capabilities = {
  input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
  turn: { inputModalities: ['text'] },
  subagents: { events: 'nested' },
}

export function createSwarmAdapter(options: SwarmAdapterOptions): HarnessAdapter {
  const { backend } = options
  const memberBackends = new Map(Object.entries(options.memberBackends ?? {}))
  let disposed = false
  return {
    async initialize(params) {
      if (disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      assertRequest('initialize', params)
      negotiateVersion(params.protocolVersions)
      return {
        protocolVersion: AHP_PROTOCOL_VERSION,
        protocolContract: AHP_PROTOCOL_CONTRACT,
        runtime: { name: 'swarm', version: '0.2.0', adapter: 'swarm' },
        capabilities,
      }
    },
    async openSession(params, sink) {
      if (disposed) throw new HarnessSdkError('RUNTIME_DISPOSED')
      if (params.mode !== 'new') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
      const { cwd, model, instructions, permissionMode, config, mcpServers } = params
      const main = await backend.sessions.create({ cwd, model, instructions, permissionMode, config, mcpServers })
      if (disposed) {
        await releaseSession(main)
        throw new HarnessSdkError('RUNTIME_DISPOSED')
      }
      return new SwarmSession(params, sink, capabilities, main, backend, memberBackends)
    },
    async dispose() {
      disposed = true
    },
  }
}
