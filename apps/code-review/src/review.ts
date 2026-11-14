// Coordinates analysis, module review, serialized fixes and final verification.
import { resolve } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { agent, parallel, workflow } from '@anureo/workflow'
import { reviewFailure, type ReviewFailure } from './errors'
import { fixFindings } from './fix'
import { reviewRepositoryRoot } from './git'
import { readGitStateFingerprint } from './git-state'
import { validateReviewOptions, type ReviewOptions } from './options'
import { DEFAULT_WORKFLOW_DIRECTORY, resolveReviewDirectory } from './paths'
import { buildAnalysisPrompt, readOnlyInstructions } from './prompts'
import { createReviewSchedule, failedModuleReview, reviewModule, type ReviewExecutionOptions, type Schedule } from './review-execution'
import { buildReviewReport } from './review-report'
import type { FixReport, ModuleOutcome, ModuleReview, ReviewReport } from './results'
import { modulePlanSchema, type ModulePlan, type ReviewModule } from './schema'
import { validateOutput, validatePlan } from './validation'
import { withAgentWorktree } from './worktree'

// Preserve direct source imports while shared contracts have independent owners.
export type { ReviewFailure } from './errors'
export { DEFAULT_REVIEW_CONCURRENCY } from './options'
export type { ReviewOptions } from './options'
export type { ReviewProgress } from './progress'
export type { AngleReview, ModuleReview, ModuleOutcome, ReviewReport } from './results'

/** Analyze source modules, review selected angles and optionally apply fixes to the original
 * work tree. If a fix reports changed files, recheck every selected module after the writers settle.
 * Resolves with a report after workflow publication and lock release. Ordinary angle and fix
 * failures are recorded in an incomplete report. Finding counts come from verification when
 * it runs. Invalid options or module IDs, analysis failures and fatal execution or workflow
 * storage failures reject.
 * Synchronous observer exceptions are collected in the report's progressErrors. Keep the
 * initialized client usable until the promise settles, then dispose it separately. */
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
    name: 'code-review', revision: '8', directory: execution.directory, input: prepared.workflowInput,
  }, async (run): Promise<ReviewReport> => {
    execution.onProgress?.({ stage: 'workflow', status: 'started', runId: run.runId, directory: execution.directory })
    const plan = await analyzeModules(execution, prepared.analysisPrompt)
    const selectedModules = selectModules({ plan, moduleIds, maxModules })
    const schedule = createReviewSchedule(execution.concurrency)
    const runFix = fixRequested
      ? createFixRunner({ execution, schedule, permissionMode: options.fixPermissionMode })
      : null
    const outcomes = await reviewModules({ execution, modules: selectedModules, schedule, runFix })
    await verifyFinalTree({ execution, outcomes, schedule })
    return buildReviewReport({ runId: run.runId, execution, plan, selectedModules, outcomes, progressErrors })
  })
  return { ...completed.result, status: completed.status === 'incomplete' ? 'incomplete' : completed.result.status }
}

/** Return plan-ordered outcomes to reviewCode after every module lifecycle and queued fix settles.
 * Replace rejected lifecycles with failed coverage so final verification and reporting retain
 * the selected scope. The enclosing workflow still rejects if it recorded a fatal error. */
async function reviewModules({ execution, modules, schedule, runFix }: Omit<LifecycleOptions, 'module'> & {
  modules: readonly ReviewModule[]
}): Promise<ModuleOutcome[]> {
  const results = await parallel(modules.map(module => () => reviewModuleLifecycle({ execution, module, schedule, runFix })))
  return modules.map((module, index) => results[index] ?? {
    review: failedModuleReview(execution.angles, module, `Module task for ${module.id} failed before producing a result`),
    fix: null, verification: null,
  })
}

/** Fill verification slots in place for reviewCode's report once reviewModules has drained the
 * writers. A fix that reports changed files triggers a recheck of all selected modules because
 * edits can affect callers elsewhere. Share one provenance value across the recheck and turn
 * rejected module tasks into failed coverage. */
async function verifyFinalTree({ execution, outcomes, schedule }: {
  execution: ReviewExecutionOptions
  outcomes: ModuleOutcome[]
  schedule: Schedule
}): Promise<void> {
  if (!outcomes.some(outcome => outcome.fix && outcome.fix.changedFiles.length > 0)) return
  const finalExecution = { ...execution, sourceVersion: await readGitStateFingerprint(execution.cwd) }
  const verifications = await parallel(outcomes.map(outcome => () => reviewModule({
    options: finalExecution, phase: 'verification', schedule, previous: outcome.review,
  })))
  for (const [index, outcome] of outcomes.entries()) {
    outcome.verification = verifications[index] ?? failedModuleReview(execution.angles, outcome.review.module,
      `Verification task for ${outcome.review.module.id} failed before producing a result`)
  }
}

/** Give reviewCode the requested modules in plan order, capped only after ID filtering.
 * Throws for unknown requested IDs before any module review or fix starts. */
function selectModules({ plan, moduleIds, maxModules }: {
  plan: ModulePlan
  moduleIds?: readonly string[]
  maxModules?: number
}): ReviewModule[] {
  const available = new Set(plan.modules.map(module => module.id))
  const unknown = moduleIds?.filter(id => !available.has(id)) ?? []
  if (unknown.length > 0) {
    throw new HarnessSdkError('REVIEW_MODULE_NOT_FOUND', `Unknown module ids: ${unknown.join(', ')}. Available: ${[...available].join(', ')}`)
  }
  const selected = moduleIds ? plan.modules.filter(module => moduleIds.includes(module.id)) : plan.modules
  return maxModules === undefined ? selected : selected.slice(0, maxModules)
}

/** Prepare execution settings and persisted identity inputs for reviewCode. Validate selections,
 * resolve the source directory and require a Git root for fix mode before opening workflow
 * storage or agent sessions. A failed preflight rejects the call. */
async function prepareReview(options: ReviewOptions) {
  const selection = validateReviewOptions(options)
  const { fixRequested, concurrency, maxModules, moduleIds, angles } = selection
  const cwd = await resolveReviewDirectory(options.cwd)
  const repositoryRoot = fixRequested ? await reviewRepositoryRoot(cwd) : undefined
  const version = await readGitStateFingerprint(cwd)
  const analysisPrompt = buildAnalysisPrompt({ focus: options.focus, sourceVersion: version })
  const directory = resolve(options.workflowDirectory ?? resolve(cwd, DEFAULT_WORKFLOW_DIRECTORY))
  const execution: ReviewExecutionOptions = {
    client: options.client, cwd, directory, model: options.model, focus: options.focus,
    sourceVersion: version, repositoryRoot, angles, concurrency, onProgress: options.onProgress,
  }
  return { ...selection, execution, analysisPrompt, workflowInput: {
    cwd, model: options.model ?? null, focus: options.focus ?? null, concurrency,
    moduleIds: moduleIds ?? null, maxModules: maxModules ?? null, fix: fixRequested,
    angles, instructions: readOnlyInstructions, analysisPrompt,
    sourceVersion: version, backendConfiguration: null,
  } }
}

/** Supply reviewCode with the normalized plan for module selection. In fix mode, validate paths
 * first in the agent's checkout, then in the original tree where fixes will be applied.
 * A missing result, failed validation or failed agent/worktree operation rejects before dispatch. */
async function analyzeModules(execution: ReviewExecutionOptions, prompt: string): Promise<ModulePlan> {
  execution.onProgress?.({ stage: 'analysis', status: 'started' })
  const plan = await withAgentWorktree({ root: execution.repositoryRoot, cwd: execution.cwd, directory: execution.directory },
    async (cwd, directory) => {
      const analysis = await agent(prompt, {
        client: execution.client, cwd, model: execution.model, schema: modulePlanSchema,
      })
      if (analysis === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Module analysis failed: agent returned no result')
      const localPlan = await validateOutput(() => validatePlan(cwd, analysis, directory))
      return execution.repositoryRoot
        ? validateOutput(() => validatePlan(execution.cwd, localPlan, execution.directory))
        : localPlan
    })
  execution.onProgress?.({ stage: 'analysis', status: 'completed' })
  return plan
}

interface FixRunnerOptions {
  execution: ReviewExecutionOptions
  schedule: Schedule
  permissionMode?: string
}

/** Supply reviewModuleLifecycle with one fix queue. Lifecycles enqueue after their reviews
 * complete, so fixes run in enqueue order and only the head competes for an agent permit.
 * A failed fix report or rejection closes the queue to further writes. The current lifecycle
 * receives the original report or rejection, and later lifecycles receive skipped reports. */
function createFixRunner({ execution, schedule, permissionMode }: FixRunnerOptions) {
  let tail: Promise<void> = Promise.resolve()
  let stoppedBy: string | undefined
  return (review: ModuleReview): Promise<FixReport> => {
    const result = tail.then(async (): Promise<FixReport> => {
      if (stoppedBy !== undefined) {
        execution.onProgress?.({ stage: 'fix', status: 'skipped', moduleId: review.module.id })
        return { status: 'skipped', summary: `Fix skipped because module ${stoppedBy}'s fix failed. Previously applied fixes remain in the original work tree.`,
          changedFiles: [], error: null }
      }
      const fix = await runModuleFix({ execution, schedule, permissionMode, review })
      if (fix.status === 'failed') stoppedBy = review.module.id
      return fix
    })
    // Unexpected local failures must also stop queued writers. Workflow-level
    // fatal errors retain their original cause in the engine's run state.
    tail = result.then(() => undefined, () => { stoppedBy = review.module.id })
    return result
  }
}

/** Run the queue head under the shared permit. Capture provenance after acquiring capacity
 * and forward fixFindings' synchronous progress to the run observer. The queue consumes the
 * fix report or rejection after the permit is released. */
function runModuleFix({ execution, schedule, permissionMode, review }: FixRunnerOptions & { review: ModuleReview }): Promise<FixReport> {
  return schedule(async () => fixFindings({
    sourceVersion: await readGitStateFingerprint(execution.cwd),
    client: execution.client,
    cwd: execution.cwd,
    directory: execution.directory,
    repositoryRoot: execution.repositoryRoot,
    modules: [review],
    model: execution.model,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    onProgress: status => execution.onProgress?.({ stage: 'fix', status, moduleId: review.module.id }),
  }))
}

interface LifecycleOptions {
  execution: ReviewExecutionOptions
  module: ReviewModule
  schedule: Schedule
  runFix: ((review: ModuleReview) => Promise<FixReport>) | null
}

/** Return one initial review and its optional queued fix to reviewModules. The review's
 * provenance is sampled at module dispatch, which may overlap fixes for other modules.
 * Await the queued fix so reviewModules can drain writers and replace any rejected lifecycle
 * with failed coverage before final verification. */
async function reviewModuleLifecycle(options: LifecycleOptions): Promise<ModuleOutcome> {
  const { execution, module, schedule, runFix } = options
  const review = await reviewModule({
    options: { ...execution, sourceVersion: await readGitStateFingerprint(execution.cwd) }, module, phase: 'review', schedule,
  })
  const fix = runFix ? await runFix(review) : null
  return { review, fix, verification: null }
}
