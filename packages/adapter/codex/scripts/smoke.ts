/** Runs the package smoke command against an explicit Codex binary with a temporary session cwd. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type Client, type Session } from '@anureo/sdk'
import { createCodexAdapter, type CodexNativeAdapter } from '../src'

/** Evidence that runSmoke prints after the session closes and any offline probe returns. */
type SmokeResult = {
  status: 'passed'
  version: string
  /** The session cwd is temporary. An authenticated run retains its supplied account home. */
  isolatedState: true
} & (
  | {
    scope: 'offline-version-handshake-open-close'
    authenticatedTurn: false
    /** Whether the post-close probe found a matching terminal turn on an idle thread. */
    reconciliationStopped: boolean
  }
  | { scope: 'authenticated-turn' }
)

/** Launch inputs accepted by the CLI. An authenticated caller supplies the account directory. */
type SmokeConfiguration = { command: string } & (
  | { mode: 'offline' }
  | { mode: 'authenticated'; codexHome: string }
)

/**
 * Select offline mode for --offline, otherwise run an authenticated turn only when
 * COWORK_HX_CODEX_SMOKE is 1. Return undefined for a disabled run. Either mode requires an explicit
 * executable and authenticated mode also requires an explicit home. Throw before creating files if
 * a required value is missing.
 */
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

/**
 * Subscribe for runAuthenticatedTurn before it submits the prompt. Await cancellation requests for
 * published interactions and return the first turn/completed payload. Propagate request and stream
 * rejections, or reject if the stream ends early. The subscription ends on return or failure.
 */
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

/**
 * Submit the smoke prompt on collectSmokeEvidence's new session. Await the SDK result before
 * checking the observed native terminal status. Propagate submission or observation rejections
 * and reject any terminal status other than completed. collectSmokeEvidence closes on success.
 */
async function runAuthenticatedTurn(session: Session): Promise<void> {
  // Subscribe before submitting: native completion and interaction requests may precede the submit response.
  const nativeTurnCompletion = observeNativeTurnCompletion(session)
  const turn = await session.submit({ input: 'Reply with the single word OK. Do not run tools or change files.' })
  await turn.result()
  const nativeTurnOutcome = await nativeTurnCompletion
  if (nativeTurnOutcome.status !== 'completed') throw new Error(`Native turn ended with ${nativeTurnOutcome.status}`)
}

/**
 * Open the smoke session in the temporary cwd and, in authenticated mode, wait for the prompt to
 * complete. Await close before an offline reconciliation probe and before returning either result.
 * Propagate failures from those steps to runSmoke, which owns client disposal.
 */
async function collectSmokeEvidence({ adapter, client, temporary, mode }: {
  adapter: CodexNativeAdapter
  client: Client
  temporary: string
  mode: SmokeConfiguration['mode']
}): Promise<SmokeResult> {
  // Client creation already negotiated with the adapter, which caches the version probe.
  const initialized = await adapter.initialize({
    protocolVersions: [1],
    protocolContract: 'native-lifecycle',
    clientInfo: { name: 'anureo-harness-smoke', version: '0.1.0' },
    clientCapabilities: { interactions: ['approval'] },
  })
  const session = await client.sessions.create({ cwd: temporary, permissionMode: 'never' })
  if (mode === 'authenticated') await runAuthenticatedTurn(session)
  const version = initialized.runtime.version
  await session.close()
  if (mode === 'authenticated') {
    return { status: 'passed', scope: 'authenticated-turn', version, isolatedState: true }
  }
  // There was no submitted turn. Use the sentinel to exercise the read-only probe path.
  const inspection = await adapter.inspectExecution(session.binding, 'no-authenticated-turn')
  return {
    status: 'passed',
    scope: 'offline-version-handshake-open-close',
    version,
    isolatedState: true,
    authenticatedTurn: false,
    reconciliationStopped: inspection.stopped,
  }
}

/**
 * Prepare the selected Codex home and initialize a client for runSmoke. Offline mode creates its
 * home below the temporary cwd. Authenticated mode uses the supplied home and passes through
 * optional smoke API credentials and base URL. Setup errors reject. On success runSmoke owns
 * disposal of the returned client, which owns the adapter.
 */
async function createSmokeClient({ configuration, temporary }: {
  configuration: SmokeConfiguration
  temporary: string
}): Promise<{ adapter: CodexNativeAdapter; client: Client }> {
  const { command, mode } = configuration
  const codexHome = mode === 'offline' ? path.join(temporary, 'codex-home') : configuration.codexHome
  await mkdir(codexHome, { recursive: true })
  // Inherited home and account variables could silently select a different account.
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    CODEX_HOME: codexHome,
    ...(mode === 'authenticated' ? {
      OPENAI_API_KEY: process.env.COWORK_HX_CODEX_API_KEY,
      OPENAI_BASE_URL: process.env.COWORK_HX_CODEX_BASE_URL,
    } : {}),
  }
  const adapter = createCodexAdapter({ command, env, timeoutMs: 120_000 })
  const client = await createClient({
    adapter,
    identity: { adapterId: 'codex', runtimeConfigId: 'smoke' },
    interactions: { approval: undefined },
  })
  return { adapter, client }
}

/**
 * Run the selected CLI mode and print evidence before teardown. After client creation succeeds,
 * await disposal before removing the temporary directory. Setup, smoke and cleanup errors reject.
 * A disposal rejection takes precedence over a smoke failure and prevents file removal.
 */
async function runSmoke(configuration: SmokeConfiguration): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'anureo codex smoke '))
  const { adapter, client } = await createSmokeClient({ configuration, temporary })
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
