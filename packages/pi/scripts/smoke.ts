/**
 * Live smoke against the installed Pi SDK.
 *
 *   bun scripts/smoke.ts                       offline: opens an in-memory Pi session, lists models, disposes
 *   PI_SMOKE_MODEL=provider/id bun scripts/smoke.ts   also runs one real prompt (needs credentials in Pi's agentDir/env)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@anureo/sdk'
import { createPiAdapter, createPiCatalogSession } from '../src/index'

const dir = await mkdtemp(join(tmpdir(), 'anureo-pi-smoke-'))
const agentDir = process.env.PI_SMOKE_USE_HOME_AGENT_DIR ? undefined : join(dir, 'agent')
try {
  const { models } = await createPiCatalogSession({ cwd: dir, ...(agentDir ? { agentDir } : {}) })
  console.log(`catalog: ${models.length} model(s) available`)

  const model = process.env.PI_SMOKE_MODEL
  const adapter = createPiAdapter({ persistSessions: false, ...(agentDir ? { agentDir } : {}) })
  const client = await createClient({ adapter, identity: { adapterId: 'pi', runtimeConfigId: 'smoke' } })
  try {
    const session = await client.sessions.create({ cwd: dir, ...(model ? { model } : {}), config: { permissionMode: 'read-only' } })
    console.log('session opened:', session.snapshot.binding.nativeRef)
    if (model) {
      const turn = await session.submit({ input: 'Reply with the single word: pong' }, { timeoutMs: 60_000 })
      const result = await turn.result({ timeoutMs: 120_000 })
      console.log(`turn ${result.status}:`, result.text.slice(0, 200))
      if (result.status !== 'completed') process.exitCode = 1
    } else console.log('PI_SMOKE_MODEL not set: skipped the live prompt')
    await session.close()
  } finally { await client.dispose() }
} finally { await rm(dir, { recursive: true, force: true }) }
