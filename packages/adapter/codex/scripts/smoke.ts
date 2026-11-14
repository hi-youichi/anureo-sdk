/** Runs an explicitly configured native smoke with isolated state and cleanup; it must not select accounts or grant execution approvals. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type Client, type Session } from '@anureo/sdk'
import { createCodexAdapter, type CodexNativeAdapter } from '../src'

/** Successful evidence returned by collectSmokeEvidence for stdout; scope limits what acceptance can claim, and offline reconciliation is read-only. */
type SmokeResult = {
  status: 'passed'
  version: string
  /** The cwd is temporary; the live account home is explicitly provisioned and retained. */
  isolatedState: true
} & (
  | {
    scope: 'offline-version-handshake-open-close'
    authenticatedTurn: false
    /** Whether a post-close probe found terminal native execution evidence; false is inconclusive. */
    reconciliationStopped?: boolean
  }
  | { scope: 'authenticated-turn' }
)

/** Validated CLI launch input; authenticated runs require an explicitly provisioned account directory, while offline runs create one in temporary state. */
type SmokeConfiguration = { command: string } & (
  | { mode: 'offline' }
  | { mode: 'authenticated'; codexHome: string }
)

/** Read CLI/environment controls for the entry point without I/O; return undefined when live smoke is disabled, or throw the existing configuration errors before creating state. */
function readSmokeConfiguration(): SmokeConfiguration | undefined {
  const offline = process.argv.includes('--offline')
  if (!offline && process.env.COWORK_HX_CODEX_SMOKE !== '1') return undefined
  const command = process.env.COWORK_HX_CODEX_EXECUTABLE
  if (!command) throw new Error('COWORK_HX_CODEX_EXECUTABLE must name an explicit Codex executable')
  if (offline) return { command, mode: 'offline' }
  const codexHome = process.env.COWORK_HX_CODEX_HOME
  if (!codexHome) throw new Error('COWORK_HX_CODEX_HOME must point to an explicitly provisioned new-path account directory')
  return { command, mode: 'authenticated', codexHome }
}

/** For runAuthenticatedTurn, drain the open session until it publishes turn/completed, cancelling every interaction without authorizing tools. Reject request/stream failures or premature EOF; the smoke owner disposes the session. */
async function observeNativeTurnCompletion(session: Session) {
  for await (const event of session.events()) {
    if (event.type === 'interaction/requested') {
      await session.request('interaction/cancel', {
        requestId: `cancel:${event.payload.interactionId}`,
        sessionId: session.binding.sessionId,
        interactionId: event.payload.interactionId,
        reason: 'smoke_non_authorizing',
      })
    }
    if (event.type === 'turn/completed') return event.payload
  }
  throw new Error('Stream ended before turn completion')
}

/** Submit the acceptance prompt on an open session and await both SDK result and native completion; reject failures or non-completed status. collectSmokeEvidence closes on success; runSmoke owns final disposal. */
async function runAuthenticatedTurn(session: Session): Promise<void> {
  // Subscribe before submitting: native completion and interaction requests may precede the submit response.
  const nativeTurnCompletion = observeNativeTurnCompletion(session)
  const turn = await session.submit({ input: 'Reply with the single word OK. Do not run tools or change files.' })
  await turn.result()
  const nativeTurnOutcome = await nativeTurnCompletion
  if (nativeTurnOutcome.status !== 'completed') throw new Error(`Native turn ended with ${nativeTurnOutcome.status}`)
}

/** For runSmoke, initialize/open in isolated cwd, optionally execute a turn, close, then return scoped evidence after offline reconciliation. Propagate native failures; the caller owns final disposal even if a phase fails. */
async function collectSmokeEvidence({ adapter, client, temporary, mode }: {
  adapter: CodexNativeAdapter
  client: Client
  temporary: string
  mode: SmokeConfiguration['mode']
}): Promise<SmokeResult> {
  const initialized = await adapter.initialize({ protocolVersions: [1], protocolContract: 'native-lifecycle', clientInfo: { name: 'anureo-harness-smoke', version: '0.1.0' }, clientCapabilities: { interactions: ['approval'] } })
  const session = await client.sessions.create({ cwd: temporary, permissionMode: 'never' })
  let result: SmokeResult
  if (mode === 'offline') {
    result = { status: 'passed', scope: 'offline-version-handshake-open-close', version: initialized.runtime.version, isolatedState: true, authenticatedTurn: false }
  } else {
    await runAuthenticatedTurn(session)
    result = { status: 'passed', scope: 'authenticated-turn', version: initialized.runtime.version, isolatedState: true }
  }
  await session.close()
  if (result.scope === 'offline-version-handshake-open-close') result.reconciliationStopped = (await adapter.inspectExecution(session.binding, 'no-authenticated-turn')).stopped
  return result
}

/** Run validated CLI configuration: create isolated state/client, print acceptance evidence, then dispose the client before deleting temporary files. Cleanup begins only after client creation succeeds; disposal failure prevents file removal. Propagate setup, execution and sequential cleanup failures; preserve the provisioned live home. */
async function runSmoke(configuration: SmokeConfiguration): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'anureo codex smoke '))
  const codexHome = configuration.mode === 'offline' ? path.join(temporary, 'codex-home') : configuration.codexHome
  await mkdir(codexHome, { recursive: true })
  // Account selection must be explicit; inherited HOME/USERPROFILE and account variables could silently select another account.
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    CODEX_HOME: codexHome,
    ...(configuration.mode === 'offline' ? {} : {
      OPENAI_API_KEY: process.env.COWORK_HX_CODEX_API_KEY,
      OPENAI_BASE_URL: process.env.COWORK_HX_CODEX_BASE_URL,
    }),
  }
  const adapter = createCodexAdapter({ command: configuration.command, env, timeoutMs: 120_000 })
  const client = await createClient({ adapter, identity: { adapterId: 'codex', runtimeConfigId: 'smoke' }, interactions: { approval: undefined } })
  try {
    const result = await collectSmokeEvidence({ adapter, client, temporary, mode: configuration.mode })
    console.log(JSON.stringify(result))
  } finally {
    // Native processes must release cwd/state before its files are removed.
    await client.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
}

const configuration = readSmokeConfiguration()
if (!configuration) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'Set COWORK_HX_CODEX_SMOKE=1 and explicit executable/home for a real authenticated turn; skipped is not acceptance evidence' }))
  process.exit(0)
}
await runSmoke(configuration)
