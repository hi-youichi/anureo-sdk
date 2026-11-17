import { HarnessSdkError, sdkError, type Client, type HarnessAdapter } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, AHP_PROTOCOL_VERSION, assertRequest, negotiateVersion, type Capabilities } from '@anureo/protocol'
import { releaseSession } from './execution'
import { BeeProfileRegistry, type BeeProfile, type BeeProfileRegistration } from './profiles'
import { ProfileReviews, type BeeProfileReview } from './profile-review'
import { SwarmSession } from './session'
import { BeeManager, type SwarmLimits } from './bee-manager'
import { ManagementBridgeManager } from './management-bridge'
import { mainInstructions } from './instructions'
import { modelInstructions, parseModelCatalog, type SwarmModelCatalog, type MemberBackend } from './models'
import { ResultStore, type SwarmResultOptions } from './results'
import { CompletionMailbox, type SwarmMailboxOptions } from './coordination/mailbox'
import type { EvolutionController } from './evolution/types'
import { HookRunner, type SwarmHookOptions, type HookContext } from './hooks'
export type { SwarmHooks, SwarmHookOptions, HookContext, HookDiagnostic, SwarmAssignment, AssignmentRevisionPin, DelegationSnapshot, TaskSnapshot, AssessmentSnapshot, TurnSnapshot, BeforeDelegateResult, Immutable } from './hooks'

export { parseBeeProfile, type BeeProfile, type BeeProfileScope, type BeeProfileSource, type BeeProfileRegistration, type BeeProfileReference } from './profiles'
export type { BeeProfileReview } from './profile-review'
export { parseModelGuidance, parseModelCatalog, type ModelGuidance, type SwarmModel, type SwarmBackendModelCatalog, type SwarmModelCatalog, type BeeExecutionSelection } from './models'
export type { SwarmResultOptions, ResultDescriptor } from './results'
export type { SwarmMailboxOptions, CompletionNotice } from './coordination/mailbox'

export interface SwarmAdapterOptions extends SwarmHookOptions {
  /** Initialized SDK Client. The caller owns it and releases it after the swarm client. */
  backend: Client
  /** Hard limits for session members and turn assignments. */
  limits?: Partial<SwarmLimits>
  /** Optional SDK Clients keyed by fixed profile ID or temporary member role. */
  memberBackends?: Readonly<Record<string, Client>>
  /** Application-owned discovery snapshot, grouped by the existing memberBackends routes. */
  modelCatalog?: SwarmModelCatalog
  /** Session-local full-text retention. Omitted results remain explicitly described. */
  results?: SwarmResultOptions
  /** Session completion notification capacity, reserved before accepting work. */
  mailbox?: SwarmMailboxOptions
  /** Fixed bees available to the main assistant and to explicit @id assignments. */
  profiles?: readonly BeeProfile[]
  /** Origin-aware registrations. Mutually exclusive with profiles; no filesystem scanning is performed. */
  profileEntries?: readonly BeeProfileRegistration[]
  /** Optional persistent resolver/evidence controller. seed() checks the configured source baseline.
   * Caller ownership is the default: close it after the Swarm client to drain/cancel background work.
   * Adapter ownership closes it at disposal start, suppressing pending publication, then drains cleanup.
   * Evidence hooks are composed with application hooks; do not manually register them again.
   * Legacy profileReview remains explicit and independent; evolution never starts legacy reviews.
   */
  evolution?: { controller: EvolutionController; ownership?: 'caller' | 'adapter' }
  /** Enable detached fixed-bee reviews. Client disposal awaits pending reviews and callbacks. */
  profileReview?: {
    onResult: (review: BeeProfileReview, context: HookContext) => void | Promise<void>
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
  const limits: SwarmLimits = { maxBees: 8, maxConcurrentTasks: 3, maxTasksPerTurn: 16, ...options.limits }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new HarnessSdkError('SWARM_INVALID_LIMITS')
  // Validate before opening the bridge or borrowing native sessions; detach caller-owned options.
  const runtime = { results: options.results && { ...options.results }, mailbox: options.mailbox && { ...options.mailbox } }
  new ResultStore(runtime.results).close()
  new CompletionMailbox(runtime.mailbox).close()
  const bridges = new ManagementBridgeManager()
  const sessions = new Set<SwarmSession>()
  const memberBackends = new Map(Object.entries(options.memberBackends ?? {}))
  const modelCatalog = parseModelCatalog(options.modelCatalog, [...memberBackends.keys()])
  const defaultBackend: MemberBackend = { client: backend, route: { kind: 'default' }, catalog: modelCatalog.default }
  const backendFor = (role: string): MemberBackend => memberBackends.has(role)
    ? { client: memberBackends.get(role)!, route: { kind: 'member', key: role }, catalog: modelCatalog.members?.[role] }
    : defaultBackend
  const availableModels = modelInstructions(defaultBackend, [...memberBackends.keys()].map(key => ({ key, backend: backendFor(key) })))
  const reviewHooks = new HookRunner(options)
  const reviews = options.profileReview && new ProfileReviews(options.profileReview.onResult, options.profileReview.feedback, reviewHooks)
  if (options.profiles !== undefined && options.profileEntries !== undefined) throw new HarnessSdkError('SWARM_INVALID_PROFILE', 'Use either profiles or profileEntries')
  const profiles = new BeeProfileRegistry(options.profileEntries ?? (options.profiles ?? []).map(profile => ({ profile })))
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
      if (mcpServers?.some(server => server.name === 'anureo-swarm')) throw new HarnessSdkError('SWARM_RESERVED_MCP_NAME')
      const members = new BeeManager(params, sink, backendFor, profiles, limits, reviews, new HookRunner(options, options.evolution?.controller.hooks), options.evolution?.controller, runtime)
      const bridge = await bridges.create(async (name, args, signal) => {
        try {
          const response = { content: [{ type: 'text' as const, text: JSON.stringify(await members.call(name, args, signal)) }] }
          if (Buffer.byteLength(JSON.stringify(response)) > 128 * 1024) throw new HarnessSdkError('SWARM_RESPONSE_TOO_LARGE')
          return response
        }
        catch (cause) { return { isError: true, content: [{ type: 'text', text: `${sdkError(cause).code}: ${cause instanceof Error ? cause.message : 'SWARM_TOOL_FAILED'}` }] } }
      })
      try {
        const main = await backend.sessions.create({ cwd, model, instructions: mainInstructions(profiles, [...memberBackends.keys()], instructions, availableModels), permissionMode, config, mcpServers: [...(mcpServers ?? []), bridge.config] })
        if (disposed) { await releaseSession(main); throw new HarnessSdkError('RUNTIME_DISPOSED') }
        const session = new SwarmSession(params, sink, capabilities, main, members, bridge, profiles, () => { sessions.delete(session) })
        sessions.add(session)
        return session
      } catch (cause) {
        await bridge.dispose()
        await members.close()
        throw cause
      }
    },
    async dispose() {
      disposed = true
      const evolutionClosing = options.evolution?.ownership === 'adapter' ? options.evolution.controller.close() : undefined
      const results = await Promise.allSettled([...sessions].map(session => session.dispose()))
      if (evolutionClosing) results.push(...await Promise.allSettled([evolutionClosing]))
      await reviews?.drain()
      await bridges.dispose()
      if (results.some(result => result.status === 'rejected')) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED')
    },
  }
}
