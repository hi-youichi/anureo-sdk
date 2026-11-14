/**
 * Live end-to-end check of persisted sessions: submit, history, fork through a turn, resume, interrupt.
 *   PI_SMOKE_MODEL=provider/id bun scripts/live-check.ts   (needs Pi credentials)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@anureo/sdk'
import { createPiAdapter } from '../src/index'

const model = process.env.PI_SMOKE_MODEL
if (!model) { console.error('Set PI_SMOKE_MODEL=provider/id'); process.exit(2) }
const dir = await mkdtemp(join(tmpdir(), 'anureo-pi-live-'))
const check = (label: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`); if (!ok) process.exitCode = 1 }
const client = await createClient({
  adapter: createPiAdapter({ sessionDir: join(dir, 'sessions'), version: (await import('@earendil-works/pi-coding-agent')).VERSION }),
  identity: { adapterId: 'pi', runtimeConfigId: 'live' },
})
const history = (s: { id: string; request: Function }) => s.request('history/read', { sessionId: s.id, requestId: randomUUID() }) as Promise<{ items: Array<{ item: { type: string } }> }>
try {
  const session = await client.sessions.create({ cwd: dir, model, config: { permissionMode: 'read-only' } })
  const one = await session.submit({ input: 'Remember the number 42. Reply with just: ok' })
  check('first turn completed', (await one.result({ timeoutMs: 120_000 })).status === 'completed')
  const two = await session.submit({ input: 'What number did I ask you to remember? Reply with just the number.' })
  const answer = await two.result({ timeoutMs: 120_000 })
  check('context kept across turns', answer.status === 'completed' && answer.text.includes('42'), answer)
  const page = await history(session)
  check('history has user + assistant items', page.items.filter(i => i.item.type === 'userMessage').length === 2 && page.items.some(i => i.item.type === 'agentMessage'), page.items.map(i => i.item.type))

  const forked = await client.sessions.fork(session.reference, { boundary: { turnId: one.id, relation: 'through' } })
  check('fork through turn 1 keeps one user message', (await history(forked)).items.filter(i => i.item.type === 'userMessage').length === 1)
  const branch = await (await forked.submit({ input: 'What number did I ask you to remember? Reply with just the number.' })).result({ timeoutMs: 120_000 })
  check('fork continues with parent context', branch.status === 'completed' && branch.text.includes('42'), branch)
  await forked.close()

  const reference = session.reference
  await session.close()
  const resumed = await client.sessions.resume(reference)
  check('resume restores history', (await history(resumed)).items.filter(i => i.item.type === 'userMessage').length === 2)
  const long = await resumed.submit({ input: 'Count slowly from 1 to 500, one number per line.' })
  setTimeout(() => { void resumed.interrupt() }, 2500)
  const stopped = await long.result({ timeoutMs: 120_000 })
  check('interrupt ends the turn as interrupted', stopped.status === 'interrupted', stopped.status)
  await resumed.close()
} finally { await client.dispose(); await rm(dir, { recursive: true, force: true }) }
