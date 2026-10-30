import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHarnessRuntime } from '@anureo/sdk'
import { createCodexAdapter } from '../src'

const offline = process.argv.includes('--offline')
if (!offline && process.env.COWORK_HX_CODEX_SMOKE !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'Set COWORK_HX_CODEX_SMOKE=1 and explicit executable/home for a real authenticated turn; skipped is not acceptance evidence' }))
  process.exit(0)
}
const command = process.env.COWORK_HX_CODEX_EXECUTABLE
if (!command) throw new Error('COWORK_HX_CODEX_EXECUTABLE must name an explicit Codex executable')
if (!offline && !process.env.COWORK_HX_CODEX_HOME) throw new Error('COWORK_HX_CODEX_HOME must point to an explicitly provisioned new-path account directory')
const temporary = await mkdtemp(path.join(tmpdir(), 'anureo codex smoke '))
const home = offline ? path.join(temporary, 'codex-home') : process.env.COWORK_HX_CODEX_HOME!
await mkdir(home, { recursive: true })
// Deliberately avoid inheriting old account environment variables or HOME/USERPROFILE.
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CODEX_HOME: home,
  ...(offline ? {} : { OPENAI_API_KEY: process.env.COWORK_HX_CODEX_API_KEY, OPENAI_BASE_URL: process.env.COWORK_HX_CODEX_BASE_URL }) }
const adapter = createCodexAdapter({ command, env, timeoutMs: 120_000 })
const runtime = createHarnessRuntime(adapter)
try {
  const initialized = await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'anureo-harness-smoke', version: '0.1.0' }, clientCapabilities: { interactions: ['approval'] } })
  const session = await runtime.openSession({ requestId: 'smoke-open', mode: 'new', binding: { sessionId: 'smoke-session', adapterId: 'codex', runtimeConfigId: 'smoke' }, cwd: temporary, permissionMode: 'never' })
  let result: Record<string, unknown>
  if (offline) {
    result = { status: 'passed', scope: 'offline-version-handshake-open-close', version: initialized.runtime.version, isolatedState: true, authenticatedTurn: false }
  } else {
    const collection = (async () => {
      for await (const event of session.events()) {
        // This smoke never grants command/file execution automatically.
        if (event.type === 'interaction/requested') await session.cancelInteraction({ requestId: `cancel:${event.payload.interactionId}`, sessionId: session.binding.sessionId, interactionId: event.payload.interactionId, reason: 'smoke_non_authorizing' })
        if (event.type === 'turn/completed') return event.payload
      }
      throw new Error('Stream ended before turn completion')
    })()
    await session.startTurn({ requestId: 'smoke-start', sessionId: session.binding.sessionId, turnId: 'smoke-turn', input: [{ type: 'text', text: 'Reply with the single word OK. Do not run tools or change files.' }] })
    const terminal = await collection
    if (terminal.status !== 'completed') throw new Error(`Native turn ended with ${terminal.status}`)
    result = { status: 'passed', scope: 'authenticated-turn', version: initialized.runtime.version, isolatedState: true }
  }
  await session.close()
  if(offline) result.reconciliationStopped = (await adapter.inspectExecution(session.binding, 'no-authenticated-turn')).stopped
  console.log(JSON.stringify(result))
} finally { await runtime.dispose(); await rm(temporary, { recursive: true, force: true }) }
