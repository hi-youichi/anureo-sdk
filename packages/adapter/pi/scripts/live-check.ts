/**
 * Live end-to-end check of persisted sessions: submit, history, fork through a turn, resume, interrupt.
 *   PI_SMOKE_MODEL=provider/id bun scripts/live-check.ts   (needs Pi credentials)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HistoryPage } from '@anureo/protocol'
import { createClient, type Client, type Session } from '@anureo/sdk'
import { createPiAdapter } from '../src/index'

const TURN_TIMEOUT_MS = 120_000
const model = process.env.PI_SMOKE_MODEL
if (!model) {
  console.error('Set PI_SMOKE_MODEL=provider/id')
  process.exit(2)
}
const dir = await mkdtemp(join(tmpdir(), 'anureo-pi-live-'))
const client = await createClient({
  adapter: createPiAdapter({ sessionDir: join(dir, 'sessions'), version: (await import('@earendil-works/pi-coding-agent')).VERSION }),
  identity: { adapterId: 'pi', runtimeConfigId: 'live' },
})
try {
  const session = await client.sessions.create({ cwd: dir, model, config: { permissionMode: 'read-only' } })
  const firstTurnId = await checkTurns(session)
  await checkFork({ client, session, firstTurnId })
  await checkResumeAndInterrupt({ client, session })
} finally {
  await client.dispose()
  await rm(dir, { recursive: true, force: true })
}

/** Check continuity and the parent's history, then return the first turn ID as the fork boundary. */
async function checkTurns(session: Session): Promise<string> {
  const one = await session.submit({ input: 'Remember the number 42. Reply with just: ok' })
  check('first turn completed', (await one.result({ timeoutMs: TURN_TIMEOUT_MS })).status === 'completed')
  const answer = await recallNumber(session)
  check('context kept across turns', answer.status === 'completed' && answer.text.includes('42'), answer)
  const page = await history(session)
  check(
    'history has user + assistant items',
    userMessageCount(page) === 2 && page.items.some(entry => entry.item.type === 'agentMessage'),
    page.items.map(entry => entry.item.type),
  )
  return one.id
}

/** Check the child through the first turn and close it on success. The script's client owns failure cleanup. */
async function checkFork({ client, session, firstTurnId }: { client: Client; session: Session; firstTurnId: string }): Promise<void> {
  const forked = await client.sessions.fork(session.reference, { boundary: { turnId: firstTurnId, relation: 'through' } })
  check('fork through turn 1 keeps one user message', userMessageCount(await history(forked)) === 1)
  const branch = await recallNumber(forked)
  check('fork continues with parent context', branch.status === 'completed' && branch.text.includes('42'), branch)
  await forked.close()
}

/** Reopen the parent and check its history and interrupt status. Close on success, with client cleanup on failure. */
async function checkResumeAndInterrupt({ client, session }: { client: Client; session: Session }): Promise<void> {
  const reference = session.reference
  await session.close()
  const resumed = await client.sessions.resume(reference)
  check('resume restores history', userMessageCount(await history(resumed)) === 2)
  const long = await resumed.submit({ input: 'Count slowly from 1 to 500, one number per line.' })
  setTimeout(() => { void resumed.interrupt() }, 2500)
  const stopped = await long.result({ timeoutMs: TURN_TIMEOUT_MS })
  check('interrupt ends the turn as interrupted', stopped.status === 'interrupted', stopped.status)
  await resumed.close()
}

/** Run the same context probe on the parent and child, resolving when the turn result is ready. */
async function recallNumber(session: Session) {
  const turn = await session.submit({ input: 'What number did I ask you to remember? Reply with just the number.' })
  return turn.result({ timeoutMs: TURN_TIMEOUT_MS })
}

/** Request a fresh first page of history for the live assertions. */
function history(session: Session) {
  return session.request('history/read', { sessionId: session.id, requestId: randomUUID() })
}

function userMessageCount(page: HistoryPage): number {
  return page.items.filter(entry => entry.item.type === 'userMessage').length
}

/** Report a failed assertion through the process exit code while allowing later checks to run. */
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`)
  if (!ok) process.exitCode = 1
}
