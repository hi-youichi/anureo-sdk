import { expect, test } from 'bun:test'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '../src/git'
import { saveReport } from '../src/report-store'
import { formatReport } from '../src/report'
import type { RefactorReport } from '../src/results'
import { withRun } from '../src/run-lifecycle'
import { fixture } from './helpers'

test('lifecycle holds the lock through body execution and records synchronous observer failures in order', async () => {
  const context = await fixture()
  const child = join(context.cwd, 'child')
  await mkdir(child)
  const events: string[] = []
  let competingBodyRan = false
  const report = await withRun({
    ...context,
    onProgress: event => {
      events.push(event)
      if (events.length === 1) throw Object.create(null)
      throw new Error(`Observer ${events.length}`)
    },
  }, async (report, progress) => {
    expect(report.status).toBe('incomplete')
    expect(events).toEqual([`run: ${report.directory}`])
    for (const cwd of [context.cwd, child]) {
      await expect(withRun({ ...context, cwd }, async () => { competingBodyRan = true })).rejects.toThrow('Cannot acquire refactor lock')
    }
    expect((await stat(join(context.cwd, '.anureo/refactor/writer.lock'))).isFile()).toBe(true)
    progress('body: finished')
  })
  expect(competingBodyRan).toBe(false)
  expect(events).toEqual([`run: ${report.directory}`, 'body: finished'])
  expect(report.status).toBe('completed')
  expect(report.progressErrors).toEqual(['Error details could not be displayed', 'Observer 2'])
  await expectFinalizedRun(report)

  const nested = await withRun({ ...context, cwd: child }, async () => {})
  expect(nested.directory).toBe(join(child, '.anureo/refactor', nested.runId))
  await expectFinalizedRun(nested, context.cwd)
})

test('lifecycle publishes classified body failures before releasing the lock', async () => {
  const context = await fixture()
  const report = await withRun(context, async () => {
    throw Object.assign(new Error('Body unavailable'), {
      code: 'RECEIPT_LOST', outcomeUnknown: true, retryable: true,
      details: { cleanupErrors: ['Release unavailable'], issues: [
        { path: '/summary', code: 'type', message: 'Omit this detail' },
        { path: ['modules', 0], code: 'invalid_type' },
        { path: [-1], code: 'ignored' },
      ] },
    })
  })
  expect(report.status).toBe('incomplete')
  expect(report.errors).toEqual(['Body unavailable'])
  expect(report.failure).toEqual({
    code: 'RECEIPT_LOST', outcomeUnknown: true, cleanupFailed: true, retryable: true,
    issues: [{ path: '/summary', code: 'type' }, { path: ['modules', 0], code: 'invalid_type' }],
  })
  expect(formatReport(report)).toContain('Agent execution outcome is unknown')
  expect(formatReport(report)).toContain('Validation issue: /summary [type]')
  expect(formatReport(report)).toContain('Validation issue: ["modules",0] [invalid_type]')
  await expectFinalizedRun(report)
})

test('run artifacts are ignored without a repository ignore rule', async () => {
  const context = await fixture()
  await rm(join(context.cwd, '.gitignore'))
  const report = await withRun(context, async () => {})
  await expectFinalizedRun(report)
  expect(await git(context.cwd, 'ls-files', '--others', '--exclude-standard')).toBe('')
})

test('storage setup failures retain their filesystem diagnostic and release the checkout lock', async () => {
  const context = await fixture()
  const child = join(context.cwd, 'child')
  const obstruction = join(child, '.anureo')
  await mkdir(child)
  await writeFile(obstruction, '')
  let bodyRan = false
  await expect(withRun({ ...context, cwd: child }, async () => { bodyRan = true }))
    .rejects.toMatchObject({ path: join(obstruction, 'refactor') })
  expect(bodyRan).toBe(false)
  await expect(stat(join(context.cwd, '.anureo/refactor/writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

// Obstruct real paths to exercise finalization diagnostics without replacing filesystem calls.
test.each([
  { publicationFails: true, removalFails: false },
  { publicationFails: false, removalFails: true },
  { publicationFails: true, removalFails: true },
])('finalization handles publication failure $publicationFails and removal failure $removalFails', async ({ publicationFails, removalFails }) => {
  const context = await fixture()
  const lockPath = join(await realpath(context.cwd), '.anureo/refactor/writer.lock')
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
  const temporaryReport = join(directory, 'report.json.tmp')
  if (publicationFails && removalFails) {
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([
      expect.objectContaining({ path: temporaryReport }),
      expect.objectContaining({ path: lockPath }),
    ])
    expect(error.message).toContain(temporaryReport)
    expect(error.message).toContain(lockPath)
  } else {
    expect(error).toMatchObject({ path: removalFails ? lockPath : temporaryReport })
  }
  const saved = await readFile(join(directory, 'report.json'), 'utf8')
  if (publicationFails) expect(saved).toBe(checkpoint)
  else expect(JSON.parse(saved).status).toBe('completed')
  if (removalFails) expect((await stat(lockPath)).isDirectory()).toBe(true)
  else await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

/** Assert the returned record was fully published and writer ownership was released. */
async function expectFinalizedRun(report: RefactorReport, checkout = report.cwd): Promise<void> {
  const saved = await readFile(join(report.directory, 'report.json'), 'utf8')
  expect(JSON.parse(saved)).toEqual(report)
  expect(saved.endsWith('\n')).toBe(true)
  await expect(stat(join(report.directory, 'report.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(checkout, '.anureo/refactor/writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
}
