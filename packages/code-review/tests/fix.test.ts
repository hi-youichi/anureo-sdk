import { expect, test } from 'bun:test'
import { chmod, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { correctnessAngle, formatReport, reviewCode, type ReviewProgress } from '../src'
import { runCli } from '../src/cli'
import { finding, fixture, plan } from './helpers'

const proposal = { summary: 'Preserve zero instead of replacing it with the fallback.', edits: [{ file: 'a.ts', before: 'n || 1', after: 'n' }] }

async function fixFixture(options: {
  propose?: (cwd: string) => unknown | Promise<unknown>
  verify?: unknown
  review?: unknown
} = {}) {
  const context = await fixture(async prompt => {
    if (prompt.startsWith('Analyze')) return plan
    if (prompt.startsWith('Propose fixes')) return options.propose ? options.propose(context.cwd) : proposal
    if (prompt.startsWith('Verify')) return options.verify ?? { findings: [] }
    return options.review ?? { findings: [finding] }
  })
  return context
}

const single = { maxModules: 1, angles: [correctnessAngle] }

test('default review never proposes edits or writes source files', async () => {
  const { client, cwd, prompts } = await fixFixture()
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single })
  expect(report.fix).toBeNull()
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(prompts).toHaveLength(2)
})

test('fix applies exact edits, preserves CRLF and permissions, records backups, then reviews the same scope', async () => {
  const { client, cwd, prompts, adapter } = await fixFixture()
  const original = 'export const fallback = (n: number) => n || 1\r\n'
  await writeFile(join(cwd, 'a.ts'), original)
  await chmod(join(cwd, 'a.ts'), 0o755)
  const events: ReviewProgress[] = []
  const report = await reviewCode({ client, cwd, ...single, fix: true, onProgress: event => events.push(event) })
  expect(report.status).toBe('completed')
  expect(report.fix).toMatchObject({ status: 'applied', changedFiles: ['a.ts'], error: null })
  expect(report.modules[0]?.angles[0]).toMatchObject({ findings: [finding] })
  expect(report.fix?.verification?.[0]).toMatchObject({ module: { id: 'a' }, angles: [{ angle: { id: 'correctness' }, status: 'completed', findings: [] }] })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('export const fallback = (n: number) => n\r\n')
  expect((await stat(join(cwd, 'a.ts'))).mode & 0o777).toBe(0o755)
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toContain('n || 1')
  expect(prompts).toHaveLength(4)
  expect(adapter.opened.every(session => session.instructions === undefined)).toBe(true)
  expect(prompts[2]).toContain('Analyze the findings and propose minimal source edits. Do not modify files')
  expect(prompts.filter((_, index) => index !== 2).every(prompt => prompt.includes('Read and analyze source code only. Do not modify files,'))).toBe(true)
  expect(events.filter(event => event.stage === 'fix').map(event => event.status)).toEqual(['started', 'completed'])
  expect(events.filter(event => event.stage === 'verification').map(event => event.status)).toEqual(['started', 'completed'])
  const path = join(report.workflowDirectory, report.runId)
  expect(await readdir(join(path, 'checkpoints'))).toHaveLength(5)
  expect(await readFile(join(path, 'fix-backups', '0.original'), 'utf8')).toBe(original)
  expect(JSON.parse(await readFile(join(path, 'fix-backups', 'index.json'), 'utf8'))[0].file).toBe('a.ts')
  expect((await readdir(cwd)).some(file => file.startsWith('.anureo-fix-'))).toBe(false)
  expect(JSON.parse(await readFile(join(path, 'result.json'), 'utf8'))).toEqual(report)
  expect(formatReport(report)).toContain('Review after fixes')
})

test.each([
  { file: 'b.ts', before: 'n || 1', after: 'n' },
  { file: '../outside.ts', before: 'n || 1', after: 'n' },
  { file: 'a.ts', before: 'missing', after: 'n' },
  { file: 'a.ts', before: 'n', after: 'value' },
  { file: 'a.ts', before: 'n || 1', after: 'n || 1' },
])('invalid or out-of-scope patches fail without modifying files: %j', async edit => {
  const { client, cwd, prompts } = await fixFixture({ propose: () => ({ ...proposal, edits: [edit] }) })
  const beforeA = await readFile(join(cwd, 'a.ts'))
  const beforeB = await readFile(join(cwd, 'b.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.fix).toMatchObject({ status: 'failed', changedFiles: [], error: { code: 'REVIEW_FIX_INVALID', outcomeUnknown: false } })
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(beforeA)
  expect(await readFile(join(cwd, 'b.ts'))).toEqual(beforeB)
  expect(prompts).toHaveLength(3)
})

test('an index collision after staging preserves source and removes the staged file', async () => {
  let backupDirectory = ''
  const { client, cwd, prompts } = await fixFixture({ propose: async () => {
    await mkdir(backupDirectory, { recursive: true })
    await writeFile(join(backupDirectory, 'index.json'), 'existing index')
    return proposal
  } })
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true, onProgress: event => {
    if (event.stage === 'workflow') backupDirectory = join(event.directory, event.runId, 'fix-backups')
  } })
  expect(report.status).toBe('incomplete')
  expect(report.fix).toMatchObject({ status: 'failed', changedFiles: [], verification: null,
    error: { code: 'REVIEW_FIX_IO_FAILED', outcomeUnknown: false } })
  expect(report.fix?.error?.message).toContain('code="EEXIST"')
  expect(report.fix?.error?.message).toContain('syscall="open"')
  expect(report.fix?.error?.message).toContain(`path=${JSON.stringify(join(backupDirectory, 'index.json'))}`)
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(await readFile(join(backupDirectory, '0.original'))).toEqual(before)
  expect(await readFile(join(backupDirectory, 'index.json'), 'utf8')).toBe('existing index')
  expect((await readdir(cwd)).filter(file => file.startsWith('.anureo-fix-'))).toEqual([])
  expect(prompts).toHaveLength(3)
})

test('schema-invalid fix proposals retain diagnostics in text and persisted JSON reports', async () => {
  const { client, cwd } = await fixFixture({ propose: () => ({
    ...proposal, edits: [{ ...proposal.edits[0]!, before: '' }],
  }) })
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix).toMatchObject({ status: 'failed', error: {
    code: 'STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false,
    issues: [{ path: '/edits/0/before', code: 'minLength' }],
  } })
  expect(formatReport(report)).toContain('Validation issue: "/edits/0/before" [minLength]')
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
  expect(JSON.parse(await readFile(join(report.workflowDirectory, report.runId, 'result.json'), 'utf8'))).toEqual(report)
})

test('validates the complete patch before applying any edit', async () => {
  const { client, cwd } = await fixFixture({ propose: () => ({ ...proposal, edits: [...proposal.edits, { ...proposal.edits[0]!, file: 'b.ts' }] }) })
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix?.status).toBe('failed')
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

test('preserves external edits made while the fix agent is running', async () => {
  const external = 'export const fallback = (n: number) => n + 10\n'
  const { client, cwd } = await fixFixture({ propose: async cwd => { await writeFile(join(cwd, 'a.ts'), external); return proposal } })
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix).toMatchObject({ status: 'failed', error: { code: 'REVIEW_FIX_STALE' } })
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe(external)
})

test('rejects a target replaced by a symlink while planning', async () => {
  const { client, cwd } = await fixFixture({ propose: async cwd => {
    await unlink(join(cwd, 'a.ts'))
    await symlink(join(cwd, 'b.ts'), join(cwd, 'a.ts'))
    return proposal
  } })
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix).toMatchObject({ status: 'failed', error: { code: 'REVIEW_FIX_INVALID' } })
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toContain('n || 1')
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

test('an empty fix proposal keeps the original findings without claiming applied changes', async () => {
  const { client, cwd, prompts } = await fixFixture({ propose: () => ({ summary: 'Requires an out-of-scope change.', edits: [] }) })
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.fix).toMatchObject({ status: 'skipped', changedFiles: [], verification: null })
  expect(report.modules[0]?.angles[0]).toMatchObject({ findings: [finding] })
  expect(prompts).toHaveLength(3)
})

test.each(['RATE_LIMITED', 'NATIVE_FAILED'])('fix agent failure %s produces an incomplete report and leaves sources unchanged', async code => {
  const { client, cwd } = await fixFixture({ propose: () => new HarnessSdkError(code) })
  const before = await readFile(join(cwd, 'a.ts'))
  const report = await reviewCode({ client, cwd, ...single, fix: true })
  expect(report.status).toBe('incomplete')
  expect(report.fix?.status).toBe('failed')
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
})

test('unknown fix-agent outcomes reject the workflow without applying a patch', async () => {
  const { client, cwd, prompts } = await fixFixture({ propose: () => new HarnessSdkError('RECEIPT_LOST', 'Unknown execution', false, true) })
  const before = await readFile(join(cwd, 'a.ts'))
  await expect(reviewCode({ client, cwd, ...single, fix: true })).rejects.toMatchObject({ code: 'RECEIPT_LOST', outcomeUnknown: true })
  expect(prompts).toHaveLength(3)
  expect(await readFile(join(cwd, 'a.ts'))).toEqual(before)
})

test.each([
  { verify: { findings: [] }, code: 0 },
  { verify: { findings: [finding] }, code: 1 },
  { verify: new HarnessSdkError('RATE_LIMITED'), code: 2 },
])('CLI --fix uses post-fix review outcomes for exit status: %j', async ({ verify, code }) => {
  const { client, cwd, adapter } = await fixFixture({ verify })
  let stdout = '', stderr = ''
  expect(await runCli([cwd, '--max-modules', '1', '--angle', 'correctness', '--fix', '--json'], {
    createClient: async () => client, stdout: text => { stdout += text }, stderr: text => { stderr += text },
  })).toBe(code)
  expect(JSON.parse(stdout).fix.status).toBe('applied')
  expect(stderr).toContain('[fix] completed')
  expect(stderr).toContain('[verification/a/correctness]')
  expect(adapter.disposeCount).toBe(1)
})
