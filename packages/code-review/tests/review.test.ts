import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
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
import { candidate, defaultOutput, evidence, type Request, type Source } from './fixtures/review-responses'

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
  return { cwd, client, packages: await discoverPackages(cwd), outputDir: join(cwd, 'draft/docs/design-review/run'),
    concurrency: 2, backendConfigDigest: 'scripted-v1', repeatable: true, ...extra }
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

test('task admission lets a completed checkpoint publish before the next task starts', async () => {
  const cwd = await fixture()
  const outputDir = join(cwd, 'draft/docs/design-review/run')
  const completedBeforeAnalysis: number[] = []
  const harness = await backend(async (input, output) => {
    if (input.task === 'design-analysis') {
      const files = (await readdir(join(outputDir, 'checkpoints'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      const markers = await Promise.all(files.map(name => readFile(join(outputDir, 'checkpoints', name), 'utf8').then(JSON.parse)))
      completedBeforeAnalysis.push(markers.filter(marker => marker.stepKey.startsWith('task:')).length)
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { concurrency: 1, outputDir }))
  expect(report.complete).toBe(true)
  expect(completedBeforeAnalysis).toEqual([0, 1, 2, 3])
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

test('analysis, verification and summary corrections retain task ownership and revalidate responses', async () => {
  const cwd = await fixture()
  let analyses = 0, verifications = 0, summaries = 0
  const harness = await backend((input, output) => {
    if (input.task === 'design-analysis' && input.assignment!.moduleId === 'm0' && input.assignment!.angleId === 'D3') {
      const value = analysisSchema.parse(output)
      value.findings = [candidate('D3', input.sources!)]
      if (++analyses === 1) {
        value.coverage[0]!.evidence[0]!.quote = 'invented coverage'
        value.designContext[0]!.evidence[0]!.quote = 'invented collaboration'
      } else {
        expect(input.validationFeedback).toHaveLength(2)
        expect(input.previousResponse).not.toBeNull()
      }
      return value
    }
    if (input.task === 'design-verification') {
      const value = output as { decisions: Array<{ findingId: string; invariants: string[] }> }
      if (++verifications === 1) value.decisions[0]!.invariants = []
      else expect(input.validationFeedback![0]!.message).toContain('invariant')
      return value
    }
    if (input.task === 'design-summary') {
      if (++summaries === 1) return { summary: '漏掉候选的响应', groups: [], gaps: [] }
      expect(input.validationFeedback![0]!.message).toContain('coverage')
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { contextRounds: 0, responseCorrections: 1 }))
  expect(report.complete).toBe(true)
  expect([analyses, verifications, summaries]).toEqual([2, 2, 2])
  expect(report.tasks).toHaveLength(4)
  expect(report.findingCounts.accepted).toBe(1)
  expect(report.findings[0]!.taskId).toBe('module:m0:angle:D3')
  expect(report.calls.actual).toBeLessThanOrEqual(report.plan.budgets.maxCalls)
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
    const input = await options(cwd, harness.client)
    if (failure === 'invocation') {
      await expect(reviewDesign(input)).rejects.toMatchObject({ outcomeUnknown: true, details: { runId: 'run' } })
    } else {
      const report = await reviewDesign(input)
      expect(report.complete).toBe(false)
      expect(report.tasks).toHaveLength(0)
    }
    expect(harness.calls).toHaveLength(1)
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

test('unchanged plans and workers resume without depending on the final report', async () => {
  const cwd = await fixture()
  const first = await backend()
  const source = await options(cwd, first.client)
  await reviewDesign(source)
  await rm(join(source.outputDir, 'report.json'))
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, { resumeFrom: source.outputDir, outputDir: join(cwd, 'draft/docs/design-review/resumed') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(4)
  expect(next.calls[0]!.task).toBe('design-preflight')
  expect(next.calls.some(c => c.task === 'design-planning')).toBe(false)
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

test('invalid planning request selectors are corrected before context retrieval', async () => {
  const cwd = await fixture()
  let planning = 0
  const harness = await backend((input, output) => {
    if (input.task === 'design-planning' && planning++ === 0) return {
      ...planningSchema.parse(output), status: 'needs_context',
      contextRequests: [{ path: null, symbol: null, query: null, reason: 'Missing selector' }],
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { planningCorrections: 1, contextRounds: 0 }))
  expect(report.complete).toBe(true)
  expect(report.plan.planning.attempts.map(attempt => attempt.outcome)).toEqual(['invalid', 'accepted'])
  expect(harness.calls.filter(call => call.task === 'design-planning')).toHaveLength(2)
})

test('unchanged BOM sources can resume their accepted plan and task evidence', async () => {
  const cwd = await fixture({ 'a.ts': '\ufeffexport const a = 1\n', 'b.ts': 'export const b = 2\n' })
  const first = await backend()
  const source = await options(cwd, first.client)
  expect((await reviewDesign(source)).complete).toBe(true)
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, { resumeFrom: source.outputDir,
    outputDir: join(cwd, 'draft/docs/design-review/bom-resume') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(4)
  expect(next.calls.some(call => call.task === 'design-planning' || call.task === 'design-analysis')).toBe(false)
})

test('partial completed tasks recover while only the failed task runs again', async () => {
  const cwd = await fixture()
  const first = await backend((input, output) => {
    if (input.task === 'design-analysis' && input.assignment!.moduleId === 'm0' && input.assignment!.angleId === 'D12') {
      throw new HarnessSdkError('FIXTURE_FAILURE')
    }
    return output
  })
  const source = await options(cwd, first.client)
  expect((await reviewDesign(source)).complete).toBe(false)
  await rm(join(source.outputDir, 'report.json'))
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, { resumeFrom: source.outputDir,
    outputDir: join(cwd, 'draft/docs/design-review/recovered') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(3)
  expect(next.calls.filter(c => c.task === 'design-analysis')).toHaveLength(1)
  expect(next.calls.some(c => c.task === 'design-planning')).toBe(false)
})

test('unknown backend configuration disables automatic result reuse', async () => {
  const cwd = await fixture()
  const first = await backend()
  const source = await options(cwd, first.client, { backendConfigDigest: undefined })
  await reviewDesign(source)
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, { backendConfigDigest: undefined,
    resumeFrom: source.outputDir, outputDir: join(cwd, 'draft/docs/design-review/no-config') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(0)
  expect(next.calls.filter(c => c.task === 'design-planning')).toHaveLength(1)
  expect(next.calls.filter(c => c.task === 'design-analysis')).toHaveLength(4)
})

test('legacy v2 reports import validated tasks into new workflow checkpoints', async () => {
  const cwd = await fixture()
  const first = await backend(duplicateCandidates)
  const source = await options(cwd, first.client)
  await reviewDesign(source)
  const legacy = join(cwd, 'draft/docs/design-review/legacy')
  await mkdir(legacy)
  await cp(join(source.outputDir, 'report.json'), join(legacy, 'report.json'))
  await cp(join(source.outputDir, 'snapshots'), join(legacy, 'snapshots'), { recursive: true })
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, { resumeFrom: legacy,
    outputDir: join(cwd, 'draft/docs/design-review/imported') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(4)
  expect(report.findings).toHaveLength(3)
  expect(next.calls.some(c => c.task === 'design-analysis')).toBe(false)
})

test('changed supplemental context invalidates its task while the unchanged plan is reused', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 2\n',
    '.gitignore': 'extra.md\n', 'extra.md': 'original contract\n' })
  const hook = (input: Request, output: unknown) => {
    if (input.task === 'design-analysis' && input.assignment!.moduleId === 'm0' && input.assignment!.angleId === 'D3' && input.round === 0) {
      return { ...(output as Analysis), status: 'needs_context', findings: [], contextRequests: [
        { path: 'extra.md', symbol: null, query: null, reason: 'Read supplemental contract' },
      ] }
    }
    return output
  }
  const first = await backend(hook)
  const source = await options(cwd, first.client)
  const initial = await reviewDesign(source)
  expect(initial.complete).toBe(true)
  await writeFile(join(cwd, 'extra.md'), 'changed contract\n')
  const next = await backend(hook)
  const report = await reviewDesign(await options(cwd, next.client, { resumeFrom: source.outputDir,
    outputDir: join(cwd, 'draft/docs/design-review/context-changed') }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(initial.tasks.length - 1)
  expect(next.calls.some(c => c.task === 'design-planning')).toBe(false)
})


test('a summary selects a fresh accepted representative before a pending finding', async () => {
  const cwd = await fixture()
  const harness = await backend((input, output) => {
    if (input.task === 'design-analysis' && input.assignment!.angleId === 'D12') {
      const result = analysisSchema.parse(output)
      result.findings = [{ ...candidate('D12', input.sources!), category: 'readability', decision: 'local_refactor' }]
      return result
    }
    if (input.task === 'design-verification') {
      const result = output as { decisions: Array<{ findingId: string; verdict: string }> }
      if (input.findings![0]!.taskId.includes('m0')) result.decisions[0]!.verdict = 'pending'
      return result
    }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { concurrency: 1 }))
  expect(report.complete).toBe(true)
  const accepted = report.findings.find(finding => finding.review?.verdict === 'accepted')!
  expect(report.rootGroups[0]!.canonicalId).toBe(accepted.id)
  expect(parseReport(JSON.stringify(report)).findings.map(f => f.id)).toEqual([accepted.id])
})


test('legacy reports without matching backend provenance cannot reuse results', async () => {
  const cwd = await fixture()
  const first = await backend()
  const source = await options(cwd, first.client)
  const original = await reviewDesign(source)
  for (const provenance of [undefined, 'different-backend']) {
    const legacy = join(cwd, `draft/docs/design-review/legacy-${provenance ?? 'unknown'}`)
    await mkdir(legacy)
    const report = { ...original, backendConfigDigest: provenance }
    await writeFile(join(legacy, 'report.json'), JSON.stringify(report))
    await cp(join(source.outputDir, 'snapshots'), join(legacy, 'snapshots'), { recursive: true })
    const next = await backend()
    const resumed = await reviewDesign(await options(cwd, next.client, { resumeFrom: legacy,
      outputDir: `${legacy}-imported` }))
    expect(resumed.complete).toBe(true)
    expect(resumed.calls.reusedTasks).toBe(0)
    expect(next.calls.filter(c => c.task === 'design-analysis')).toHaveLength(4)
  }
})


test('the input byte limit includes instructions and the output schema', async () => {
  const cwd = await fixture()
  const first = await backend()
  const source = await options(cwd, first.client)
  await reviewDesign(source)
  const inputName = (await readdir(join(source.outputDir, 'calls'))).find(name => name.endsWith('-planning-0.input.json'))!
  const record = JSON.parse(await readFile(join(source.outputDir, 'calls', inputName), 'utf8'))
  const promptBytes = Buffer.byteLength(JSON.stringify(record.input))
  const next = await backend()
  const report = await reviewDesign(await options(cwd, next.client, {
    outputDir: `${source.outputDir}-bounded`, maxInputBytes: promptBytes + 1,
  }))
  expect(report.complete).toBe(false)
  expect(next.calls).toHaveLength(0)
  expect(report.errors.join(' ')).toContain('Input budget exceeded')
})

async function duplicateCandidates(input: Request, output: unknown) {
  if (input.task !== 'design-analysis' || input.assignment!.angleId !== 'D12') return output
  const result = analysisSchema.parse(output)
  const finding = { ...candidate('D12', input.sources!), category: 'readability' as const, decision: 'local_refactor' as const }
  result.findings = input.assignment!.moduleId === 'm0' ? [finding, { ...finding, title: '另一条局部建议' }] : [finding]
  return result
}

test('cyclic verification cannot publish a completed task or repair root', async () => {
  const cwd = await fixture()
  const harness = await backend(async (input, output) => {
    output = await duplicateCandidates(input, output)
    if (input.task === 'design-verification' && input.assignment!.moduleId === 'm0') {
      const result = output as { decisions: Array<{ findingId: string; duplicateOf: string | null }> }
      result.decisions[0]!.duplicateOf = result.decisions[1]!.findingId
      result.decisions[1]!.duplicateOf = result.decisions[0]!.findingId
    }
    return output
  })
  const source = await options(cwd, harness.client, { concurrency: 1, responseCorrections: 0 })
  const report = await reviewDesign(source)
  expect(report.complete).toBe(false)
  const invalid = report.tasks.find(task => task.task.moduleId === 'm0' && task.task.angleId === 'D12')!
  expect(invalid.status).toBe('failed')
  expect(invalid.error).toContain('Invalid duplicate chain')
  expect(report.rootGroups.flatMap(group => group.findingIds).every(id => !id.startsWith(invalid.task.id))).toBe(true)
  expect(report.findingCounts.uniqueActionable).toBe(1)
  const eligible = parseReport(JSON.stringify(report)).findings
  expect(eligible).toHaveLength(1)
  expect(eligible[0]!.id.startsWith('module:m1:')).toBe(true)
  const markers = await Promise.all((await readdir(join(source.outputDir, 'checkpoints'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => readFile(join(source.outputDir, 'checkpoints', name), 'utf8').then(JSON.parse)))
  expect(markers.some(marker => marker.stepKey === `task:${invalid.task.id}`)).toBe(false)
  const next = await backend(duplicateCandidates)
  const resumed = await reviewDesign(await options(cwd, next.client, { concurrency: 1, responseCorrections: 0,
    resumeFrom: source.outputDir, outputDir: `${source.outputDir}-resumed` }))
  expect(resumed.complete).toBe(true)
  expect(resumed.calls.reusedTasks).toBe(3)
  expect(next.calls.filter(call => call.task === 'design-analysis').map(call => call.assignment!.id)).toEqual([invalid.task.id])
})

test('repair parsing rejects cyclic legacy roots without discarding independent accepted findings', async () => {
  const cwd = await fixture()
  const harness = await backend(duplicateCandidates)
  const report = await reviewDesign(await options(cwd, harness.client, { concurrency: 1 }))
  expect(report.complete).toBe(true)
  const [first, second, independent] = report.findings
  first!.review!.duplicateOf = second!.id
  second!.review!.duplicateOf = first!.id
  for (const finding of report.findings) finding.canonicalId = finding.id
  const parsed = parseReport(JSON.stringify(report))
  expect(parsed.findings.map(finding => finding.id)).toEqual([independent!.id])
  expect(parsed.skipped.filter(finding => finding.reason === 'Invalid duplicate chain').map(finding => finding.id)).toEqual([first!.id, second!.id])
})

test('an incomplete verification cannot supply a repair representative for completed tasks', async () => {
  const cwd = await fixture()
  const harness = await backend(async (input, output) => {
    output = await duplicateCandidates(input, output)
    if (input.task === 'design-verification' && input.assignment!.moduleId === 'm0') return { ...(output as object), status: 'incomplete' }
    return output
  })
  const report = await reviewDesign(await options(cwd, harness.client, { concurrency: 1, responseCorrections: 0 }))
  expect(report.complete).toBe(false)
  expect(report.rootGroups.flatMap(group => group.findingIds)).toEqual(['module:m1:angle:D12#1'])
  expect(parseReport(JSON.stringify(report)).findings.map(finding => finding.id)).toEqual(['module:m1:angle:D12#1'])
})

test('completed findings and verification survive canonical checkpoint key ordering', async () => {
  const cwd = await fixture()
  const first = await backend(duplicateCandidates)
  const source = await options(cwd, first.client, { concurrency: 1 })
  const initial = await reviewDesign(source)
  expect(initial.complete).toBe(true)
  expect(initial.findings).toHaveLength(3)
  const next = await backend(duplicateCandidates)
  const report = await reviewDesign(await options(cwd, next.client, { concurrency: 1,
    resumeFrom: source.outputDir, outputDir: `${source.outputDir}-resumed` }))
  expect(report.complete).toBe(true)
  expect(report.calls.reusedTasks).toBe(4)
  expect(next.calls.some(call => ['design-analysis', 'design-verification'].includes(call.task))).toBe(false)
  expect(report.findings).toEqual(initial.findings)
})


test('changed supplemental context cannot preserve a stale cross-task alias during recovery', async () => {
  const cwd = await fixture({ 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = "old"\n',
    '.gitignore': 'extra.md\n', 'extra.md': 'old contract\n' })
  const hook = (input: Request, output: unknown) => {
    const paths = input.assignment?.primaryFiles ?? []
    if (input.task === 'design-analysis' && input.assignment!.angleId === 'D12' && (paths.includes('a.ts') || paths.includes('b.ts'))) {
      const result = analysisSchema.parse(output)
      if (paths.includes('a.ts') && input.round === 0) return { ...result, status: 'needs_context', contextRequests: [
        { path: 'extra.md', symbol: null, query: null, reason: 'Read the current contract' },
      ] }
      const cause = paths.includes('a.ts') && input.sources!.some(source => source.path === 'extra.md' && source.source.includes('new')) ? 'new' : 'old'
      result.findings = [{ ...candidate('D12', input.sources!), title: `${cause} contract`, cause }]
      return result
    }
    if (input.task === 'design-verification' && paths.includes('b.ts')) {
      const root = input.knownFindings?.find(finding => finding.title === 'old contract')
      if (root) (output as { decisions: Array<{ duplicateOf: string | null }> }).decisions[0]!.duplicateOf = root.id
    }
    if (input.task === 'design-summary') {
      const groups = new Map<string, Finding[]>()
      for (const finding of input.candidates!) groups.set(finding.cause, [...(groups.get(finding.cause) ?? []), finding])
      return { summary: 'Group only matching current causes', groups: [...groups].map(([cause, findings]) => ({
        title: cause, findingIds: findings.map(finding => finding.id), priority: 'medium', proposal: 'Preserve current evidence', tradeoffs: 'Different causes remain separate',
      })), gaps: [] }
    }
    return output
  }
  const first = await backend(hook)
  const source = await options(cwd, first.client, { concurrency: 1, responseCorrections: 0 })
  const initial = await reviewDesign(source)
  expect(initial.complete).toBe(true)
  expect(initial.rootGroups).toHaveLength(1)
  await writeFile(join(cwd, 'extra.md'), 'new contract\n')
  const next = await backend(hook)
  const report = await reviewDesign(await options(cwd, next.client, { concurrency: 1, responseCorrections: 0,
    resumeFrom: source.outputDir, outputDir: `${source.outputDir}-resumed` }))
  expect(report.complete).toBe(true)
  expect(report.rootGroups).toHaveLength(2)
  expect(report.tasks.find(task => task.task.primaryFiles.includes('b.ts') && task.task.angleId === 'D12')!.reused).toBe(true)
  expect([...first.calls, ...next.calls].filter(call => call.task === 'design-verification').every(call => call.knownFindings === undefined)).toBe(true)
})
