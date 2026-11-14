// Coordinates analysis, module review, serialized fixes and final verification.
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { agent, parallel, workflow } from '@anureo/workflow'
import { reviewFailure, type ReviewFailure } from './errors'
import { fixFindings } from './fix'
import { DEFAULT_WORKFLOW_DIRECTORY } from './paths'
import { buildAnalysisPrompt, readOnlyInstructions } from './prompts'
import { createReviewSchedule, failedModuleReview, reviewModule, type ReviewExecutionOptions, type Schedule } from './review-execution'
import { modulePlanSchema, type ModulePlan, type ReviewModule } from './schema'
import { validateOutput, validatePlan } from './validation'
import { readGitStateFingerprint } from './git-state'
import { validateReviewOptions, type ReviewOptions } from './options'
import type { FixReport, ModuleOutcome, ModuleReview, ReviewReport } from './results'

// Preserve direct source imports while shared contracts have independent owners.
export type { ReviewFailure } from './errors'
export { DEFAULT_REVIEW_CONCURRENCY } from './options'
export type { ReviewOptions } from './options'
export type { ReviewProgress } from './progress'
export type { AngleReview, ModuleReview, ModuleOutcome, ReviewReport } from './results'

/** Analyze source modules, review selected angles and optionally fix and recheck the final tree.
 * Resolves after workflow persistence and agent cleanup; requested fixes can leave partial edits.
 * Invalid preflight, analysis and workflow failures reject; returned angle/fix failures retain
 * incomplete coverage. Synchronous observer exceptions are collected in progressErrors.
 * Await completion or rejection before disposing the supplied client; inspect any partial fix edits. */
export async function reviewCode(options: ReviewOptions): Promise<ReviewReport> {
  const progressErrors: ReviewFailure[] = []
  const prepared = await prepareReview({ ...options, onProgress: event => {
    try { options.onProgress?.(event) }
    catch (cause) { progressErrors.push(reviewFailure(cause)) }
  } })
  const { execution, fixRequested, moduleIds, maxModules } = prepared
  // Bump revision when the persisted input/checkpoint contract changes.
  // sourceVersion carries the Git state fingerprint; backendConfiguration remains reserved.
  const completed = await workflow({
    name: 'code-review', revision: '7', directory: execution.directory, input: prepared.workflowInput,
  }, async (run): Promise<ReviewReport> => {
    execution.onProgress?.({ stage: 'workflow', status: 'started', runId: run.runId, directory: execution.directory })
    const plan = await analyzeModules(execution, prepared.analysisPrompt)
    const selectedModules = selectModules(plan, moduleIds, maxModules)
    const schedule = createReviewSchedule(execution.concurrency)
    const runFix = fixRequested ? createFixRunner(execution, schedule, options.fixPermissionMode) : null
    const outcomes = await reviewModules({ execution, modules: selectedModules, schedule, runFix })
    await verifyFinalTree({ execution, outcomes, schedule })
    return buildReviewReport({ runId: run.runId, execution, plan, selectedModules, outcomes, progressErrors })
  })
  return { ...completed.result, status: completed.status === 'incomplete' ? 'incomplete' : completed.result.status }
}

/** Await every module lifecycle, including queued fixes, before returning plan-ordered coverage.
 * A rejected lifecycle becomes failed module coverage; workflow fatal state is handled by workflow. */
async function reviewModules({ execution, modules, schedule, runFix }: Omit<LifecycleOptions, 'module'> & {
  modules: readonly ReviewModule[]
}): Promise<ModuleOutcome[]> {
  const results = await parallel(modules.map(module => () => reviewModuleLifecycle({ execution, module, schedule, runFix })))
  return modules.map((module, index) => results[index] ?? {
    review: failedModuleReview(execution, module, `Module task for ${module.id} failed before producing a result`),
    fix: null, verification: null,
  })
}

/** Recheck all selected modules only after an applied fix, since edits can affect unchanged callers.
 * reviewCode calls this after reviewModules drains every writer. Capture one final provenance value
 * and fill verification slots in place, preserving coverage even when a verification task rejects. */
async function verifyFinalTree({ execution, outcomes, schedule }: {
  execution: ReviewExecutionOptions
  outcomes: ModuleOutcome[]
  schedule: Schedule
}): Promise<void> {
  if (!outcomes.some(outcome => outcome.fix?.status === 'applied')) return
  const finalExecution = { ...execution, sourceVersion: await readGitStateFingerprint(execution.cwd) }
  const verifications = await parallel(outcomes.map(outcome => () => reviewModule({
    options: finalExecution, module: outcome.review.module, phase: 'verification', schedule, previous: outcome.review,
  })))
  for (const [index, outcome] of outcomes.entries()) {
    outcome.verification = verifications[index] ?? failedModuleReview(execution, outcome.review.module,
      `Verification task for ${outcome.review.module.id} failed before producing a result`)
  }
}

/** Select plan entries in plan order, rejecting unknown requested IDs before review agents run. */
function selectModules(plan: ModulePlan, moduleIds: readonly string[] | undefined, maxModules: number | undefined): ReviewModule[] {
  const available = new Set(plan.modules.map(module => module.id))
  const unknown = moduleIds?.filter(id => !available.has(id)) ?? []
  if (unknown.length > 0) {
    throw new HarnessSdkError('REVIEW_MODULE_NOT_FOUND', `Unknown module ids: ${unknown.join(', ')}. Available: ${[...available].join(', ')}`)
  }
  const selected = moduleIds ? plan.modules.filter(module => moduleIds.includes(module.id)) : plan.modules
  return maxModules === undefined ? selected : selected.slice(0, maxModules)
}

/** Validate selections, resolve the source directory and capture prompt provenance before starting
 * the workflow. Filesystem/option failures reject without acquiring agent sessions. */
async function prepareReview(options: ReviewOptions) {
  const selection = validateReviewOptions(options)
  const { fixRequested, concurrency, maxModules, moduleIds, angles } = selection
  const cwd = await realpath(resolve(options.cwd))
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Review directory is not a directory: ${cwd}`)
  const version = await readGitStateFingerprint(cwd)
  const analysisPrompt = buildAnalysisPrompt({ focus: options.focus, sourceVersion: version })
  const directory = resolve(options.workflowDirectory ?? resolve(cwd, DEFAULT_WORKFLOW_DIRECTORY))
  const execution: ReviewExecutionOptions = {
    client: options.client, cwd, directory, model: options.model, focus: options.focus,
    sourceVersion: version, angles, concurrency, onProgress: options.onProgress,
  }
  return { ...selection, execution, analysisPrompt, workflowInput: {
    cwd, model: options.model ?? null, focus: options.focus ?? null, concurrency,
    moduleIds: moduleIds ?? null, maxModules: maxModules ?? null, fix: fixRequested,
    angles, instructions: readOnlyInstructions, analysisPrompt,
    sourceVersion: version, backendConfiguration: null,
  } }
}

/** Await one analysis agent and filesystem validation, then return the normalized plan. Missing
 * output and agent/validation failures reject the workflow before module dispatch. */
async function analyzeModules(execution: ReviewExecutionOptions, prompt: string): Promise<ModulePlan> {
  execution.onProgress?.({ stage: 'analysis', status: 'started' })
  const analysis = await agent(prompt, {
    client: execution.client, cwd: execution.cwd, model: execution.model, schema: modulePlanSchema,
  })
  if (analysis === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Module analysis failed: agent returned no result')
  const plan = await validateOutput(() => validatePlan(execution.cwd, analysis, execution.directory))
  execution.onProgress?.({ stage: 'analysis', status: 'completed' })
  return plan
}

/** Supply reviewModuleLifecycle with a fix queue ordered by review completion. Acquire agent
 * capacity only at the queue head so queued writers leave permits available for reviews. A failed result or
 * rejection skips later writers; the current caller receives the original result or rejection. */
function createFixRunner(execution: ReviewExecutionOptions, schedule: Schedule, permissionMode?: string) {
  let tail: Promise<void> = Promise.resolve()
  let stoppedBy: string | undefined
  return (review: ModuleReview): Promise<FixReport> => {
    const result = tail.then(async (): Promise<FixReport> => {
      const onProgress = (status: 'started' | 'completed' | 'failed' | 'skipped') =>
        execution.onProgress?.({ stage: 'fix', status, moduleId: review.module.id })
      if (stoppedBy !== undefined) {
        onProgress('skipped')
        return { status: 'skipped', summary: `Fix skipped because module ${stoppedBy}'s fix failed. Inspect the working tree before continuing.`,
          changedFiles: [], error: null }
      }
      const fix = await schedule(async () => fixFindings({
        sourceVersion: await readGitStateFingerprint(execution.cwd),
        client: execution.client, cwd: execution.cwd, directory: execution.directory, modules: [review], model: execution.model,
        ...(permissionMode !== undefined ? { permissionMode } : {}), onProgress,
      }))
      if (fix.status === 'failed') stoppedBy = review.module.id
      return fix
    })
    // Unexpected local failures must also stop queued writers. Workflow-level
    // fatal errors retain their original cause in the engine's run state.
    tail = result.then(() => undefined, () => { stoppedBy = review.module.id })
    return result
  }
}

interface LifecycleOptions {
  execution: ReviewExecutionOptions
  module: ReviewModule
  schedule: Schedule
  runFix: ((review: ModuleReview) => Promise<FixReport>) | null
}

/** Review one module and enqueue its fix immediately. Final verification waits
 * for every writer, since modules can read and depend on one another's files. */
async function reviewModuleLifecycle(options: LifecycleOptions): Promise<ModuleOutcome> {
  const { execution, module, schedule, runFix } = options
  const review = await reviewModule({
    options: { ...execution, sourceVersion: await readGitStateFingerprint(execution.cwd) }, module, phase: 'review', schedule,
  })
  const fix = runFix ? await runFix(review) : null
  return { review, fix, verification: null }
}

/** Require completed angle coverage and no failed fix; a skipped fix alone does not fail the outcome. */
function moduleOutcomeComplete(outcome: ModuleOutcome): boolean {
  const anglesComplete = (review: ModuleReview) => review.angles.every(angle => angle.status === 'completed')
  return anglesComplete(outcome.review)
    && (outcome.verification === null || anglesComplete(outcome.verification))
    && outcome.fix?.status !== 'failed'
}

/** Assemble plan-ordered outcomes and count findings from the authoritative pass: final verification
 * after any applied fix, otherwise the original reviews. Does not publish or mutate outcomes. */
function buildReviewReport(input: {
  runId: string
  execution: ReviewExecutionOptions
  plan: ModulePlan
  selectedModules: readonly ReviewModule[]
  outcomes: ModuleOutcome[]
  progressErrors: ReviewFailure[]
}): ReviewReport {
  const { runId, execution, plan, selectedModules, outcomes, progressErrors } = input
  const findingCount = outcomes.reduce((count, outcome) => count + countFindings(outcome.verification ?? outcome.review), 0)
  return {
    runId, workflowDirectory: execution.directory, cwd: execution.cwd, plan, modules: outcomes, progressErrors,
    scope: { moduleIds: selectedModules.map(module => module.id), angleIds: execution.angles.map(angle => angle.id) },
    status: outcomes.every(moduleOutcomeComplete) ? 'completed' : 'incomplete', findingCount,
  }
}

/** Count only observed findings; failed angle slots contribute zero without implying complete coverage. */
function countFindings(review: ModuleReview): number {
  return review.angles.reduce((count, angle) => count + (angle.status === 'completed' ? angle.findings.length : 0), 0)
}
