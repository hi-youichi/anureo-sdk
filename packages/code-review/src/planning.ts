import { z } from 'zod'
import { ContextSelectionRequired, hash, sourceInput, mergePromptSources, type ReviewContext, type Snapshot } from './context'
import { dimensionSchema, dimensions, evidenceSchema, type ContextRequest, type DesignTask } from './schema'
import { analysisSchema } from './schema'
import { isEntryContract } from './project'
import { errorText } from './io'
import { contextRequestIssues } from './validation'

export const planningSchema = z.strictObject({
  status: z.enum(['planned', 'needs_context', 'incomplete']), summary: z.string().min(1),
  modules: z.array(z.strictObject({
    id: dimensionSchema, name: z.string().min(1), purpose: z.string().min(1), paths: z.array(z.string()).min(1),
    evidence: z.array(evidenceSchema).min(1),
  })),
  angles: z.array(z.strictObject({ id: dimensionSchema, title: z.string().min(1), question: z.string().min(1), reason: z.string().min(1) })),
  referenceCoverage: z.array(z.strictObject({ id: dimensionSchema, decision: z.enum(['included', 'adapted', 'not_applicable']),
    angleIds: z.array(dimensionSchema), reason: z.string().min(1) })),
  reviewedFiles: z.array(z.string()), excludedFiles: z.array(z.strictObject({ path: z.string(), reason: z.string().min(1) })),
  contextRequests: analysisSchema.shape.contextRequests, gaps: z.array(z.string()),
})
export type Planning = z.output<typeof planningSchema>
export type PlanningOptions = { scope?: string[]; dimensions?: string[]; contracts?: string[]; flows?: Array<{ id: string; purpose: string; paths: string[]; symbols: string[] }>; contextRounds?: number; contextFiles?: number; planningCorrections?: number; responseCorrections?: number; maxInputBytes?: number }
export type PlanningIssue = { path: string; message: string }
export type PlanningAttempt = {
  callId: string; stage: string; outcome: 'accepted' | 'invalid' | 'needs_context' | 'incomplete'
  proposal: Planning; validationIssues: PlanningIssue[]; snapshotIds: string[]
}
export type PlanningProgress = {
  proposedPlan: Planning | null; validationIssues: PlanningIssue[]; acceptedCallId: string | null
  attempts: Array<Omit<PlanningAttempt, 'proposal' | 'snapshotIds'> & { artifact: string }>
}
function planningProgress(): PlanningProgress {
  return { proposedPlan: null, validationIssues: [], acceptedCallId: null, attempts: [] }
}
export class PlanningValidationError extends Error {
  constructor(readonly issues: PlanningIssue[]) { super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')) }
}

/** No agent is called here; concrete modules and angles deliberately remain unknown. */
export function inventoryPlan(context: ReviewContext, options: PlanningOptions = {}) {
  const contextRounds = options.contextRounds ?? 2, contextFiles = options.contextFiles ?? 10, maxInputBytes = options.maxInputBytes ?? 256_000
  const planningCorrections = options.planningCorrections ?? 2
  const responseCorrections = options.responseCorrections ?? 2
  if (!Number.isInteger(contextRounds) || contextRounds < 0 || contextRounds > 4) throw new Error('contextRounds must be 0..4')
  if (!Number.isInteger(contextFiles) || contextFiles < 1 || contextFiles > 50) throw new Error('contextFiles must be 1..50')
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1024) throw new Error('maxInputBytes must be >= 1024')
  if (!Number.isInteger(planningCorrections) || planningCorrections < 0 || planningCorrections > 4) throw new Error('planningCorrections must be 0..4')
  if (!Number.isInteger(responseCorrections) || responseCorrections < 0 || responseCorrections > 4) throw new Error('responseCorrections must be 0..4')
  const primaryFiles = [...new Set(options.scope ?? context.baseline.keys())].sort()
  if (!primaryFiles.length || primaryFiles.some(path => !context.baseline.has(path))) throw new Error('Scope must name existing Git-visible files')
  const contractPaths = [...new Set(options.contracts ?? [])].sort()
  contractPaths.forEach(path => context.assertContextPath(path))
  options.dimensions?.forEach(id => dimensionSchema.parse(id))
  if (options.dimensions && !options.dimensions.length) throw new Error('Empty angle selection')
  return { reportKind: 'design-review' as const, formatVersion: 2 as const,
    inventoryFiles: [...context.baseline.keys()], primaryFiles, contractPaths,
    packages: context.packages, requestedDimensions: options.dimensions ?? null,
    flowHints: options.flows ?? [],
    budgets: { contextRounds, contextFiles, planningCorrections, responseCorrections, maxInputBytes, baseCalls: 5, maxCalls: 5 + contextRounds + planningCorrections + responseCorrections },
    navigation: context.index.map(i => ({ path: i.path, language: i.language, adapter: i.adapter, capabilities: i.capabilities, unknowns: i.unknowns })),
    note: 'One planner agent discovers modules and angles before module × angle analysis. Task count is unknown until planning completes.',
  }
}
export type InventoryPlan = ReturnType<typeof inventoryPlan>

/** Collect independent errors so one correction can address every invalid citation. */
export function validatePlanning(context: ReviewContext, inventory: InventoryPlan, discovery: Planning, snapshotIds: string[]) {
  const issues: PlanningIssue[] = []
  const check = (invalid: boolean, path: string, message: string) => { if (invalid) issues.push({ path, message }) }
  const allowed = new Set(snapshotIds)
  const linesBySnapshot = new Map<string, string[]>()
  issues.push(...contextRequestIssues(context, discovery.contextRequests))
  discovery.modules.forEach((module, i) => {
    module.evidence.forEach((evidence, j) => {
      try { context.validateEvidence([evidence], allowed, linesBySnapshot) }
      catch (error) { issues.push({ path: `modules[${i}].evidence[${j}]`, message: errorText(error) }) }
    })
    check(!module.evidence.some(e => module.paths.includes(e.path)), `modules[${i}].evidence`, `Module lacks implementation evidence: ${module.id}`)
  })
  if (discovery.status === 'needs_context') {
    check(!discovery.contextRequests.length, 'contextRequests', 'Context request must contain requests')
    return issues
  }
  // A deliberate incomplete response is a terminal gap, not an output correction.
  if (discovery.status === 'incomplete') return issues
  check(!!discovery.contextRequests.length || !!discovery.gaps.length, 'status', 'Final planning still has context requests or gaps')
  check(!discovery.modules.length, 'modules', 'Planner must return modules')
  check(!discovery.angles.length, 'angles', 'Planner must return angles')
  check(new Set(discovery.modules.map(m => m.id)).size !== discovery.modules.length, 'modules', 'Duplicate module IDs')
  check(new Set(discovery.angles.map(a => a.id)).size !== discovery.angles.length, 'angles', 'Duplicate angle IDs')
  const referenceIds = dimensions.map(d => d[0]) as string[]
  check(discovery.referenceCoverage.length !== referenceIds.length || new Set(discovery.referenceCoverage.map(c => c.id)).size !== referenceIds.length
    || discovery.referenceCoverage.some(c => !referenceIds.includes(c.id) || c.angleIds.some(id => !discovery.angles.some(a => a.id === id))
      || (c.decision === 'not_applicable' ? c.angleIds.length !== 0 : c.angleIds.length === 0)), 'referenceCoverage', 'Reference angle applicability coverage mismatch')
  const paths = discovery.modules.flatMap(m => m.paths)
  const excluded = discovery.excludedFiles.map(e => e.path)
  check(new Set(paths).size !== paths.length || new Set(excluded).size !== excluded.length || paths.some(p => excluded.includes(p)), 'modules', 'Duplicate primary module ownership')
  check([...paths, ...excluded].length !== inventory.primaryFiles.length || [...paths, ...excluded].some(p => !inventory.primaryFiles.includes(p)), 'modules', 'Planner file coverage mismatch')
  check(paths.some(p => context.baseline.get(p)?.kind !== 'text'), 'modules', 'Module sources must be readable text; unavailable input is a planning gap')
  check(excluded.some(p => !context.baseline.has(p) || context.baseline.get(p)?.kind === 'text' || context.baseline.get(p)?.kind === 'unavailable'), 'excludedFiles', 'Planner cannot exclude text, unknown or unavailable input')
  const supplied = new Set(snapshotIds.map(id => context.snapshots.get(id)?.path))
  check(paths.some(p => !supplied.has(p)) || discovery.reviewedFiles.length !== paths.length || new Set(discovery.reviewedFiles).size !== paths.length
    || discovery.reviewedFiles.some(p => !paths.includes(p)), 'reviewedFiles', 'Planner must read and account for all module sources')
  check(!!inventory.requestedDimensions?.some(id => !discovery.angles.some(a => a.id === id)), 'angles', 'Requested angle is absent from planner output')
  return issues
}

export function createModulePlan(context: ReviewContext, inventory: InventoryPlan, discovery?: Planning, snapshotIds: string[] = []) {
  if (discovery) {
    if (discovery.status !== 'planned') throw new Error('Module/angle planning is incomplete')
    const issues = validatePlanning(context, inventory, discovery, snapshotIds)
    if (issues.length) throw new PlanningValidationError(issues)
  }
  const modules = discovery?.modules ?? []
  const catalog = discovery?.angles ?? []
  const angles = catalog.filter(a => !inventory.requestedDimensions || inventory.requestedDimensions.includes(a.id))
  const tasks: DesignTask[] = modules.flatMap(module => angles.map(angle => ({
    id: `module:${module.id}:angle:${angle.id}`, unitId: `module:${module.id}`, level: 'module' as const,
    moduleId: module.id, angleId: angle.id, view: angle.id, dimensions: [angle.id], primaryFiles: module.paths,
    packagePaths: context.packages.filter(p => p.files.some(path => module.paths.includes(path))).map(p => p.path),
    purpose: `${module.name}：${module.purpose}\n审查角度：${angle.title}；${angle.question}`, dependsOn: [],
  })))
  const count = tasks.length
  const maximumCalls = 4 + inventory.budgets.responseCorrections + (inventory.budgets.contextRounds + 1) * (1 + count * 2 * (1 + inventory.budgets.responseCorrections)) + inventory.budgets.planningCorrections
  return { ...inventory, planning: planningProgress(), modules, angles: catalog, selectedDimensions: angles.map(a => a.id), referenceCoverage: discovery?.referenceCoverage ?? [],
    dimensions: angles.map(a => [a.id, a.title, a.question] as const),
    discovery: { status: (discovery?.status ?? 'pending') as Planning['status'] | 'pending' | 'failed', summary: discovery?.summary ?? 'Modules and angles have not been discovered',
      snapshotIds, reviewedFiles: discovery?.reviewedFiles ?? [], excludedFiles: discovery?.excludedFiles ?? [] },
    planningHash: hash(JSON.stringify({ modules: modules.map(m => ({ ...m, evidence: m.evidence.map(e => [e.path, e.sha256]) })), angles: catalog, selected: angles.map(a => a.id) })),
    tasks, summaryIds: ['project-summary'],
    callEstimate: { planningBase: 1, planningMax: inventory.budgets.contextRounds + 1 + inventory.budgets.planningCorrections, analysisTasks: discovery ? count : null,
      totalMaximum: discovery ? maximumCalls : null },
    applicability: tasks.map(t => ({ unitId: t.unitId, dimension: t.angleId, taskId: t.id, status: 'pending' as const, reason: 'One owner per module/angle pair' })),
    continuationTasks: [] as Array<{ id: string; parentTaskId: string; stage: string; sourceSnapshotIds: string[]; sourcePaths: string[] }>,
    budgets: { ...inventory.budgets, baseCalls: 5 + count, maxCalls: maximumCalls },
  }
}

export async function discoverModules(context: ReviewContext, inventory: InventoryPlan, contracts: Snapshot[],
  invoke: (stage: string, input: object) => Promise<{ callId: string; value: Planning }>,
  onAttempt?: (attempt: PlanningAttempt, state: PlanningProgress) => Promise<void>,
  measureInput: (input: object) => number = input => Buffer.byteLength(JSON.stringify(input))) {
  const catalog = [...context.baseline.values()].map(s => ({ path: s.path, kind: s.kind, sha256: s.sha256 }))
  const index = context.index.map(i => ({ path: i.path, language: i.language, capabilities: i.capabilities, symbols: i.symbols, imports: i.imports, exports: i.exports, unknowns: i.unknowns }))
  const base = { task: 'design-planning', primaryFiles: inventory.primaryFiles, catalog, index, referenceAngles: dimensions,
    projectHints: { groups: inventory.packages.map(p => ({ path: p.path, name: p.name })), flows: inventory.flowHints },
    requestedAngles: inventory.requestedDimensions, budgets: inventory.budgets,
    requirements: [
      '先从实际源码识别模块、职责与协作边界，再定义全部适用审查角度。referenceAngles 是开放参考，可补充、调整；角度是问题，不是预设缺陷或答案。',
      'referenceCoverage 必须逐一说明每个参考角度是保留、调整到哪些角度，还是不适用及原因，不能遗漏；允许新增角度。所有选中角度与每个模块都派独立任务，不按规划时的局部适用性跳过模块。',
      '每个主审文本文件恰好归属一个模块；上下文读取可跨模块。只能 excludedFiles 排除明确的二进制/符号链接，不能排除未读文本或读取失败。',
      '模块必须有已读实现的逐字快照证据。reviewedFiles 恰好列出全部模块文件，未提供源码的文件先请求补读，不凭文件名声称已分析。',
      '下一阶段每个 agent 只分析一个模块的一个角度，将执行模块×角度的完整笛卡尔积。按真实职责分界，注意模块完整输入预算；不要把大模块静默截断。',
      '模块和角度 id 使用稳定的字母开头标识，只含字母、数字、下划线、横线。已有 D1–D12 概念保持相应 id，新增角度可用新 id。',
      'validationFeedback 是宿主对上次响应的校验错误；基于相同快照修正完整响应。逐条核对引文首尾行，不得省略错误证据、文件或参考角度来绕过覆盖约束。',
      '缺少必要实现时 status=needs_context，通过 contextRequests 请求明确路径；不能执行工具或命令。最终 planned 不得有 contextRequests/gaps。',
    ] }
  const all = mergePromptSources(inventory.primaryFiles.map(p => context.baseline.get(p)!), contracts)
  let sources = all
  const state = planningProgress()
  let previous: Planning | null = null
  let resolution: object | null = null
  let round = 0, corrections = 0, attemptNumber = 0
  const input = () => ({ ...base, sources: sources.map(sourceInput),
    unreadFiles: inventory.primaryFiles.filter(p => !sources.some(s => s.path === p)), previous,
    contextResolution: resolution, round, corrections, validationFeedback: state.validationIssues })
  if (measureInput(input()) > inventory.budgets.maxInputBytes) {
    sources = [...new Map([...all.filter(s => isEntryContract(s.path)), ...contracts].map(s => [s.path, s])).values()]
  }
  while (true) {
    const stage = `planning-${attemptNumber++}`
    // Invocation errors propagate directly: only returned, schema-valid proposals can be corrected.
    const { callId, value } = await invoke(stage, input())
    const snapshotIds = sources.map(s => s.id)
    const issues = validatePlanning(context, inventory, value, snapshotIds)
    const outcome = value.status === 'incomplete' ? 'incomplete' : issues.length ? 'invalid'
      : value.status === 'needs_context' ? 'needs_context' : 'accepted'
    const attempt: PlanningAttempt = { callId, stage, outcome, proposal: value, validationIssues: issues, snapshotIds }
    state.proposedPlan = value
    state.validationIssues = issues
    state.attempts.push({ callId, stage, outcome, validationIssues: issues, artifact: `planning/${callId}.json` })
    if (outcome === 'accepted') state.acceptedCallId = callId
    await onAttempt?.(attempt, state)
    if (outcome === 'incomplete') throw new Error(`Module/angle planning is incomplete: ${value.gaps.join('; ') || value.summary}`)
    if (issues.length) {
      if (corrections >= inventory.budgets.planningCorrections) throw new PlanningValidationError(issues)
      corrections++
      previous = value
      continue
    }
    if (outcome === 'accepted') return { ...createModulePlan(context, inventory, value, snapshotIds), planning: state }
    if (round === inventory.budgets.contextRounds) throw new Error('Planning context budget exhausted')
    try {
      const added = await context.resolveRequestsDetailed(value.contextRequests as ContextRequest[], inventory.budgets.contextFiles)
      sources = mergePromptSources(sources, added.snapshots); resolution = added.resolution
    } catch (error) {
      if (!(error instanceof ContextSelectionRequired)) throw error
      resolution = { status: 'selection_required', candidates: error.paths, message: error.message }
    }
    previous = value
    round++
  }
}
