import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, readdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { correctnessAngle, formatReport, reviewCode, type ReviewProgress } from '../src'
import { runCli } from '../src/cli'
import { fixFindings } from '../src/fix'
import { finding, fixture, isModule, output, plan, stages } from './helpers'

const exec = promisify(execFile)

const fixResult = { summary: 'Preserve zero instead of replacing it with the fallback.', changedFiles: ['a.ts'] }
const fixed = 'export const fallback = (n: number) => n\n'

/** Run a fixture Git command, rejecting the test on process failure. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args], { maxBuffer: 1 << 24 })
}

/** Commit the fixture sources so the review directory is a clean git repository. */
async function commitFixture(cwd: string): Promise<void> {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
  await git(cwd, 'init', '-q')
  await git(cwd, ...identity, 'add', '-A')
  await git(cwd, ...identity, 'commit', '-q', '-m', 'init')
}

/** Supply fixture's submit-time responder with analysis, review, fix and verification outcomes.
 * Defaults to editing a.ts only during a fix and clearing findings at verification; a custom fix
 * owns its edits and response. fixture's afterEach owns client disposal and directory removal. */
function fixFixture(options: {
  fix?: (cwd: string) => unknown | Promise<unknown>
  verify?: unknown
  review?: unknown
} = {}) {
  return fixture(async (prompt, sessionCwd) => {
    if (prompt.startsWith(stages.analyze)) return plan
    if (prompt.startsWith(stages.fix)) {
      if (options.fix) return options.fix(sessionCwd)
      await writeFile(join(sessionCwd, 'a.ts'), fixed)
      return fixResult
    }
    if (prompt.startsWith(stages.verify)) return options.verify ?? { findings: [] }
    return options.review ?? { findings: [finding] }
  })
}

const single = { maxModules: 1, angles: [correctnessAngle] }
const isModuleA = isModule('a')
const isModuleB = isModule('b')
const reviewedModules = plan.modules.slice(0, 1).map(module => ({
  module, angles: [{ angle: correctnessAngle, status: 'completed' as const, findings: [finding] }],
}))

test('module fixes start before later modules finish reviewing and are serialized', async () => {
  let fixPeak = 0
  let activeFixes = 0
  const fixStarted = Promise.withResolvers<void>()
  const { client, cwd } = await fixture(async (prompt, sessionCwd) => {
    if (prompt.startsWith(stages.analyze)) return plan
    if (prompt.startsWith(stages.fix)) {
      activeFixes++
      fixPeak = Math.max(fixPeak, activeFixes)
      fixStarted.resolve()
      const file = prompt.includes('"a.ts"') ? 'a.ts' : 'b.ts'
      await writeFile(join(sessionCwd, file), fixed)
      activeFixes--
      return { ...fixResult, changedFiles: [file] }
    }
    if (prompt.startsWith(stages.verify)) return { findings: [] }
    // Module b's review stays pending until module a's fix agent has started.
    const reviewingB = isModuleB(prompt)
    if (reviewingB) await fixStarted.promise
    return { findings: reviewingB ? [{ ...finding, file: 'b.ts' }] : [finding] }
  })
  await commitFixture(cwd)
  const events: ReviewProgress[] = []
  const report = await reviewCode({
    client, cwd, fix: true, concurrency: 2, angles: [correctnessAngle],
    onProgress: event => events.push(event),
  })
  expect(report.status).toBe('completed')
  // Tree-mutating fix agents never overlap.
  expect(fixPeak).toBe(1)
  for (const outcome of report.modules) {
    expect(outcome.fix).toMatchObject({ status: 'applied' })
    expect(outcome.verification?.angles[0]).toMatchObject({ status: 'completed', findings: [] })
  }
  // Module a's fix started while module b's review was still pending.
  const fixA = events.findIndex(event => event.stage === 'fix' && event.moduleId === 'a' && event.status === 'started')
  const bReview = events.findIndex(event => event.stage === 'review' && event.moduleId === 'b' && event.status === 'completed')
  expect(fixA).toBeGreaterThanOrEqual(0)
  expect(fixA).toBeLessThan(bReview)
  const lastFix = events.reduce((last, event, index) => event.stage === 'fix' ? index : last, -1)
  expect(events.findIndex(event => event.stage === 'verification')).toBeGreaterThan(lastFix)
})

test('final verification covers unchanged callers after a dependency fix', async () => {
  let dependencyFixed = false
  const regression = { ...finding, title: 'Missing value reaches arithmetic', lineStart: 2, lineEnd: 2 }
  const { client, cwd, prompts } = await fixture(async (prompt, sessionCwd) => {
    if (prompt.startsWith(stages.analyze)) return plan
    if (prompt.startsWith(stages.fix)) {
      await writeFile(join(sessionCwd, 'b.ts'), 'export const value = () => undefined\n')
      dependencyFixed = true
      return { summary: 'Return undefined for a missing value.', changedFiles: ['b.ts'] }
    }
    if (prompt.startsWith(stages.verify)) {
      expect(dependencyFixed).toBe(true)
      const dependency = await readFile(join(sessionCwd, 'b.ts'), 'utf8')
      return { findings: isModuleA(prompt) && dependency.includes('undefined') ? [regression] : [] }
    }
    return { findings: isModuleB(prompt) ? [{ ...finding, file: 'b.ts' }] : [] }
  })
  await writeFile(join(cwd, 'a.ts'), "import { value } from './b'\nexport const result = value() + 1\n")
  await writeFile(join(cwd, 'b.ts'), 'export const value = () => 0\n')
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, fix: true, concurrency: 2, angles: [correctnessAngle] })
  expect(report.status).toBe('completed')
  expect(report.findingCount).toBe(1)
  expect(report.modules[0]?.fix?.status).toBe('not-needed')
  expect(report.modules[0]?.review.angles[0]).toMatchObject({ findings: [] })
  expect(report.modules[0]?.verification?.angles[0]).toMatchObject({ findings: [regression] })
  expect(report.modules[1]?.fix?.status).toBe('applied')
  expect(prompts.filter(prompt => prompt.startsWith(stages.verify))).toHaveLength(2)
  expect(formatReport(report)).toContain('Missing value reaches arithmetic')
  expect(JSON.parse(await readFile(join(report.workflowDirectory, report.runId, 'result.json'), 'utf8'))).toEqual(report)
})

test.each(['scope', 'execution'] as const)('a %s failure stops queued fixes and preserves completed reviews', async failure => {
  const fixStarted = Promise.withResolvers<void>()
  const bReviewed = Promise.withResolvers<void>()
  const events: ReviewProgress[] = []
  const { client, cwd, prompts } = await fixture(async (prompt, sessionCwd) => {
    if (prompt.startsWith(stages.analyze)) return plan
    if (prompt.startsWith(stages.fix)) {
      fixStarted.resolve()
      await bReviewed.promise
      await writeFile(join(sessionCwd, failure === 'scope' ? 'b.ts' : 'a.ts'), fixed)
      return failure === 'scope' ? fixResult : new HarnessSdkError('NATIVE_FAILED', 'Failed after editing sources')
    }
    const reviewingB = isModuleB(prompt)
    if (reviewingB) await fixStarted.promise
    return { findings: [{ ...finding, file: reviewingB ? 'b.ts' : 'a.ts' }] }
  })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, fix: true, concurrency: 2, angles: [correctnessAngle], onProgress: event => {
    events.push(event)
    if (event.stage === 'review' && event.moduleId === 'b' && event.status === 'completed') bReviewed.resolve()
  } })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.fix).toMatchObject({ status: 'failed', changedFiles: [],
    error: { code: failure === 'scope' ? 'REVIEW_FIX_SCOPE' : 'NATIVE_FAILED' } })
  expect(report.modules[1]?.fix).toMatchObject({ status: 'skipped', changedFiles: [], error: null })
  expect(report.modules[1]?.fix?.summary).toContain("module a's fix failed")
  expect(report.modules.every(outcome => outcome.review.angles[0]?.status === 'completed')).toBe(true)
  expect(prompts.filter(prompt => prompt.startsWith(stages.fix))).toHaveLength(1)
  expect(events).toContainEqual({ stage: 'fix', moduleId: 'b', status: 'skipped' })
  expect(await readFile(join(cwd, failure === 'scope' ? 'b.ts' : 'a.ts'), 'utf8')).toContain('n || 1')
})

test.each(['started', 'completed', 'failed', 'skipped'] as const)('fix progress callback failure at %s preserves findings and actual edits', async status => {
  const { client, cwd } = await fixFixture({ fix: async directory => {
    if (status !== 'skipped') await writeFile(join(directory, 'a.ts'), fixed)
    return status === 'failed' ? new HarnessSdkError('NATIVE_FAILED', 'Failed after editing sources') : fixResult
  } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true, onProgress: event => {
    if (event.stage === 'fix' && event.status === status) throw new Error('Progress observer failed')
  } })
  expect(report.modules[0]?.review.angles[0]).toMatchObject({ status: 'completed', findings: [finding] })
  expect(report.modules[0]?.fix).toMatchObject({
    status: status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'applied',
    changedFiles: status === 'completed' || status === 'started' ? ['a.ts'] : [],
    error: status === 'failed' ? { code: 'NATIVE_FAILED', message: 'Failed after editing sources' } : null,
  })
  expect(report.progressErrors).toEqual([{ message: 'Progress observer failed', code: null, outcomeUnknown: false }])
  expect(report.status).toBe(status === 'failed' ? 'incomplete' : 'completed')
  expect(report.findingCount).toBe(status === 'failed' || status === 'skipped' ? 1 : 0)
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(status === 'skipped' || status === 'failed'
    ? 'export const fallback = (n: number) => n || 1\n' : fixed)
  expect(JSON.parse(await readFile(join(report.workflowDirectory, report.runId, 'result.json'), 'utf8'))).toEqual(report)
})

test.each(['completed', 'skipped'] as const)('direct fix observer failure at %s retains the reconciled outcome', async status => {
  const { client, cwd: directory } = await fixFixture({ fix: async cwd => {
    if (status === 'completed') await writeFile(join(cwd, 'a.ts'), fixed)
    return fixResult
  } })
  const cwd = await realpath(directory)
  await commitFixture(cwd)
  const events: string[] = []
  const report = await fixFindings({
    client, cwd, directory: join(cwd, '.anureo/workflows'), sourceVersion: null, modules: reviewedModules,
    onProgress: event => {
      events.push(event)
      if (event === status) throw new Error('Terminal observer failed')
    },
  })
  expect(report).toMatchObject({ status: 'failed', summary: fixResult.summary,
    changedFiles: status === 'completed' ? ['a.ts'] : [],
    error: { message: 'Terminal observer failed', code: null, outcomeUnknown: false } })
  expect(events).toEqual(['started', status, 'failed'])
  if (status === 'completed') expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(fixed)
})

test('direct fix baseline failure publishes failed and lets observer exceptions reject', async () => {
  const { client, cwd: directory, prompts } = await fixFixture()
  const cwd = await realpath(directory)
  const events: string[] = []
  const failure = new Error('Failure observer failed')
  await expect(fixFindings({
    client, cwd, directory: join(cwd, '.anureo/workflows'), sourceVersion: null, modules: reviewedModules,
    onProgress: event => {
      events.push(event)
      if (event === 'failed') throw failure
    },
  })).rejects.toBe(failure)
  expect(events).toEqual(['started', 'failed'])
  expect(prompts).toEqual([])
})

test('default review never dispatches a fix agent or writes source files', async () => {
  const { client, cwd, prompts } = await fixFixture()
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single })
  expect(report.modules[0]?.fix).toBeNull()
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(prompts).toHaveLength(2)
})

test('each agent uses a distinct worktree and verification sees integrated fixes', async () => {
  const { client, cwd, prompts, adapter } = await fixFixture()
  await commitFixture(cwd)
  const events: ReviewProgress[] = []
  const report = await reviewCode({
    client, cwd, ...single, fix: true, fixPermissionMode: 'agent',
    onProgress: event => events.push(event),
  })
  expect(report.status).toBe('completed')
  expect(report.modules[0]?.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
  expect(report.modules[0]?.review.angles[0]).toMatchObject({ findings: [finding] })
  expect(report.modules[0]?.verification).toMatchObject({ module: { id: 'a' }, angles: [{ angle: { id: 'correctness' }, status: 'completed', findings: [] }] })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(fixed)
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toContain('n || 1')
  expect(prompts).toHaveLength(4)
  expect(prompts[2]).toContain('Fix the findings by editing the listed source files in this temporary worktree.')
  expect(prompts.filter((_, index) => index !== 2).every(prompt => prompt.includes('Read and analyze source code only. Do not modify files,'))).toBe(true)
  const worktrees = adapter.opened.map(session => session.cwd)
  expect(new Set(worktrees).size).toBe(4)
  for (const worktree of worktrees) {
    expect(worktree).not.toBe(await realpath(cwd))
    await expect(access(dirname(worktree))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  // The fix session is the third opened session and is the only one with a permission mode.
  expect(adapter.opened[2]?.permissionMode).toBe('agent')
  expect(adapter.opened.filter(session => session.permissionMode !== undefined)).toHaveLength(1)
  expect(adapter.opened.every(session => session.instructions === undefined)).toBe(true)
  expect(events.filter(event => event.stage === 'fix').map(event => event.status)).toEqual(['started', 'completed'])
  expect(events.filter(event => event.stage === 'verification').map(event => event.status)).toEqual(['started', 'completed'])
  const path = join(report.workflowDirectory, report.runId)
  const journal = JSON.parse(await readFile(join(path, 'journal.json'), 'utf8'))
  expect(journal.filter((event: { type: string }) => event.type === 'result')).toHaveLength(4)
  expect((await readdir(path)).includes('fix-backups')).toBe(false)
  expect(JSON.parse(await readFile(join(path, 'result.json'), 'utf8'))).toEqual(report)
  expect(formatReport(report)).toContain('Review after fixes')
})

test('fix outside a git repository fails before dispatching a fix agent', async () => {
  const { client, cwd, prompts } = await fixFixture()
  const before = await readFile(join(cwd, 'a.ts'))
  await expect(reviewCode({ client, cwd, ...single, fix: true })).rejects.toMatchObject({
    code: 'REVIEW_FIX_INVALID', message: expect.stringContaining('git repository'),
  })
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(prompts).toHaveLength(0)
})

test.each(['unstaged', 'staged', 'untracked'])('existing %s changes do not block fixing or count as scope violations', async state => {
  const { client, cwd, prompts } = await fixFixture({ fix: async directory => {
    const path = join(directory, 'a.ts')
    await writeFile(path, (await readFile(path, 'utf8')).replace('n || 1', 'n'))
    return fixResult
  } })
  await commitFixture(cwd)
  const existing = 'existing unrelated changes\n'
  await writeFile(join(cwd, 'notes.md'), existing)
  if (state !== 'untracked') {
    await writeFile(join(cwd, 'a.ts'), 'export const fallback = (n: number) => n || 1 // existing edit\n')
    await writeFile(join(cwd, 'b.ts'), existing)
    if (state === 'staged') await git(cwd, 'add', 'a.ts', 'b.ts', 'notes.md')
  }
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('completed')
  expect(report.modules[0]?.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
  expect(await readFile(join(cwd, 'notes.md'), 'utf8')).toBe(existing)
  if (state !== 'untracked') {
    expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toBe(existing)
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('=> n // existing edit')
  }
  expect(prompts).toHaveLength(4)
  expect(prompts[2]).toContain('Preserve existing uncommitted changes')
})

test('fixing an existing untracked source file is allowed', async () => {
  const { client, cwd } = await fixFixture()
  await commitFixture(cwd)
  await git(cwd, 'rm', '--cached', 'a.ts')
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
})

test('fixing within a subdirectory preserves the original Git index', async () => {
  const { client, cwd } = await fixFixture({ fix: async sessionCwd => {
    expect(await readFile(join(sessionCwd, '..', 'root.ts'), 'utf8')).toBe('context')
    await writeFile(join(sessionCwd, 'a.ts'), fixed)
    return fixResult
  } })
  const nested = join(cwd, 'module with spaces')
  await mkdir(nested)
  await writeFile(join(cwd, 'root.ts'), 'context')
  await writeFile(join(nested, 'a.ts'), 'staged source')
  await writeFile(join(nested, 'b.ts'), 'unrelated source')
  await commitFixture(cwd)
  await writeFile(join(nested, 'a.ts'), 'original working copy')
  const report = await reviewCode({ client, cwd: nested, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'] })
  expect(await readFile(join(nested, 'a.ts'), 'utf8')).toBe(fixed)
  const { stdout } = await exec('git', ['-C', cwd, 'show', ':module with spaces/a.ts'])
  expect(stdout).toBe('staged source')
})

test('a staged fix is rejected and the original worktree stays clean', async () => {
  const { client, cwd, adapter } = await fixFixture({ fix: async sessionCwd => {
    await writeFile(join(sessionCwd, 'a.ts'), fixed)
    await git(sessionCwd, 'add', 'a.ts')
    return fixResult
  } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({
    status: 'failed', changedFiles: [], error: { code: 'REVIEW_FIX_SCOPE' },
  })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('n || 1')
  const { stdout } = await exec('git', ['-C', cwd, 'diff', '--cached', '--name-only'])
  expect(stdout).toBe('')
  for (const session of adapter.opened) {
    await expect(access(dirname(session.cwd))).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

test('a fix cannot overwrite source edited during its agent session', async () => {
  const originalEdit = 'export const modifiedOutsideReview = true\n'
  const { client, cwd } = await fixFixture({ fix: async sessionCwd => {
    await writeFile(join(sessionCwd, 'a.ts'), fixed)
    await writeFile(join(cwd, 'a.ts'), originalEdit)
    return fixResult
  } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({
    status: 'failed', changedFiles: [], error: { code: 'REVIEW_FIX_CONFLICT' },
  })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(originalEdit)
})

test('a conflict in the last changed file prevents the entire fix from being applied', async () => {
  const originalEdit = 'export const modifiedOutsideReview = true\n'
  const { client, cwd, prompts } = await fixture(async (prompt, sessionCwd) => {
    if (prompt.startsWith(stages.analyze)) {
      return { ...plan, modules: [{ ...plan.modules[0], files: ['a.ts', 'b.ts'] }] }
    }
    if (prompt.startsWith(stages.fix)) {
      await writeFile(join(sessionCwd, 'a.ts'), fixed)
      await writeFile(join(sessionCwd, 'b.ts'), fixed)
      await writeFile(join(cwd, 'b.ts'), originalEdit)
      return { ...fixResult, changedFiles: ['a.ts', 'b.ts'] }
    }
    return { findings: [finding] }
  })
  await commitFixture(cwd)
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({
    status: 'failed', changedFiles: [], error: { code: 'REVIEW_FIX_CONFLICT' },
  })
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toBe(originalEdit)
  expect(prompts).toHaveLength(3)
})

test('fixing in a repository with an unborn branch leaves HEAD unborn', async () => {
  const { client, cwd } = await fixFixture()
  await git(cwd, 'init', '-q')
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'] })
  await expect(git(cwd, 'rev-parse', '--verify', 'HEAD')).rejects.toThrow()
})

test('existing changes are not reported as applied when the fix agent changes nothing', async () => {
  const { client, cwd } = await fixFixture({ fix: () => fixResult })
  await commitFixture(cwd)
  const existing = 'export const fallback = (n: number) => n || 1 // existing edit\n'
  await writeFile(join(cwd, 'a.ts'), existing)
  await writeFile(join(cwd, 'b.ts'), 'existing unrelated changes\n')
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'skipped', changedFiles: [], error: null })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(existing)
})

test('fix changes are detected even when they restore a dirty source to its committed content', async () => {
  let original = ''
  const { client, cwd } = await fixFixture({ fix: async directory => {
    await writeFile(join(directory, 'a.ts'), original)
    return fixResult
  } })
  await commitFixture(cwd)
  original = await readFile(join(cwd, 'a.ts'), 'utf8')
  await writeFile(join(cwd, 'a.ts'), `${original}// existing edit\n`)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
})

test('further edits to an already dirty out-of-scope file still fail scope validation', async () => {
  const { client, cwd } = await fixFixture({ fix: async directory => {
    await writeFile(join(directory, 'a.ts'), fixed)
    await writeFile(join(directory, 'b.ts'), 'unexpected repair edit\n')
    return fixResult
  } })
  await commitFixture(cwd)
  await writeFile(join(cwd, 'b.ts'), 'existing unrelated changes\n')
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'failed', error: { code: 'REVIEW_FIX_SCOPE' } })
  expect(report.modules[0]?.fix?.error?.message).toContain('b.ts')
})

test.each([
  { name: 'edits an unselected module file', edit: async (cwd: string) => {
    await writeFile(join(cwd, 'a.ts'), fixed)
    await writeFile(join(cwd, 'b.ts'), fixed)
  } },
  { name: 'creates a new file', edit: async (cwd: string) => {
    await writeFile(join(cwd, 'a.ts'), fixed)
    await writeFile(join(cwd, 'new.ts'), 'new\n')
  } },
  { name: 'deletes a selected source file', edit: async (cwd: string) => {
    await writeFile(join(cwd, 'a.ts'), fixed)
    await unlink(join(cwd, 'a.ts'))
  } },
])('out-of-scope fix changes fail-stop with the paths listed: $name', async ({ edit }) => {
  const { client, cwd, prompts } = await fixFixture({ fix: async directory => { await edit(directory); return fixResult } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.fix).toMatchObject({ status: 'failed', changedFiles: [],
    error: { code: 'REVIEW_FIX_SCOPE', outcomeUnknown: false } })
  expect(report.modules[0]?.fix?.error?.message).toContain('outside the selected source files')
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('n || 1')
  expect(prompts).toHaveLength(3)
})

test('a fix agent that changes nothing on disk stays skipped without verification', async () => {
  const { client, cwd, prompts } = await fixFixture({ fix: () => fixResult })
  await commitFixture(cwd)
  const events: ReviewProgress[] = []
  const report = await reviewCode({ client, cwd, ...single, fix: true, onProgress: event => events.push(event) })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'skipped', changedFiles: [] })
  expect(report.modules[0]?.review.angles[0]).toMatchObject({ findings: [finding] })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('n || 1')
  expect(prompts).toHaveLength(3)
  expect(events.filter(event => event.stage === 'fix').map(event => event.status)).toEqual(['started', 'skipped'])
})

test('schema-invalid fix results retain diagnostics and leave sources unchanged', async () => {
  const { client, cwd } = await fixFixture({ fix: () => ({ ...fixResult, summary: '' }) })
  await commitFixture(cwd)
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix).toMatchObject({ status: 'failed', error: {
    code: 'STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false,
    issues: [{ path: '/summary', code: 'minLength' }],
  } })
  expect(formatReport(report)).toContain('Validation issue: "/summary" [minLength]')
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
})

test.each([false, true])('custom workflow storage cannot enter the fix scope (symlink alias: %s)', async alias => {
  const file = alias ? 'archive/old/result.json' : 'saved-runs/old/result.json'
  const { client, cwd, prompts } = await fixture(() => ({
    summary: 'Operational data', modules: [{ id: 'metadata', name: 'Metadata', description: 'Run data', files: [file] }],
  }))
  await mkdir(join(cwd, 'saved-runs/old'), { recursive: true })
  await writeFile(join(cwd, 'saved-runs/old/result.json'), '{"value":1}\n')
  if (alias) await symlink(join(cwd, 'saved-runs'), join(cwd, 'archive'), 'dir')
  await commitFixture(cwd)
  await expect(reviewCode({ client, cwd, ...single, fix: true, workflowDirectory: join(cwd, 'saved-runs') }))
    .rejects.toMatchObject({ code: 'REVIEW_VALIDATION_FAILED' })
  expect(await readFile(join(cwd, 'saved-runs/old/result.json'), 'utf8')).toBe('{"value":1}\n')
  expect(prompts).toHaveLength(1)
})

test('untracked workflow storage inside the repository is excluded from fix changes', async () => {
  const { client, cwd } = await fixFixture()
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true, workflowDirectory: join(cwd, 'runs') })
  expect(report.modules[0]?.fix?.status).toBe('applied')
  expect(report.modules[0]?.fix?.changedFiles).toEqual(['a.ts'])
})

test.each([
  { review: { findings: [] }, status: 'not-needed', overall: 'completed' },
  { review: new HarnessSdkError('RATE_LIMITED'), status: 'skipped', overall: 'incomplete' },
])('no findings and incomplete reviews never dispatch a fix agent: %j', async ({ review, status, overall }) => {
  const { client, cwd, prompts } = await fixFixture({ review })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.modules[0]?.fix?.status).toBe(status)
  expect(report.status).toBe(overall)
  expect(prompts).toHaveLength(2)
})

test.each(['RATE_LIMITED', 'NATIVE_FAILED'])('fix agent failure %s produces an incomplete report and leaves sources unchanged', async code => {
  const { client, cwd } = await fixFixture({ fix: () => new HarnessSdkError(code) })
  await commitFixture(cwd)
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.fix?.status).toBe('failed')
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
})

test('failed fix execution discards checkout edits and retains the original error', async () => {
  const { client, cwd, prompts } = await fixFixture({ fix: async directory => {
    await writeFile(join(directory, 'a.ts'), fixed)
    await writeFile(join(directory, 'b.ts'), fixed)
    return new HarnessSdkError('NATIVE_FAILED', 'Fix interrupted after writing files')
  } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.fix).toMatchObject({
    status: 'failed', changedFiles: [],
    error: { code: 'NATIVE_FAILED', outcomeUnknown: false },
  })
  expect(report.modules[0]?.fix?.error?.message).toContain('Fix interrupted after writing files')
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('n || 1')
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toContain('n || 1')
  expect(report.modules[0]?.verification).toBeNull()
  expect(prompts).toHaveLength(3)
})

test('unknown fix-agent outcomes reject the workflow', async () => {
  const { client, cwd, prompts } = await fixFixture({ fix: () => new HarnessSdkError('RECEIPT_LOST', 'Unknown execution', false, true) })
  await commitFixture(cwd)
  await expect(reviewCode({ client, cwd, ...single, fix: true })).rejects.toMatchObject({ code: 'RECEIPT_LOST', outcomeUnknown: true })
  expect(prompts).toHaveLength(3)
})

test.each([
  { verify: { findings: [] }, code: 0 },
  { verify: { findings: [finding] }, code: 1 },
  { verify: new HarnessSdkError('RATE_LIMITED'), code: 2 },
])('CLI --fix uses post-fix review outcomes for exit status: %j', async ({ verify, code }) => {
  const { client, cwd, adapter } = await fixFixture({ verify })
  await commitFixture(cwd)
  const io = output()
  expect(await runCli([cwd, '--max-modules', '1', '--angle', 'correctness', '--fix', '--json'], {
    ...io, createClient: async () => client,
  })).toBe(code)
  expect(JSON.parse(io.read().stdout).modules[0].fix.status).toBe('applied')
  expect(io.read().stderr).toContain('[fix/a] completed')
  expect(io.read().stderr).toContain('[verification/a/correctness]')
  expect(adapter.disposeCount).toBe(1)
})
