// Assembles the harness adapter, runs one turn and emits the output contract; it must not parse CLI input.
import { createClient, type Client, type HarnessAdapter } from '@anureo/sdk'
import type { SwarmAdapterOptions, SwarmModel } from '@anureo/adapter-swarm'
import type { AhpEvent } from '@anureo/protocol'
import { printEvent, printResult } from './project'
import { codexModels, claudeModels, piModels, loadSwarmModelCatalog } from './models'

/** Native harnesses available directly or as the backend for a swarm. */
export const BACKEND_HARNESSES = ['codex', 'claude', 'hermes', 'pi', 'acp'] as const
type BackendHarness = (typeof BACKEND_HARNESSES)[number]
export type HarnessSelection = { name: BackendHarness } | { name: 'swarm'; backend: BackendHarness }
/** Sandbox axis values; only harnesses with a defined mapping accept the flag. */
export const SANDBOX_VALUES = ['read-only', 'workspace', 'full'] as const
export type Sandbox = (typeof SANDBOX_VALUES)[number]
export type OutputMode = 'stream' | 'result'

/** Dispatch timeout for session open/submit and non-Swarm result waits; Swarm execution waits without a deadline. */
const DISPATCH_TIMEOUT_MS = 180_000

/** --sandbox → native permissionMode per harness; harnesses without an entry reject the flag in cli.ts. */
const PERMISSION_MODE: Partial<Record<BackendHarness, Record<Sandbox, string>>> = {
  codex: { 'read-only': 'read-only', workspace: 'agent', full: 'agent-full-access' },
  claude: { 'read-only': 'plan', workspace: 'acceptEdits', full: 'bypassPermissions' },
}

export const supportsSandbox = (backend: BackendHarness): boolean => PERMISSION_MODE[backend] !== undefined

export interface RunOptions {
  harness: HarnessSelection
  command?: string
  harnessArgs?: string[]
  cwd: string
  homeDirectory?: string
  model?: string
  resume?: string
  sandbox?: Sandbox
  outputSchema?: unknown
  output: OutputMode
  reviewProfile?: boolean
  reviewFeedback?: string
  verbose: boolean
  prompt: string
}

export interface RunIo { out: (text: string) => void; err: (text: string) => void }

/** Dynamically imported so a missing harness dependency only fails when that harness is selected. */
async function createAdapter(harness: BackendHarness, options: RunOptions, io: RunIo): Promise<{ adapter: HarnessAdapter; models?: () => Promise<SwarmModel[]> }> {
  const { command } = options
  try {
    switch (harness) {
      case 'codex': {
        const { createCodexAdapter } = await import('@anureo/adapter-codex')
        const adapter = createCodexAdapter({ command: command ?? 'codex', ...(options.harnessArgs?.length ? { args: options.harnessArgs } : {}) })
        return { adapter, models: async () => codexModels(await adapter.listModels(options.cwd)) }
      }
      case 'claude': {
        const { createClaudeAdapter } = await import('@anureo/adapter-claude')
        // defaultHome uses the Claude CLI's own login; the CLI is a local developer tool.
        const launch = { defaultHome: true, ...(command && { command }), ...(options.harnessArgs?.length && { args: options.harnessArgs }) }
        return { adapter: createClaudeAdapter(launch), models: async () => {
          const { createClaudeCatalogSession } = await import('@anureo/adapter-claude/catalog')
          const catalog = createClaudeCatalogSession({ ...launch, cwd: options.cwd })
          try { return claudeModels(await catalog.listModels()) } finally { await catalog.dispose() }
        } }
      }
      case 'hermes': {
        const { createHermesAdapter } = await import('@anureo/adapter-hermes')
        return { adapter: createHermesAdapter({ ...(command && { command }), ...(options.harnessArgs?.length && { args: options.harnessArgs }) }) }
      }
      case 'pi': {
        const { createPiAdapter } = await import('@anureo/adapter-pi')
        return { adapter: createPiAdapter({}), models: async () => {
          const { createPiCatalogSession } = await import('@anureo/adapter-pi/catalog')
          return piModels((await createPiCatalogSession({ cwd: options.cwd })).models)
        } }
      }
      case 'acp': {
        const { createAcpAdapter } = await import('@anureo/adapter-acp')
        return { adapter: createAcpAdapter({ command: command as string, ...(options.harnessArgs?.length && { args: options.harnessArgs }) }) }
      }
    }
  } catch (cause) {
    if (options.verbose) io.err(`anureo: failed to load ${harness} adapter: ${(cause as Error).message}\n`)
    throw cause
  }
}

/** Run one turn and print the stream/result contract; returns 0 completed/interrupted or 2 failed. */
export async function runTurn(options: RunOptions, io: RunIo): Promise<number> {
  let client: Client | undefined
  let backend: Client | undefined
  // Aborts the event drain on result/submit failure; events are observation only.
  const drainAbort = new AbortController()
  try {
    const { harness } = options
    const backendName = harness.name === 'swarm' ? harness.backend : harness.name
    const native = await createAdapter(backendName, options, io)
    const nativeAdapter = native.adapter
    const identity = {
      adapterId: harness.name,
      runtimeConfigId: harness.name === 'swarm' ? `cli:${backendName}` : 'cli',
    }
    let adapter: HarnessAdapter
    let sessionInstructions: string | undefined
    if (harness.name === 'swarm') {
      const { createSwarmAdapter } = await import('@anureo/adapter-swarm')
      const { findProjectRoot, loadBeeProfiles, profileStorageInstructions } = await import('./profiles')
      const project = await findProjectRoot(options.cwd)
      sessionInstructions = profileStorageInstructions(project, options.homeDirectory)
      const profiles = await loadBeeProfiles(options.cwd, options.homeDirectory)
      if (options.verbose) {
        for (const { profile, source, sourceFile } of profiles) io.err(`anureo: bee @${source.scope}/${profile.id} from ${sourceFile}\n`)
      }
      backend = await createClient({
        adapter: nativeAdapter,
        identity: { adapterId: backendName, runtimeConfigId: 'cli-swarm' },
      })
      let profileReview: SwarmAdapterOptions['profileReview']
      if (options.reviewProfile) {
        const { saveProfileProposal } = await import('./profile-review')
        profileReview = {
          feedback: options.reviewFeedback,
          async onResult(review) {
            const label = `anureo: profile review @${review.profileSource ? review.profileSource.scope + '/' : ''}${review.profileId}`
            const usage = review.usage?.cacheRead === undefined ? '' : ` (cacheRead=${review.usage.cacheRead})`
            if (review.status === 'proposed') {
              try {
                const file = await saveProfileProposal(project, review, review.sourceFile)
                io.err(`${label}: saved ${file}${usage}\n`)
              } catch (cause) {
                io.err(`${label}: cannot save proposal: ${(cause as Error).message}\n`)
              }
            } else {
              const detail = review.status === 'skipped' ? review.reason : review.code
              io.err(`${label}: ${review.status}: ${detail}${usage}\n`)
            }
          },
        }
      }
      const modelCatalog = await loadSwarmModelCatalog(native.models, message => { if (options.verbose) io.err(`anureo: ${message}\n`) })
      adapter = createSwarmAdapter({ backend, profileEntries: profiles, profileReview, modelCatalog })
    } else {
      adapter = nativeAdapter
    }
    client = await createClient({ adapter, identity })
    const permissionMode = options.sandbox && PERMISSION_MODE[backendName]?.[options.sandbox]
    const session = options.resume
      ? await client.sessions.resume({
          binding: { ...identity, sessionId: options.resume },
          cwd: options.cwd,
        }, { timeoutMs: DISPATCH_TIMEOUT_MS })
      : await client.sessions.create({
          cwd: options.cwd,
          ...(sessionInstructions && { instructions: sessionInstructions }),
          ...(options.model && { model: options.model }),
          ...(permissionMode && { permissionMode }),
        }, { timeoutMs: DISPATCH_TIMEOUT_MS })
    if (options.verbose) {
      const label = harness.name === 'swarm' ? `swarm:${backendName}` : backendName
      io.err(`anureo: session ${session.binding.sessionId} on ${label}\n`)
    }

    // Drain ordered session events in the background; abort releases a pending read.
    const draining = (async () => {
      try {
        for await (const event of session.events({ signal: drainAbort.signal })) {
          if (options.output === 'stream') printEvent(event as AhpEvent, io.out)
          if ((event as AhpEvent).type === 'turn/completed') break
        }
      } catch { /* aborted or session closed after failure */ }
    })()

    const turn = await session.submit({
      input: options.prompt,
      ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema as never } : {}),
    }, { timeoutMs: DISPATCH_TIMEOUT_MS })
    const result = await turn.result({ timeoutMs: harness.name === 'swarm' ? null : DISPATCH_TIMEOUT_MS })
    await draining

    if (options.output === 'result') printResult(result, session.binding, io.out)
    else if (result.status !== 'completed' && result.error && options.verbose) {
      io.err(`anureo: turn ${result.status}: ${result.error.code} ${result.error.message}\n`)
    }
    return result.status === 'failed' ? 2 : 0
  } catch (cause) {
    // Startup/submit failures are not session events: report on stderr, keep stdout empty or event-pure.
    drainAbort.abort()
    io.err(`anureo: ${(cause as Error).message ?? String(cause)}\n`)
    return 2
  } finally {
    await client?.dispose().catch(() => {})
    await backend?.dispose().catch(() => {})
  }
}
