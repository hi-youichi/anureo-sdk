import { HarnessSdkError, type Client, type HarnessAdapter } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, AHP_PROTOCOL_VERSION, assertRequest, negotiateVersion, type Capabilities } from '@anureo/protocol'
import { releaseSession } from './execution'
import { parseBeeProfile, type BeeProfile } from './profiles'
import { ProfileReviews, type BeeProfileReview } from './profile-review'
import { SwarmSession } from './session'

export { parseBeeProfile, type BeeProfile } from './profiles'
export type { BeeProfileReview } from './profile-review'

export interface SwarmAdapterOptions {
  /** Initialized SDK Client. The caller owns it and releases it after the swarm client. */
  backend: Client
  /** Optional SDK Clients keyed by fixed profile ID or temporary member role. */
  memberBackends?: Readonly<Record<string, Client>>
  /** Fixed bees available to the router and to explicit @id assignments. */
  profiles?: readonly BeeProfile[]
  /** Enable detached fixed-bee reviews. Client disposal awaits pending reviews and callbacks. */
  profileReview?: {
    onResult: (review: BeeProfileReview) => void | Promise<void>
    feedback?: string
  }
}

const capabilities: Capabilities = {
  input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
  turn: { inputModalities: ['text'] },
  subagents: { events: 'nested' },
}

export function createSwarmAdapter(options: SwarmAdapterOptions): HarnessAdapter {
  const { backend } = options
  const memberBackends = new Map(Object.entries(options.memberBackends ?? {}))
  const reviews = options.profileReview && new ProfileReviews(options.profileReview.onResult, options.profileReview.feedback)
  const profiles = new Map<string, BeeProfile>()
  for (const value of options.profiles ?? []) {
    const profile = parseBeeProfile(value)
    if (profiles.has(profile.id)) throw new HarnessSdkError('SWARM_INVALID_PROFILE', `Duplicate profile id "${profile.id}"`)
    profiles.set(profile.id, profile)
  }
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
      return new SwarmSession(params, sink, capabilities, main, backend, memberBackends, profiles, reviews)
    },
    async dispose() {
      disposed = true
      await reviews?.drain()
    },
  }
}
