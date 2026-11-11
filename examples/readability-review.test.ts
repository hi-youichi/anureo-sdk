import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClient, type Client } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { discoverPackages, reviewProject } from './readability-review'

const clients: Client[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string | Uint8Array>) {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-readability-'))
  directories.push(cwd)
  execFileSync('git', ['init', '--quiet'], { cwd })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), content)
  }
  return cwd
}

type Input = {
  task: string
  path: string
  kind: string
  source: string
  input: {
    package: { path: string }
    files: Array<{ path: string; findingIds: string[] }>
    packages: Array<{ result: { ok: boolean; value?: { actions: Array<{ findingIds: string[] }> } } }>
  }
}

async function backend(options: { invalidEvidence?: boolean; invalidSummary?: boolean; changeSource?: string } = {}) {
  const calls: Input[] = []
  const completedFiles = new Set<string>()
  const completedPackages = new Set<string>()
  let active = 0
  let maximumActive = 0
  const adapter = createScriptedAdapter({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params) || !('input' in call.params)) return undefined
    const input = JSON.parse(call.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')) as Input
    calls.push(input)
    active++
    maximumActive = Math.max(maximumActive, active)
    try {
      // Hold concurrent turns open to exercise the workflow's shared limit.
      await new Promise(resolve => setTimeout(resolve, 5))
      let output: unknown
      if (input.task === 'file-review') {
        const isCode = input.path.endsWith('.ts') && input.kind === 'text'
        output = {
          status: isCode ? 'reviewed' : 'not_applicable', summary: isCode ? '可以改进命名。' : '非代码文件。',
          findings: isCode ? [{
            startLine: 1, endLine: 1, symbol: 'x', priority: 'low',
            evidence: options.invalidEvidence ? 'invented source' : input.source.split('\n')[0]!.replace(/^1: /, ''),
            problem: '名称缺乏语义。', proposal: '使用语义明确的名称。', verification: '运行现有测试。',
          }] : [],
        }
        if (options.changeSource && isCode) await writeFile(join(options.changeSource, input.path), 'export const changed = 2\n')
        completedFiles.add(input.path)
      } else {
        if (input.task === 'package-review') {
          expect(input.input.files.every(file => completedFiles.has(file.path))).toBe(true)
        } else {
          expect(completedPackages.size).toBe(calls.filter(call => call.task === 'package-review').length)
        }
        const ids = input.task === 'package-review'
          ? input.input.files.flatMap(file => file.findingIds)
          : input.input.packages.flatMap(pkg => pkg.result.ok ? pkg.result.value!.actions.flatMap(action => action.findingIds) : [])
        output = {
          summary: '优先改善名称，保持行为。', disagreements: [],
          actions: ids.length || options.invalidSummary ? [{
            priority: 'low', title: '改善命名', rationale: '降低理解成本。', proposal: '先局部重命名，再验证。',
            findingIds: options.invalidSummary ? ['missing.ts#99'] : ids,
          }] : [],
        }
        if (input.task === 'package-review') completedPackages.add(input.input.package.path)
      }
      const turnId = randomUUID()
      await sink.emit({ type: 'turn/started', payload: { turnId } })
      await sink.emit({ type: 'item/completed', payload: {
        item: { id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(output) },
      } }, { turnId })
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
      return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
    } finally { active-- }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, adapter, calls, maximumActive: () => maximumActive }
}

test('discovers every visible file, assigns nearest package and excludes ignored files and reports', async () => {
  const cwd = await fixture({
    'package.json': '{"name":"root"}', '.gitignore': 'ignored.txt\n',
    'root.ts': 'export const x = 1\n', '.hidden.ts': 'export const x = 1\n',
    'packages/a/package.json': '{"name":"a"}', 'packages/a/src/名字 with spaces.ts': 'export const x = 1\n',
    'packages/a/nested/package.json': '{"name":"nested"}', 'packages/a/nested/index.ts': 'export const x = 1\n',
    'ignored.txt': 'ignore me', 'draft/docs/readability-review/old/report.md': 'old report',
  })
  const packages = await discoverPackages(cwd)
  expect(packages.map(pkg => [pkg.path, pkg.name])).toEqual([['.', 'root'], ['packages/a', 'a'], ['packages/a/nested', 'nested']])
  expect(packages[0]!.files).toEqual(['.gitignore', '.hidden.ts', 'package.json', 'root.ts'])
  expect(packages[1]!.files).toEqual(['packages/a/package.json', 'packages/a/src/名字 with spaces.ts'])
  expect(packages[2]!.files).toEqual(['packages/a/nested/index.ts', 'packages/a/nested/package.json'])
})

test('runs one independent agent per file, then each package, then project, with a shared concurrency bound', async () => {
  const cwd = await fixture({
    'package.json': '{"name":"root"}', 'root.ts': 'export const x = 1\n',
    'packages/a/package.json': '{"name":"a"}', 'packages/a/a.ts': 'export const x = 1\n',
    'packages/b/package.json': '{"name":"b"}', 'packages/b/b.ts': 'export const x = 1\n',
    'asset.bin': new Uint8Array([0, 255]),
  })
  await symlink('root.ts', join(cwd, 'link.ts'))
  const packages = await discoverPackages(cwd)
  const harness = await backend()
  const outputDir = join(cwd, 'draft/docs/readability-review/test')
  const report = await reviewProject({ ...harness, cwd, packages, outputDir, concurrency: 2 })
  expect(report.complete).toBe(true)
  expect(report.coverage).toEqual({ total: 8, reviewed: 3, notApplicable: 5, incomplete: 0 })
  expect(harness.calls.filter(input => input.task === 'file-review').map(input => input.path).sort())
    .toEqual(packages.flatMap(pkg => pkg.files).sort())
  expect(harness.calls.filter(input => input.task === 'package-review')).toHaveLength(3)
  expect(harness.calls.at(-1)!.task).toBe('project-review')
  expect(harness.calls).toHaveLength(12)
  expect(harness.maximumActive()).toBe(2)
  expect(harness.adapter.opened).toHaveLength(12)
  expect(new Set(harness.adapter.opened.map(session => session.binding.sessionId)).size).toBe(12)
  expect(JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')).complete).toBe(true)
  expect(await readFile(join(outputDir, 'report.md'), 'utf8')).toContain('root.ts#1')
  expect((await discoverPackages(cwd)).flatMap(pkg => pkg.files)).toHaveLength(8)
  expect(await readFile(join(cwd, 'root.ts'), 'utf8')).toBe('export const x = 1\n')
})

test('invalid evidence remains a coverage gap and does not stop package or project synthesis', async () => {
  const cwd = await fixture({ 'bad.ts': 'export const x = 1\n', 'note.md': 'a note' })
  const harness = await backend({ invalidEvidence: true })
  const report = await reviewProject({ ...harness, cwd, packages: await discoverPackages(cwd), outputDir: join(cwd, 'out'), concurrency: 1 })
  expect(report.complete).toBe(false)
  expect(report.coverage).toEqual({ total: 2, reviewed: 0, notApplicable: 1, incomplete: 1 })
  expect(report.packages[0]!.files.find(file => file.path === 'bad.ts')!.result).toMatchObject({ ok: false, error: expect.stringContaining('Invalid source evidence') })
  expect(report.project.ok).toBe(true)
  expect(harness.calls.map(input => input.task)).toEqual(['file-review', 'file-review', 'package-review', 'project-review'])
})

test('source changes and invented synthesis references cannot produce a complete report', async () => {
  const cwd = await fixture({ 'changing.ts': 'export const x = 1\n' })
  const harness = await backend({ changeSource: cwd, invalidSummary: true })
  const report = await reviewProject({ ...harness, cwd, packages: await discoverPackages(cwd), outputDir: join(cwd, 'out'), concurrency: 1 })
  expect(report.complete).toBe(false)
  expect(report.packages[0]!.files[0]!.result).toMatchObject({ ok: false, error: expect.stringContaining('Source changed') })
  expect(report.packages[0]!.result).toMatchObject({ ok: false, error: expect.stringContaining('Unknown finding') })
  expect(report.project).toMatchObject({ ok: false, error: expect.stringContaining('Unknown finding') })
})
