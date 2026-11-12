import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { correctnessAngle, formatReport, reviewCode, type ReviewProgress } from '../src'
import { runCli } from '../src/cli'
import { finding, fixture, output, plan, stages } from './helpers'

const exec = promisify(execFile)

const fixResult = { summary: 'Preserve zero instead of replacing it with the fallback.', changedFiles: ['a.ts'] }
const fixed = 'export const fallback = (n: number) => n\n'

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

async function fixFixture(options: {
  fix?: (cwd: string) => unknown | Promise<unknown>
  verify?: unknown
  review?: unknown
} = {}) {
  // Safe: fixture() only invokes respond after it returns, so context is
  // assigned before any prompt is answered.
  const context = await fixture(async prompt => {
    if (prompt.startsWith(stages.analyze)) return plan
    if (prompt.startsWith(stages.fix)) {
      if (options.fix) return options.fix(context.cwd)
      await writeFile(join(context.cwd, 'a.ts'), fixed)
      return fixResult
    }
    if (prompt.startsWith(stages.verify)) return options.verify ?? { findings: [] }
    return options.review ?? { findings: [finding] }
  })
  return context
}

const single = { maxModules: 1, angles: [correctnessAngle] }

test('default review never dispatches a fix agent or writes source files', async () => {
  const { client, cwd, prompts } = await fixFixture()
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single })
  expect(report.fix).toBeNull()
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(prompts).toHaveLength(2)
})

test('fix edits sources directly, reconciles changes from git, then reviews the same scope', async () => {
  const { client, cwd, prompts, adapter } = await fixFixture()
  await commitFixture(cwd)
  const events: ReviewProgress[] = []
  const report = await reviewCode({
    client, cwd, ...single, fix: true, fixPermissionMode: 'agent',
    onProgress: event => events.push(event),
  })
  expect(report.status).toBe('completed')
  expect(report.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
  expect(report.modules[0]?.angles[0]).toMatchObject({ findings: [finding] })
  expect(report.verification?.[0]).toMatchObject({ module: { id: 'a' }, angles: [{ angle: { id: 'correctness' }, status: 'completed', findings: [] }] })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(fixed)
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toContain('n || 1')
  expect(prompts).toHaveLength(4)
  expect(prompts[2]).toContain('Fix the findings by editing the listed source files directly in the working tree.')
  expect(prompts.filter((_, index) => index !== 2).every(prompt => prompt.includes('Read and analyze source code only. Do not modify files,'))).toBe(true)
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
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.fix).toMatchObject({ status: 'failed', changedFiles: [], error: { code: 'REVIEW_FIX_INVALID', outcomeUnknown: false } })
  expect(report.fix?.error?.message).toContain('git repository')
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(prompts).toHaveLength(2)
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
  expect(report.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
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
  expect(report.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
})

test('existing changes are not reported as applied when the fix agent changes nothing', async () => {
  const { client, cwd } = await fixFixture({ fix: () => fixResult })
  await commitFixture(cwd)
  const existing = 'export const fallback = (n: number) => n || 1 // existing edit\n'
  await writeFile(join(cwd, 'a.ts'), existing)
  await writeFile(join(cwd, 'b.ts'), 'existing unrelated changes\n')
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix).toMatchObject({ status: 'skipped', changedFiles: [], error: null })
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
  expect(report.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
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
  expect(report.fix).toMatchObject({ status: 'failed', error: { code: 'REVIEW_FIX_SCOPE' } })
  expect(report.fix?.error?.message).toContain('b.ts')
})

test.each([
  { name: 'edits an unselected module file', changed: ['a.ts'], edit: async (cwd: string) => {
    await writeFile(join(cwd, 'a.ts'), fixed)
    await writeFile(join(cwd, 'b.ts'), fixed)
  } },
  { name: 'creates a new file', changed: ['a.ts'], edit: async (cwd: string) => {
    await writeFile(join(cwd, 'a.ts'), fixed)
    await writeFile(join(cwd, 'new.ts'), 'new\n')
  } },
  { name: 'deletes a selected source file', changed: [], edit: async (cwd: string) => {
    await writeFile(join(cwd, 'a.ts'), fixed)
    await unlink(join(cwd, 'a.ts'))
  } },
])('out-of-scope fix changes fail-stop with the paths listed: $name', async ({ changed, edit }) => {
  const { client, cwd, prompts } = await fixFixture({ fix: async directory => { await edit(directory); return fixResult } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  // In-scope edits made before the violation are still surfaced as changedFiles.
  expect(report.fix).toMatchObject({ status: 'failed', changedFiles: changed,
    error: { code: 'REVIEW_FIX_SCOPE', outcomeUnknown: false } })
  expect(report.fix?.error?.message).toContain('revert with git')
  expect(prompts).toHaveLength(3)
})

test('a fix agent that changes nothing on disk stays skipped without verification', async () => {
  const { client, cwd, prompts } = await fixFixture({ fix: () => fixResult })
  await commitFixture(cwd)
  const events: ReviewProgress[] = []
  const report = await reviewCode({ client, cwd, ...single, fix: true, onProgress: event => events.push(event) })
  expect(report.fix).toMatchObject({ status: 'skipped', changedFiles: [] })
  expect(report.modules[0]?.angles[0]).toMatchObject({ findings: [finding] })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('n || 1')
  expect(prompts).toHaveLength(3)
  expect(events.filter(event => event.stage === 'fix').map(event => event.status)).toEqual(['started', 'skipped'])
})

test('schema-invalid fix results retain diagnostics and leave sources unchanged', async () => {
  const { client, cwd } = await fixFixture({ fix: () => ({ ...fixResult, summary: '' }) })
  await commitFixture(cwd)
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix).toMatchObject({ status: 'failed', error: {
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
  if (alias) await symlink(join(cwd, 'saved-runs'), join(cwd, 'archive'))
  await expect(reviewCode({ client, cwd, ...single, fix: true, workflowDirectory: join(cwd, 'saved-runs') }))
    .rejects.toMatchObject({ code: 'REVIEW_VALIDATION_FAILED' })
  expect(await readFile(join(cwd, 'saved-runs/old/result.json'), 'utf8')).toBe('{"value":1}\n')
  expect(prompts).toHaveLength(1)
})

test('untracked workflow storage inside the repository is excluded from fix changes', async () => {
  const { client, cwd } = await fixFixture()
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true, workflowDirectory: join(cwd, 'runs') })
  expect(report.fix?.status).toBe('applied')
  expect(report.fix?.changedFiles).toEqual(['a.ts'])
})

test.each([
  { review: { findings: [] }, status: 'not-needed', overall: 'completed' },
  { review: new HarnessSdkError('RATE_LIMITED'), status: 'skipped', overall: 'incomplete' },
])('no findings and incomplete reviews never dispatch a fix agent: %j', async ({ review, status, overall }) => {
  const { client, cwd, prompts } = await fixFixture({ review })
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix?.status).toBe(status)
  expect(report.status).toBe(overall)
  expect(prompts).toHaveLength(2)
})

test.each(['RATE_LIMITED', 'NATIVE_FAILED'])('fix agent failure %s produces an incomplete report and leaves sources unchanged', async code => {
  const { client, cwd } = await fixFixture({ fix: () => new HarnessSdkError(code) })
  await commitFixture(cwd)
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.fix?.status).toBe('failed')
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
})

test('failed fix execution retains partial edits and scope violations with the original error', async () => {
  const { client, cwd, prompts } = await fixFixture({ fix: async directory => {
    await writeFile(join(directory, 'a.ts'), fixed)
    await writeFile(join(directory, 'b.ts'), fixed)
    return new HarnessSdkError('NATIVE_FAILED', 'Fix interrupted after writing files')
  } })
  await commitFixture(cwd)
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.fix).toMatchObject({
    status: 'failed', changedFiles: ['a.ts'],
    error: { code: 'NATIVE_FAILED', outcomeUnknown: false },
  })
  expect(report.fix?.error?.message).toContain('Fix interrupted after writing files')
  expect(report.fix?.error?.message).toMatch(/out-of-scope changes:\s+M b\.ts/)
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(fixed)
  expect(report.verification).toBeNull()
  expect(prompts).toHaveLength(3)
})

test('unknown fix-agent outcomes reject the workflow without a scope check', async () => {
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
  expect(JSON.parse(io.read().stdout).fix.status).toBe('applied')
  expect(io.read().stderr).toContain('[fix] completed')
  expect(io.read().stderr).toContain('[verification/a/correctness]')
  expect(adapter.disposeCount).toBe(1)
})
