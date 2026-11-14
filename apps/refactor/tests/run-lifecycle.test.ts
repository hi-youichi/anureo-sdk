import { expect, test } from 'bun:test'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { saveReport } from '../src/report-store'
import type { RefactorReport } from '../src/results'
import { withRun } from '../src/run-lifecycle'
import { fixture } from './helpers'

test('lifecycle holds the lock through body execution and records synchronous observer failures in order', async () => {
  const context = await fixture()
  const events: string[] = []
  let competingBodyRan = false
  const report = await withRun({
    ...context,
    onProgress: event => {
      events.push(event)
      throw new Error(`Observer ${events.length}`)
    },
  }, async (report, progress) => {
    expect(report.status).toBe('incomplete')
    expect(events).toEqual([`run: ${report.directory}`])
    await expect(withRun(context, async () => { competingBodyRan = true })).rejects.toThrow('Cannot acquire refactor lock')
    expect((await stat(join(context.cwd, '.anureo/refactor/writer.lock'))).isFile()).toBe(true)
    progress('body: finished')
  })
  expect(competingBodyRan).toBe(false)
  expect(events).toEqual([`run: ${report.directory}`, 'body: finished'])
  expect(report.status).toBe('completed')
  expect(report.progressErrors).toEqual(['Observer 1', 'Observer 2'])
  await expectFinalizedRun(report)
})

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
  await expectFinalizedRun(report)
})

// Obstruct real paths so failure precedence is exercised without replacing filesystem calls.
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
  if (removalFails) expect((await stat(lockPath)).isDirectory()).toBe(true)
  else await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

/** Assert the returned record was fully published and writer ownership was released. */
async function expectFinalizedRun(report: RefactorReport): Promise<void> {
  const saved = await readFile(join(report.directory, 'report.json'), 'utf8')
  expect(JSON.parse(saved)).toEqual(report)
  expect(saved.endsWith('\n')).toBe(true)
  await expect(stat(join(report.directory, 'report.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(report.cwd, '.anureo/refactor/writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
}
