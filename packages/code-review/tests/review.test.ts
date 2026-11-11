import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { parseReport } from '../src/fix'
import { discoverPackages } from '../src/io'
import { hash, ReviewContext } from '../src/context'
import { createDesignPlan, reviewDesign, type DesignOptions } from '../src/review'
import { analysisSchema, dimensions, type Analysis, type DesignTask, type Evidence, type Finding } from '../src/schema'
import { readDesignConfig } from '../src/project'
import { planningSchema } from '../src/planning'

const directories: string[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture(files: Record<string, string> = { 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 2\n' }) {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-design-'))
  directories.push(cwd)
  execFileSync('git', ['init', '--quiet'], { cwd })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), text)
  }
  return cwd
}
type Source = { id: string; path: string; sha256: string; kind: string; source: string }
type Request = {
  task: string; primaryFiles?: string[]; kind?: string; id?: string; assignment?: DesignTask; round?: number
  sources?: Source[]; findings?: Finding[]; candidates?: Finding[]
  dependencies?: Array<{ status: string }>
  contextResolution?: { candidates: string[] }
  validationFeedback?: Array<{ path: string; message: string }>
  previous?: unknown
}
function evidence(source: Source): Evidence {
  return { path: source.path, snapshotId: source.id, sha256: source.sha256, symbol: '',
    startLine: 1, endLine: 1, quote: source.source.split('\n')[0]!.replace(/^1: /, ''), role: '原始实现' }
}
function candidate(dimension: DesignTask['dimensions'][number], sources: Source[]): Analysis['findings'][number] {
  return {
    primaryDimension: dimension, relatedDimensions: [], category: 'structural_design', priority: 'medium',
    title: '状态归属重复', decision: 'structural_refactor', collaboration: '入口与消费者共同维护同一事实。',
    problem: '规则分散。', cause: '状态写入分属两个所有者。', impact: '增加状态时需要同步修改两个实现。',
    contract: '一个事实有一个权威所有者。', scenario: '新增一个阶段时必须修改两处。', currentOwner: 'a 与 b', targetOwner: 'a',
    consumers: ['b'], evidence: sources.filter(s => s.kind === 'text').map(evidence),
    localAlternative: '保持当前结构，集中一处写入。', alternative: '调整状态归属。', proposal: '消费者读取权威状态。',
    benefit: '减少重复决策。', cost: '调用方需要传入权威状态。', compatibility: '保留公开接口。', verification: '验证增加状态只修改一个所有者。', pattern: null,
  }
}
function defaultOutput(input: Request): unknown {
  if (input.task === 'design-planning') {
    const sources = input.sources!.filter(s => input.primaryFiles!.includes(s.path))
    return { status: 'planned', summary: '按源码职责分为两个模块，按项目选择两个角度。',
      modules: sources.map((source, i) => ({ id: `m${i}`, name: source.path, purpose: '独立源码职责', paths: [source.path], evidence: [evidence(source)] })),
      angles: [{ id: 'D3', title: '契约', question: '输入输出与承诺一致吗？', reason: '公开函数边界' },
        { id: 'D12', title: '可读性', question: '能否直接理解意图？', reason: '代码表达' }],
      referenceCoverage: dimensions.map(d => ({ id: d[0], decision: ['D3', 'D12'].includes(d[0]) ? 'included' : 'not_applicable', angleIds: ['D3', 'D12'].includes(d[0]) ? [d[0]] : [], reason: 'Fixture applicability only' })),
      reviewedFiles: sources.map(s => s.path), excludedFiles: [], contextRequests: [], gaps: [] }
  }
  if (input.task === 'design-preflight') {
    if (input.kind === 'analysis') return { status: 'incomplete', summary: '预检', contextRequests: [], coverage: [], designContext: [], observations: [], findings: [], gaps: [] }
    if (input.kind === 'verification') return { status: 'incomplete', summary: '预检', contextRequests: [], decisions: [], gaps: [] }
    return { summary: '预检', groups: [], gaps: [] }
  }
  if (input.task === 'design-analysis') {
    const text = input.sources!.filter(s => s.kind === 'text')
    return { status: text.length ? 'reviewed' : 'not_applicable', summary: '实际源码已审查，零候选。', contextRequests: [],
      designContext: text.length ? [{ form: '直接模块协作', participants: text.map(s => s.path), collaboration: '按给定源代码表达转换与依赖。', stateAndEffects: '仅对本次源码中的可见读写作判断。', invariants: ['输入输出以源码为边界'], evidence: [evidence(text[0]!)], uncertainties: ['运行时行为未执行'] }] : [],
      coverage: input.assignment!.dimensions.map(dimension => ({ dimension, status: text.length ? 'reviewed' : 'not_applicable',
        reason: text.length ? '已检查源码。' : '非文本资产。', evidence: text.length ? [evidence(text[0]!)] : [] })),
      observations: [], findings: [], gaps: [] }
  }
  if (input.task === 'design-verification') return { status: 'reviewed', summary: '独立源码复核完成。', contextRequests: [],
    decisions: input.findings!.map(f => ({ findingId: f.id, verdict: 'accepted', reason: '源码和消费者支持责任调整。',
      evidence: f.evidence, improves: [f.primaryDimension], regresses: [], invariants: ['保留公开契约'], evidenceLevel: 'contract_analysis', duplicateOf: null })), gaps: [] }
  if (input.task === 'design-summary') return { summary: '汇总已复核结论。', groups: input.candidates!.length ? [{
    title: '集中权威状态', findingIds: input.candidates!.map(f => f.id), priority: 'medium', proposal: '按已复核方案实施。', tradeoffs: '保留后端差异。',
  }] : [], gaps: [] }
  throw new Error(`Unexpected task: ${input.task}`)
}

async function backend(hook: (input: Request, output: unknown) => unknown | Promise<unknown> = (_, output) => output) {
  const calls: Request[] = []
  let active = 0, peak = 0
  const adapter = createScriptedAdapter({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params) || !('input' in call.params)) return undefined
    const input = JSON.parse(call.params.input.filter(p => p.type === 'text').map(p => p.text).join('\n')) as Request
    calls.push(input)
    active++; peak = Math.max(peak, active)
    try {
      const output = await hook(input, defaultOutput(input))
      const turnId = randomUUID()
      await sink.emit({ type: 'turn/started', payload: { turnId } })
      await sink.emit({ type: 'item/completed', payload: { item: { id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(output) } } }, { turnId })
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
      return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
    } finally { active-- }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, adapter, calls, peak: () => peak }
}
async function options(cwd: string, client: Client, extra: Partial<DesignOptions> = {}): Promise<DesignOptions> {
  return { cwd, client, packages: await discoverPackages(cwd), outputDir: join(cwd, 'draft/docs/design-review/run'), concurrency: 2, ...extra }
}


test('a planner precedes every module-angle worker and every worker owns exactly one pair', async () => {
  const cwd = await fixture()
  const harness = await backend()
  const report = await reviewDesign(await options(cwd, harness.client))
  expect(report.complete).toBe(true)
  expect(harness.calls[0]!.task).toBe('design-planning')
  expect(report.plan.modules).toHaveLength(2)
  expect(report.plan.angles).toHaveLength(2)
  expect(report.tasks).toHaveLength(4)
  const analyses = harness.calls.filter(c => c.task === 'design-analysis')
  expect(analyses).toHaveLength(4)
  expect(analyses.every(c => c.assignment!.dimensions.length === 1)).toBe(true)
  expect(new Set(analyses.map(c => `${c.assignment!.moduleId}/${c.assignment!.angleId}`)).size).toBe(4)
  expect(report.coverage.modules).toEqual({ total: 2, reviewed: 2, notApplicable: 0, incomplete: 0 })
  expect(harness.peak()).toBeLessThanOrEqual(2)
  expect(harness.calls.at(-1)!.task).toBe('design-summary')
})

test('invalid module coverage or duplicate angles exhaust correction budgets without dispatch', async () => {
  for (const invalid of ['coverage', 'angles'] as const) {
    const cwd = await fixture()
    const harness = await backend((input, output) => {
      if (input.task === 'design-planning') {
        const plan = planningSchema.parse(output)
        if (invalid === 'coverage') plan.modules[0]!.paths.push('outside.ts')
        else plan.angles.push(plan.angles[0]!)
        return plan
      }
      return output
    })
    const report = await reviewDesign(await options(cwd, harness.client))
    expect(report.complete).toBe(false)
    expect(report.plan.discovery.status).toBe('failed')
    expect(harness.calls).toHaveLength(3)
    expect(harness.calls.every(call => call.task === 'design-planning')).toBe(true)
    expect(report.plan.planning.attempts.map(attempt => attempt.outcome)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(report.plan.planning.acceptedCallId).toBeNull()
    expect(report.plan.modules).toEqual([])
    expect(report.plan.planning.proposedPlan).not.toBeNull()
    const saved = JSON.parse(await readFile(join(report.cwd, 'draft/docs/design-review/run/plan.json'), 'utf8'))
    expect(saved.discovery.status).toBe('failed')
    expect(saved.planning.validationIssues.length).toBeGreaterThan(0)
    const markdown = await readFile(join(report.cwd, 'draft/docs/design-review/run/report.md'), 'utf8')
    expect(markdown).toContain('任务覆盖尚未建立')
    expect(markdown).toContain('未接受的最新规划提议')
    expect(markdown).not.toContain('0 已审／0 不适用／0 未完成')
  }
})

test('all invalid citations are fed back and corrected without spending context rounds', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\nexport const aa = 2\n', 'b.ts': 'export const b = 1\nexport const bb = 2\n' })
  let proposals = 0
  let initialSources: Source[] = []
  const harness = await backend((input, output) => {
    if (input.task !== 'design-planning') return output
    proposals++
    if (proposals === 1) {
      initialSources = input.sources!
      const plan = planningSchema.parse(output)
      plan.modules.forEach(module => {
        const source = input.sources!.find(s => s.path === module.paths[0])!
        module.evidence[0]!.quote = source.source.split('\n').slice(0, 2).map(line => line.replace(/^\d+: /, '')).join('\n')
      })
      return plan
    }
    expect(input.validationFeedback).toHaveLength(2)
    expect(input.validationFeedback!.every(issue => issue.path.includes('.evidence[0]'))).toBe(true)
    expect(input.sources).toEqual(initialSources)
    expect(input.previous).not.toBeNull()
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { contextRounds: 0, planningCorrections: 1 }))
  expect(report.complete).toBe(true)
  expect(report.plan.planning.attempts.map(a => a.outcome)).toEqual(['invalid', 'accepted'])
  const first = report.plan.planning.attempts[0]!
  const outputDir = join(cwd, 'draft/docs/design-review/run')
  const proposal = JSON.parse(await readFile(join(outputDir, first.artifact), 'utf8'))
  expect(proposal.proposal.modules[0].evidence[0].endLine).toBe(1)
  expect(proposal.validationIssues).toHaveLength(2)
  expect(report.plan.planning.acceptedCallId).toBe(report.plan.planning.attempts[1]!.callId)
  expect(report.plan.callEstimate.planningMax).toBe(2)
  expect(report.calls.actual).toBeLessThanOrEqual(report.plan.budgets.maxCalls)
  const timing = JSON.parse(await readFile(join(outputDir, 'calls', `${first.callId}.timing.json`), 'utf8'))
  expect(timing.outcome).toBe('completed') // The call succeeded; the proposal failed host validation.
  expect(timing.durationMs).toBeGreaterThanOrEqual(0)
  expect(Date.parse(timing.endedAt)).toBeGreaterThanOrEqual(Date.parse(timing.startedAt))
})

test('disabling corrections rejects invalid evidence immediately', async () => {
  const cwd = await fixture()
  const harness = await backend((input, output) => {
    if (input.task !== 'design-planning') return output
    const plan = planningSchema.parse(output)
    plan.modules[0]!.evidence[0]!.quote = 'fabricated source'
    return plan
  })
  const report = await reviewDesign(await options(cwd, harness.client, { planningCorrections: 0 }))
  expect(report.complete).toBe(false)
  expect(harness.calls).toHaveLength(1)
  expect(report.tasks).toHaveLength(0)
})

test('incomplete planning and invocation failures never enter the correction loop', async () => {
  for (const failure of ['incomplete', 'invocation'] as const) {
    const cwd = await fixture()
    const harness = await backend((input, output) => {
      if (input.task !== 'design-planning') return output
      if (failure === 'invocation') throw new Error('model invocation failed')
      const plan = planningSchema.parse(output)
      plan.status = 'incomplete'
      plan.gaps = ['Required semantics unavailable']
      return plan
    })
    const report = await reviewDesign(await options(cwd, harness.client))
    expect(report.complete).toBe(false)
    expect(harness.calls).toHaveLength(1)
    expect(report.tasks).toHaveLength(0)
  }
})

test('project-specific angles remain valid through evidence, verification and the unified report', async () => {
  const cwd = await fixture()
  const harness = await backend((input, output) => {
    if (input.task === 'design-planning') {
      const plan = planningSchema.parse(output)
      plan.angles = [{ id: 'Custom', title: '自定义协议边界', question: '数据交付承诺是否一致？', reason: '实际协议接口' }]
      plan.referenceCoverage = dimensions.map(d => ({ id: d[0], decision: d[0] === 'D3' ? 'adapted' : 'not_applicable', angleIds: d[0] === 'D3' ? ['Custom'] : [], reason: 'Fixture applicability only' }))
      return plan
    }
    if (input.task === 'design-analysis') {
      const value = output as Analysis
      value.findings = [candidate('Custom', input.sources!)]
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client))
  expect(report.complete).toBe(true)
  expect(report.coverage.dimensions.map(d => d.dimension)).toEqual(['Custom'])
  expect(await readFile(join(cwd, 'draft/docs/design-review/run/report.md'), 'utf8')).toContain('自定义协议边界')
})

test('each failed pair remains a coverage gap without hiding other completed pairs', async () => {
  const cwd = await fixture()
  const harness = await backend((input, output) => {
    if (input.task === 'design-analysis' && input.assignment!.moduleId === 'm0' && input.assignment!.angleId === 'D12') throw new HarnessSdkError('FIXTURE_FAILURE', 'fixture failure')
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client))
  expect(report.complete).toBe(false)
  expect(report.tasks.filter(t => t.status === 'failed')).toHaveLength(1)
  expect(report.coverage.entries.filter(e => e.status === 'incomplete')).toHaveLength(1)
})

test('D12 repair candidates use one-file module ownership and retain verification decisions', async () => {
  const cwd = await fixture()
  const harness = await backend((input, output) => {
    if (input.task === 'design-analysis' && input.assignment!.angleId === 'D12') {
      const value = output as Analysis
      value.findings = [{ ...candidate('D12', input.sources!), category: 'readability', decision: 'local_refactor' }]
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { dimensions: ['D12'] }))
  expect(report.complete).toBe(true)
  expect(report.tasks).toHaveLength(2)
  expect(report.coverage.dimensions.map(d => d.dimension)).toEqual(['D12'])
  expect(parseReport(JSON.stringify(report)).findings.length).toBeGreaterThan(0)
})

test('dry-run leaves concrete modules and worker counts unknown without launching a backend', async () => {
  const cwd = await fixture()
  const plan = createDesignPlan(await ReviewContext.create(cwd, await discoverPackages(cwd)))
  expect(plan.discovery.status).toBe('pending')
  expect(plan.tasks).toEqual([])
  expect(plan.callEstimate.analysisTasks).toBeNull()
})


test('forged source quotes and omitted angle coverage cannot complete a worker', async () => {
  for (const invalid of ['quote', 'coverage'] as const) {
    const cwd = await fixture()
    const harness = await backend((input, output) => {
      if (input.task === 'design-analysis' && input.assignment!.moduleId === 'm0') {
        const value = output as Analysis
        if (invalid === 'quote') value.coverage[0]!.evidence[0]!.quote = 'fabricated source'
        else value.coverage = []
      }
      return output
    })
    const report = await reviewDesign(await options(cwd, harness.client))
    expect(report.complete).toBe(false)
    expect(report.tasks.filter(t => t.status === 'completed')).toHaveLength(2)
  }
})

test('unchanged module plans can reuse worker results while replanning stays explicit', async () => {
  const cwd = await fixture()
  const first = await backend()
  const source = await options(cwd, first.client)
  await reviewDesign(source)
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, { resumeFrom: source.outputDir, outputDir: join(cwd, 'draft/docs/design-review/resumed') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(4)
  expect(next.calls[0]!.task).toBe('design-planning')
  expect(next.calls.some(c => c.task === 'design-analysis')).toBe(false)
})

test('context requests keep each worker assigned to its original module and angle', async () => {
  const cwd = await fixture()
  const harness = await backend((input, output) => {
    if (input.task === 'design-analysis' && input.assignment!.moduleId === 'm0') {
      if (input.round === 0) return { ...(output as Analysis), status: 'needs_context', findings: [], contextRequests: [{ path: 'b.ts', symbol: null, query: null, reason: '核对协作端口' }] }
      expect(input.assignment!.dimensions).toHaveLength(1)
      expect(input.sources!.some(s => s.path === 'b.ts')).toBe(true)
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client))
  expect(report.complete).toBe(true)
  expect(report.plan.continuationTasks).toHaveLength(2)
})
