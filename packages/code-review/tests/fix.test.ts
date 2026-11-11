import { cleanupFixtures } from './fixtures/cleanup'
import { afterEach, expect, test } from 'bun:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { fileURLToPath } from 'node:url'
import { candidate as reviewCandidate, defaultOutput } from './fixtures/review-responses'
import { fixReadability, parseReport, type Finding } from '../src/fix'

const clients: Client[] = []
const directories: string[] = []
afterEach(async () => {
  await cleanupFixtures(clients, directories)
})

async function fixture(paths = ['a.ts', 'b.ts']) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'anureo-readability-fix-')))
  directories.push(cwd)
  for (const path of paths) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), 'original\n')
  }
  return cwd
}

function finding(path: string, index = 1): Finding {
  return {
    id: `${path}#${index}`, path, sha256: createHash('sha256').update('original\n').digest('hex'),
    priority: 'medium', detail: `改善 ${path} 中第 ${index} 处名称。`, context: '保持运行行为。',
  }
}

type FixInput = { finding: Finding; ownedFiles: string[]; currentSha256: string }
type Reply = { status: 'changed' | 'already_satisfied' | 'deferred'; summary: string; checks: string[] }
async function backend(execute: (input: FixInput) => Promise<Reply>) {
  const calls: FixInput[] = []
  const adapter = createScriptedAdapter({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('input' in call.params)) return undefined
    const input = JSON.parse(call.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')) as FixInput
    calls.push(input)
    const reply = await execute(input)
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'item/completed', payload: {
      item: { id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(reply) },
    } }, { turnId })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, adapter, calls }
}

test('repair parsing requires unified JSON and preserves incomplete task coverage', () => {
  const report = { reportKind: 'design-review', formatVersion: 2, cwd: '/project', changedPaths: [], findings: [],
    tasks: [{ task: { id: 'file:a.ts', level: 'module', primaryFiles: ['a.ts'], dimensions: ['D12'] },
      status: 'failed', error: 'Unavailable source', analysis: null }],
  }
  const parsed = parseReport(JSON.stringify(report))
  expect(parsed.coverageGaps).toEqual(['file:a.ts'])
  expect(parsed.findings).toEqual([])
  expect(() => parseReport('# legacy readability report')).toThrow('report.json')
  expect(() => parseReport(JSON.stringify({ ...report, tasks: [...report.tasks, ...report.tasks] }))).toThrow('duplicate')
})

test('uses one session per finding, serializes file edits and bounds cross-file concurrency', async () => {
  const cwd = await fixture()
  let active = 0
  let maximum = 0
  const activePaths = new Set<string>()
  const harness = await backend(async input => {
    expect(activePaths.has(input.finding.path)).toBe(false)
    activePaths.add(input.finding.path)
    maximum = Math.max(maximum, ++active)
    try {
      if (input.finding.id === 'a.ts#2') expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('a.ts#1')
      await new Promise(resolve => setTimeout(resolve, 5))
      await writeFile(join(cwd, input.finding.path), `${input.finding.id}\n`)
      return { status: 'changed', summary: '已修改。', checks: ['fixture validation'] }
    } finally { active--; activePaths.delete(input.finding.path) }
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('a.ts', 2), finding('b.ts')],
    outputDir: join(cwd, 'out'), concurrency: 2,
  })
  expect(maximum).toBe(2)
  expect(harness.calls.map(call => call.finding.id).sort()).toEqual(['a.ts#1', 'a.ts#2', 'b.ts#1'])
  expect(harness.adapter.opened).toHaveLength(3)
  expect(new Set(harness.adapter.opened.map(session => session.binding.sessionId)).size).toBe(3)
  expect(result.results.map(item => [item.id, item.status, item.changedFiles])).toEqual([
    ['a.ts#1', 'changed', ['a.ts']], ['a.ts#2', 'changed', ['a.ts']], ['b.ts#1', 'changed', ['b.ts']],
  ])
  expect(JSON.parse(await readFile(join(cwd, 'out/results.json'), 'utf8')).results).toHaveLength(3)
})

test('serializes schema and generator ownership while keeping one agent per suggestion', async () => {
  const schema = 'schema/contract.json'
  const generator = 'tools/generate.ts'
  const generated = 'generated/types.ts'
  const cwd = await fixture([schema, generator, generated])
  const harness = await backend(async input => {
    if (input.finding.path === generated) expect(await readFile(join(cwd, generated), 'utf8')).toBe('regenerated\n')
    else await writeFile(join(cwd, generated), 'regenerated\n')
    return { status: input.finding.path === generated ? 'already_satisfied' : 'changed', summary: '维护入口已核实。', checks: [] }
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding(schema), finding(generated)],
    outputDir: join(cwd, 'out'), concurrency: 2, writeGroups: [[schema, generator, generated]],
  })
  expect(harness.calls.map(call => call.ownedFiles)).toEqual([[schema, generator, generated], [schema, generator, generated]])
  expect(result.results.map(item => item.status)).toEqual(['changed', 'already_satisfied'])
})

test('a false changed claim stops later findings in that file without dropping other files', async () => {
  const cwd = await fixture()
  const harness = await backend(async input => {
    return { status: input.finding.path === 'a.ts' ? 'changed' : 'deferred', summary: '需要核实契约。', checks: [] }
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('a.ts', 2), finding('b.ts')],
    outputDir: join(cwd, 'out'), concurrency: 1,
  })
  expect(result.results.map(item => item.status)).toEqual(['failed', 'not_started', 'deferred'])
  expect(harness.calls).toHaveLength(2)
})

test('an unknown native outcome prevents queued sessions and is never retried', async () => {
  const cwd = await fixture()
  const harness = await backend(async input => {
    await writeFile(join(cwd, input.finding.path), 'partial write before losing observation\n')
    throw new HarnessSdkError('SOURCE_LOST', 'Unknown writer state', false, true)
  })
  const result = await fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('b.ts'), finding('a.ts', 2)],
    outputDir: join(cwd, 'out'), concurrency: 1,
  })
  expect(harness.calls).toHaveLength(1)
  expect(result.stopReason).toContain('Uncertain execution')
  expect(result.results.map(item => item.status)).toEqual(['failed', 'not_started', 'not_started'])
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('partial write before losing observation\n')
  expect(result.results[0]!.changesKnown).toBe(false)
  expect(result.results.slice(1).every(item => item.changesKnown)).toBe(true)
  const saved = JSON.parse(await readFile(join(cwd, 'out/results.json'), 'utf8'))
  expect(saved.results[0].changesKnown).toBe(false)
})

test('validates paths and concurrency before starting any agent', async () => {
  const cwd = await fixture()
  const harness = await backend(async () => ({ status: 'already_satisfied', summary: '已满足。', checks: [] }))
  const options = { ...harness, cwd, findings: [finding('../escape.ts')], outputDir: join(cwd, 'out'), concurrency: 1 }
  await expect(fixReadability(options)).rejects.toThrow('regular project file')
  await expect(fixReadability({ ...options, concurrency: 0 })).rejects.toThrow('concurrency')
  await symlink(join(cwd, 'a.ts'), join(cwd, 'link.ts'))
  await expect(fixReadability({ ...options, findings: [finding('link.ts')] })).rejects.toThrow('regular project file')
  expect(harness.calls).toHaveLength(0)
})


test('fix CLI reports unknown changes after an editing observation fails', async () => {
  const cwd = await fixture(['a.ts'])
  const taskId = 'module:a:angle:D12'
  const source = { id: 'snapshot:fixture', path: 'a.ts', sha256: finding('a.ts').sha256, kind: 'text', source: '1: original' }
  const candidate = { ...reviewCandidate('D12', [source]), category: 'readability' as const, decision: 'local_refactor' as const, id: `${taskId}#1`, taskId }
  const verification = defaultOutput({ task: 'design-verification', findings: [candidate] }) as { decisions: object[] }
  const report = { reportKind: 'design-review', formatVersion: 2, cwd, changedPaths: [],
    findings: [{ ...candidate, stale: false, canonicalId: candidate.id, review: verification.decisions[0] }],
    tasks: [{ task: { id: taskId, level: 'module', primaryFiles: ['a.ts'], dimensions: ['D12'] },
      status: 'completed', error: null, analysis: { summary: 'fixture', designContext: [] } }],
  }
  const reportPath = join(cwd, 'input.json'), outputDir = join(cwd, 'out')
  await writeFile(reportPath, JSON.stringify(report))
  const entry = fileURLToPath(new URL('./fixtures/review-cli.ts', import.meta.url))
  const child = Bun.spawn([process.execPath, entry, 'fix', cwd, '--report', reportPath, '--output', outputDir], {
    cwd, env: { ...process.env, FIX_UNKNOWN: '1' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).toBe(1)
  expect(stdout).toContain('修改文件：未知')
  expect(stdout).not.toContain('修改文件：无')
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('partial write before losing observation\n')
  const saved = JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8'))
  expect(saved.complete).toBe(false)
  expect(saved.results[0].changesKnown).toBe(false)
})

test('rejects pre-existing report drift before starting any repair session', async () => {
  const cwd = await fixture()
  await writeFile(join(cwd, 'b.ts'), 'unreviewed current content\n')
  const harness = await backend(async () => { throw new Error('must not dispatch') })
  await expect(fixReadability({ ...harness, cwd, findings: [finding('a.ts'), finding('b.ts')],
    outputDir: join(cwd, 'out'), concurrency: 2,
  })).rejects.toThrow('Report source changed before repair: b.ts')
  expect(harness.adapter.opened).toHaveLength(0)
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('original\n')
  expect(await readFile(join(cwd, 'b.ts'), 'utf8')).toBe('unreviewed current content\n')
})


test('repair groups choose an eligible accepted member when the report representative is pending or requires design work', async () => {
  const taskId = 'module:a:angle:D12'
  const source = { id: 'snapshot:fixture', path: 'a.ts', sha256: finding('a.ts').sha256, kind: 'text', source: '1: original' }
  const base = { ...reviewCandidate('D12', [source]), category: 'readability' as const, decision: 'local_refactor' as const, taskId, stale: false }
  const ids = [1, 2, 3].map(n => `${taskId}#${n}`)
  const findings = ids.map(id => ({ ...base, id, canonicalId: ids[0]!, review: null as unknown }))
  for (const value of findings) value.review = (defaultOutput({ task: 'design-verification', findings: [value] }) as { decisions: object[] }).decisions[0]
  const report = { reportKind: 'design-review', formatVersion: 2, cwd: '/unused', changedPaths: [], findings,
    tasks: [{ task: { id: taskId, level: 'module', primaryFiles: ['a.ts'], dimensions: ['D12'] }, status: 'completed', error: null, analysis: null }] }
  const firstReview = findings[0]!.review as { verdict: string }
  firstReview.verdict = 'pending'
  expect(parseReport(JSON.stringify(report)).findings.map(f => f.id)).toEqual([ids[1]!])
  firstReview.verdict = 'accepted'
  findings[0]!.decision = 'structural_refactor' as typeof base.decision
  expect(parseReport(JSON.stringify(report)).findings.map(f => f.id)).toEqual([ids[1]!])
  findings[0]!.decision = 'local_refactor'
  expect(parseReport(JSON.stringify(report)).findings.map(f => f.id)).toEqual([ids[0]!])
})


test('a stop requested during file preparation prevents session dispatch and persists not_started', async () => {
  const cwd = await fixture(['a.ts'])
  const harness = await backend(async () => { throw new Error('must not dispatch') })
  let stopped = false
  const report = await fixReadability({ ...harness, cwd, findings: [finding('a.ts')], outputDir: join(cwd, 'out'), concurrency: 1,
    shouldStop: () => stopped, progress: message => { if (message.startsWith('start ')) stopped = true },
  })
  expect(harness.adapter.opened).toHaveLength(0)
  expect(report.results[0]!.status).toBe('not_started')
  expect(JSON.parse(await readFile(join(cwd, 'out/results.json'), 'utf8')).results[0].status).toBe('not_started')
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('original\n')
})
