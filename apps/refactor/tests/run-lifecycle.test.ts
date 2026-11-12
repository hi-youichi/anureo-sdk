// Verifies lock ownership, publication and error precedence; it must not reproduce orchestration phases.
import { expect, test } from 'bun:test'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { saveReport } from '../src/report-store'
import { withRun } from '../src/run-lifecycle'
import { fixture } from './helpers'

/** Attempt a competing run inside the body so exclusivity is checked while the first writer is active.
 * Shared fixture cleanup owns the client and temporary storage after final publication assertions. */
test('lifecycle holds the lock through body execution and records synchronous observer failures in order', async () => {
  const context = await fixture()
  const events: string[] = []
  let competingBodyRan = false
  const report = await withRun({ ...context,
    /** Fail each synchronous delivery to prove observations do not gate execution or completion. */
    onProgress: event => { events.push(event); throw new Error(`Observer ${events.length}`) },
  }, async (report, progress) => {
    expect(report.status).toBe('incomplete')
    expect(events).toEqual([`run: ${report.directory}`])
    await expect(withRun(context, async () => { competingBodyRan = true })).rejects.toThrow('Cannot acquire refactor lock')
    progress('body: finished')
  })
  expect(competingBodyRan).toBe(false)
  expect(events).toEqual([`run: ${report.directory}`, 'body: finished'])
  expect(report.status).toBe('completed')
  expect(report.progressErrors).toEqual(['Observer 1', 'Observer 2'])
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
  expect(await stat(join(context.cwd, '.anureo/refactor/writer.lock')).catch(() => null)).toBeNull()
})

/** Reject the body with independent execution/cleanup signals; finalization must publish both unchanged. */
test('lifecycle publishes classified body failures before releasing the lock', async () => {
  const context = await fixture()
  const report = await withRun(context, async () => {
    throw Object.assign(new Error('Body unavailable'), {
      code: 'RECEIPT_LOST', outcomeUnknown: true, details: { cleanupErrors: ['Release unavailable'] },
    })
  })
  expect(report.status).toBe('incomplete')
  expect(report.errors).toEqual(['Body unavailable'])
  expect(report.failure).toEqual({ code: 'RECEIPT_LOST', outcomeUnknown: true, cleanupFailed: true })
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
  expect(await stat(join(context.cwd, '.anureo/refactor/writer.lock')).catch(() => null)).toBeNull()
})

/** Obstruct real filesystem paths to exercise finalization without replacing production I/O.
 * A failed publication must preserve its previous snapshot and attempt lock removal; a removal
 * failure must reject even when publication also fails. Shared fixture cleanup removes obstructions. */
test.each([
  { publicationFails: true, removalFails: false },
  { publicationFails: false, removalFails: true },
  { publicationFails: true, removalFails: true },
])('finalization handles publication failure $publicationFails and removal failure $removalFails', async ({ publicationFails, removalFails }) => {
  const context = await fixture()
  const lockPath = join(context.cwd, '.anureo/refactor/writer.lock')
  let directory = ''
  let checkpoint = ''
  const run = withRun(context, async report => {
    directory = report.directory
    await saveReport(report)
    checkpoint = await readFile(join(directory, 'report.json'), 'utf8')
    if (publicationFails) await mkdir(join(directory, 'report.json.tmp'))
    if (removalFails) {
      await rm(lockPath)
      await mkdir(lockPath)
    }
  })
  const error = await run.then(() => null, cause => cause)
  expect(error).toMatchObject({ path: removalFails ? lockPath : join(directory, 'report.json.tmp') })
  const saved = await readFile(join(directory, 'report.json'), 'utf8')
  if (publicationFails) expect(saved).toBe(checkpoint)
  else expect(JSON.parse(saved).status).toBe('completed')
  const lock = await stat(lockPath).catch(() => null)
  if (removalFails) expect(lock?.isDirectory()).toBe(true)
  else expect(lock).toBeNull()
})
