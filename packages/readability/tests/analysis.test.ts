import { afterEach, expect, test } from 'bun:test'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { analyzeReadability, planAnalysis, scanRepository, writeReport } from '../src'
import { fixture, sources, scriptedAgent, draftRule } from './helpers'

const roots: string[] = []
async function repository(files: Record<string, string> = sources, workspace: unknown = ['packages/*']): Promise<string> {
  const root = await fixture(files, workspace)
  roots.push(root)
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('discovers nested workspaces and excludes tests, generated files, declarations and symlinks', async () => {
  const root = await repository({ ...sources,
    'packages/a/src/generated/types.ts': 'generated',
    'packages/a/src/main.test.ts': 'test',
    'packages/a/src/index.d.ts': 'declaration',
    'packages/group/nested/package.json': '{"name":"nested"}',
    'packages/group/nested/src/index.ts': 'export {}',
  }, ['packages/**'])
  await symlink(path.join(root, 'packages/a/src/main.ts'), path.join(root, 'packages/a/src/link.ts'))
  const inventory = await scanRepository({ root })
  expect(inventory.packages.map(pkg => pkg.name)).toEqual(['a', 'b', 'nested'])
  expect(inventory.files.map(file => file.path)).toEqual([
    'packages/a/src/main.ts', 'packages/a/src/stop.ts', 'packages/b/src/main.ts', 'packages/group/nested/src/index.ts',
  ])
  const withTests = await scanRepository({ root, includeTests: true })
  expect(withTests.files.find(file => file.path.endsWith('main.test.ts'))?.kind).toBe('test')
})

test('uses the root package when there is no workspace and rejects unsupported workspace globs', async () => {
  const root = await repository({ 'src/main.ts': 'export {}' }, null)
  expect((await scanRepository({ root })).files.map(file => file.path)).toEqual(['src/main.ts'])
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/{a,b}'] }))
  await expect(scanRepository({ root })).rejects.toThrow('Unsupported workspace pattern')
})

test('explicit groups require exactly one primary owner per file', async () => {
  const root = await repository()
  const inventory = await scanRepository({ root, packages: [{ path: 'packages/a' }] })
  const valid = [{ path: 'packages/a', groups: [
    { focus: 'Startup', files: ['packages/a/src/main.ts'] }, { focus: 'Shutdown', files: ['packages/a/src/stop.ts'] },
  ] }]
  expect(planAnalysis(inventory, valid).map(task => task.focus)).toEqual(['Startup', 'Shutdown'])
  expect(() => planAnalysis(inventory, [{ path: 'packages/a', groups: [valid[0]!.groups[0]!] }])).toThrow('exactly one')
  expect(() => planAnalysis(inventory, [{ path: 'packages/a', agents: 0 }])).toThrow('positive')
  expect(planAnalysis(inventory, [{ path: 'packages/a', agents: 9 }])).toHaveLength(2)
})

test('runs package shards, derives one cross-package rule, verifies it and writes portable reports', async () => {
  const root = await repository()
  const report = await analyzeReadability({ root, packages: [{ path: 'packages/a', agents: 2 }, { path: 'packages/b' }],
    agent: scriptedAgent(), concurrency: 2, onProgress() { throw new Error('observer failure') } })
  expect(report.complete).toBe(true)
  expect(report.tasks).toHaveLength(3)
  expect(report.observations).toHaveLength(3)
  expect(report.rules[0]?.status).toBe('supported')
  expect(report.rules[0]?.observationIds).toHaveLength(3)
  expect(report.observations[0]?.evidence[0]?.sha256).toHaveLength(64)
  await writeReport(report, path.join(root, 'artifacts'))
  const json = await readFile(path.join(root, 'artifacts/rules.json'), 'utf8')
  expect(JSON.parse(json)).toEqual(report)
  expect(json.includes(root)).toBe(false)
  expect(await readFile(path.join(root, 'artifacts/rules.md'), 'utf8')).toContain('[supported]')
})

test('retains successful analysis and explicitly reports failed package coverage', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const agent = scriptedAgent({ async analyze(task, context) {
    if (task.packagePath === 'packages/a') throw new Error('backend unavailable')
    return base.analyze(task, context)
  } })
  const report = await analyzeReadability({ root, agent })
  expect(report.complete).toBe(false)
  expect(report.rules[0]?.status).toBe('supported')
  expect(report.coverage.reviewedFiles).toEqual(['packages/b/src/main.ts'])
  expect(report.coverage.unreviewedFiles).toHaveLength(2)
  expect(report.failures[0]?.phase).toBe('analyze')
})

test('rejects fabricated source quotes before rule derivation', async () => {
  const root = await repository()
  const base = scriptedAgent()
  let derived = false
  const agent = scriptedAgent({ async analyze(task, context) {
    const draft = await base.analyze(task, context)
    draft.observations[0]!.evidence[0]!.quote = 'invented source'
    return draft
  }, async derive() { derived = true; return [] } })
  const report = await analyzeReadability({ root, agent })
  expect(derived).toBe(false)
  expect(report.observations).toEqual([])
  expect(report.failures.every(failure => failure.message.includes('quote does not match'))).toBe(true)
})

test('rejects unknown observation IDs and records derivation failure', async () => {
  const root = await repository()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async derive() { return [draftRule(['invented'])] } }) })
  expect(report.rules).toEqual([])
  expect(report.failures[0]?.phase).toBe('derive')
  expect(report.complete).toBe(false)
})

test('a failed rule review keeps the rule as a candidate', async () => {
  const root = await repository()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async verify() { throw new Error('review unavailable') } }) })
  expect(report.rules[0]?.status).toBe('candidate')
  expect(report.failures[0]?.phase).toBe('verify')
  expect(report.complete).toBe(false)
})

test('a supported review must report inspecting its cited evidence', async () => {
  const root = await repository()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async verify(input) {
    const { id: _, ...rule } = input.rule
    return { rule, verdict: 'supported', explanation: 'unsubstantiated', inspectedFiles: ['packages/a/src/stop.ts'], counterexamples: [] }
  } }) })
  expect(report.rules[0]?.status).toBe('candidate')
  expect(report.failures[0]?.message).toContain('inspect every cited')
})

test('source changes make affected rules stale even after a supported review', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async verify(input, context) {
    const result = await base.verify(input, context)
    await writeFile(path.join(root, 'packages/a/src/main.ts'), 'changed source')
    return result
  } }) })
  expect(report.rules[0]?.status).toBe('stale')
  expect(report.changedFiles).toEqual(['packages/a/src/main.ts'])
  expect(report.complete).toBe(false)
})

test('empty observations are valid and do not trigger synthesis', async () => {
  const root = await repository()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async analyze(task) {
    return { reviewedFiles: task.ownedFiles.map(file => file.path), unreviewedFiles: [], observations: [] }
  }, async derive() { throw new Error('must not be called') } }) })
  expect(report.complete).toBe(true)
  expect(report.rules).toEqual([])
})

test('partial review declarations preserve unreviewed reasons', async () => {
  const root = await repository()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async analyze(task) {
    return { reviewedFiles: [], unreviewedFiles: task.ownedFiles.map(file => ({ path: file.path, reason: 'Needs caller context' })), observations: [] }
  } }) })
  expect(report.coverage.unreviewedFiles).toHaveLength(3)
  expect(report.failures).toEqual([])
  expect(report.complete).toBe(false)
})

test('resume reuses successful analysis and runs only failed tasks on the same source inventory', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const partial = await analyzeReadability({ root, agent: scriptedAgent({ async analyze(task, context) {
    if (task.packagePath === 'packages/a') throw new Error('temporary outage')
    return base.analyze(task, context)
  } }) })
  const reran: string[] = []
  let verified = 0
  const report = await analyzeReadability({ root, resume: partial, agent: scriptedAgent({ async analyze(task, context) {
    reran.push(task.packagePath)
    return base.analyze(task, context)
  }, async verify(input, context) {
    verified++
    return base.verify(input, context)
  } }) })
  expect(report.complete).toBe(true)
  expect(reran).toEqual(['packages/a'])
  expect(report.reusedTaskIds).toEqual(['task-2'])
  expect(verified).toBe(1)
})

test('a changed source inventory invalidates cached analyses', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const partial = await analyzeReadability({ root, agent: base })
  await writeFile(path.join(root, 'packages/a/src/stop.ts'), 'export function stop() { return false }\n')
  const report = await analyzeReadability({ root, resume: partial, agent: base })
  expect(report.reusedTaskIds).toEqual([])
})

test('reviews may inspect contextual metadata without expanding primary coverage', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async verify(input, context) {
    const review = await base.verify(input, context)
    review.inspectedFiles.push('package.json')
    return review
  } }) })
  expect(report.complete).toBe(true)
  expect(report.files).toHaveLength(3)
  expect(report.rules[0]?.inspectedSources.find(file => file.path === 'package.json')?.sha256).toHaveLength(64)
})

test('review context paths cannot escape the repository', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async verify(input, context) {
    const review = await base.verify(input, context)
    review.inspectedFiles.push('../package.json')
    return review
  } }) })
  expect(report.rules[0]?.status).toBe('candidate')
  expect(report.failures[0]?.message).toContain('escapes repository')
})

test('later context snapshots cannot hide changes after an earlier review', async () => {
  const root = await repository()
  const base = scriptedAgent()
  const report = await analyzeReadability({ root, concurrency: 1, agent: scriptedAgent({
    async derive(observations, context) {
      const rules = await base.derive(observations, context)
      return [rules[0]!, { ...rules[0]!, title: 'Second scoped rule' }]
    },
    async verify(input, context) {
      const review = await base.verify(input, context)
      review.inspectedFiles.push('package.json')
      return review
    },
  }), onProgress(event) {
    if (event.phase === 'verify' && event.taskId === 'rule-1' && event.state === 'completed') {
      writeFileSync(path.join(root, 'package.json'), '{"name":"changed-context"}')
    }
  } })
  expect(report.changedFiles).toEqual(['package.json'])
  expect(report.rules[0]?.status).toBe('stale')
  expect(report.complete).toBe(false)
})

test('out-of-root package selections and duplicate file coverage are rejected', async () => {
  const root = await repository()
  await expect(scanRepository({ root, packages: [{ path: '../' }] })).rejects.toThrow('escapes repository')
  const report = await analyzeReadability({ root, agent: scriptedAgent({ async analyze(task) {
    const filename = task.ownedFiles[0]!.path
    return { reviewedFiles: [filename, filename], unreviewedFiles: [], observations: [] }
  } }) })
  expect(report.complete).toBe(false)
  expect(report.failures).toHaveLength(2)
})
