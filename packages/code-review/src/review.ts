import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent, parallel, workflow } from '@anureo/workflow'
import { defaultAngles, type ReviewAngle } from './angles'
import { reviewFailure, type ReviewFailure } from './errors'
import { fixFindings, type FixReport } from './fix'
import { DEFAULT_WORKFLOW_DIRECTORY } from './paths'
import { buildAnalysisPrompt, readOnlyInstructions } from './prompts'
import { createReviewSchedule, failedModuleReview, reviewModule, type ReviewExecutionOptions, type Schedule } from './review-execution'
import { modulePlanSchema, type Finding, type ModulePlan, type ReviewModule } from './schema'
import { validateOutput, validatePlan } from './validation'

export type { ReviewFailure } from './errors'

export const DEFAULT_REVIEW_CONCURRENCY = 8

export type AngleReview = { angle: ReviewAngle } & (
  | { status: 'completed'; findings: Finding[] }
  | { status: 'failed'; error: ReviewFailure }
)

export interface ModuleReview {
  module: ReviewModule
  angles: AngleReview[]
}

/** A module's original review, incremental fix, and final verification.
 * Fixes start as modules finish reviewing. Verification runs after all fixes settle. */
export interface ModuleOutcome {
  review: ModuleReview
  /** Null when no fix was requested. */
  fix: FixReport | null
  /** Review of the final tree, including dependency changes from other modules.
   * Null unless at least one module's fix was applied. */
  verification: ModuleReview | null
}

export interface ReviewReport {
  runId: string
  workflowDirectory: string
  cwd: string
  /** 'completed' only when every module's review/verification angles completed
   * and its fix (if requested) did not fail; engine-level interruption also
   * downgrades to 'incomplete'. */
  status: 'completed' | 'incomplete'
  plan: ModulePlan
  scope: { moduleIds: string[]; angleIds: string[] }
  modules: ModuleOutcome[]
  /** Errors thrown by onProgress. Observers do not change execution outcomes. */
  progressErrors: ReviewFailure[]
  /** Findings from final verification when any fix was applied, otherwise
   * from the original reviews. */
  findingCount: number
}

export type ReviewProgress =
  | { stage: 'workflow'; status: 'started'; runId: string; directory: string }
  | { stage: 'analysis'; status: 'started' | 'completed' }
  | { stage: 'review' | 'verification'; status: 'started' | 'completed' | 'failed'; moduleId: string; angleId: string }
  | { stage: 'fix'; status: 'started' | 'completed' | 'failed' | 'skipped'; moduleId: string }

export interface ReviewOptions {
  client: Client
  cwd: string
  model?: string
  focus?: string
  angles?: readonly ReviewAngle[]
  /** Review only these exact IDs from the analyzed module plan. */
  moduleIds?: readonly string[]
  /** Review at most this many selected modules, in plan order. */
  maxModules?: number
  /** Fix each module's findings as soon as its review completes, then re-review
   * the selected scope after all fixes settle. Defaults to false. */
  fix?: boolean
  /** Session permission mode for the fix agent (edits and checks). Harness-specific; see fixPermissionMode(). */
  fixPermissionMode?: string
  /** Shared limit across all modules, angles, and fix agents; defaults to DEFAULT_REVIEW_CONCURRENCY. */
  concurrency?: number
  /** Durable run storage. Defaults to <cwd>/.anureo/workflows. */
  workflowDirectory?: string
  /** Observational only: thrown errors are collected in the report's progressErrors. */
  onProgress?: (event: ReviewProgress) => void
}

const execReview = promisify(execFile)

/** Content-state fingerprint (HEAD + porcelain status). Null outside a git repository. */
async function readGitStateFingerprint(cwd: string): Promise<string | null> {
  try {
    const head = await execReview('git', ['-C', cwd, 'rev-parse', 'HEAD'], { maxBuffer: 1 << 24 })
    const status = await execReview('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 1 << 24 })
    return createHash('sha256').update(head.stdout).update('\0').update(status.stdout).digest('hex')
  } catch {
    return null
  }
}

function selectModules(plan: ModulePlan, moduleIds: readonly string[] | undefined, maxModules: number | undefined): ReviewModule[] {
  const available = new Set(plan.modules.map(module => module.id))
  const unknown = moduleIds?.filter(id => !available.has(id)) ?? []
  if (unknown.length > 0) {
    throw new HarnessSdkError('REVIEW_MODULE_NOT_FOUND', `Unknown module ids: ${unknown.join(', ')}. Available: ${[...available].join(', ')}`)
  }
  const selected = moduleIds ? plan.modules.filter(module => moduleIds.includes(module.id)) : plan.modules
  return maxModules === undefined ? selected : selected.slice(0, maxModules)
}

function validateReviewOptions(options: ReviewOptions) {
  const fixRequested = options.fix ?? false
  const concurrency = options.concurrency ?? DEFAULT_REVIEW_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive safe integer')
  const maxModules = options.maxModules
  if (maxModules !== undefined && (!Number.isSafeInteger(maxModules) || maxModules < 1)) throw new Error('maxModules must be a positive safe integer')
  const moduleIds = options.moduleIds ? [...options.moduleIds] : undefined
  if (moduleIds && (moduleIds.length === 0 || moduleIds.some(id => !id.trim()) || new Set(moduleIds).size !== moduleIds.length)) {
    throw new Error('moduleIds must contain unique nonempty module ids')
  }
  if (moduleIds && moduleIds.some(id => Buffer.byteLength(id) > 256)) {
    throw new Error('moduleIds must be at most 256 bytes each (workflow step-key limit)')
  }
  const angles = (options.angles ?? defaultAngles).map(angle => ({ ...angle }))
  if (angles.length === 0 || angles.some(angle => !angle.id.trim() || !angle.title.trim() || !angle.instructions.trim())
    || new Set(angles.map(angle => angle.id)).size !== angles.length) {
    throw new Error('Review angles must have unique nonempty ids and nonempty titles and instructions')
  }
  if (angles.some(angle => Buffer.byteLength(angle.id) > 256)) {
    throw new Error('Review angle ids must be at most 256 bytes (workflow step-key limit)')
  }
  return { fixRequested, concurrency, maxModules, moduleIds, angles }
}

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

/** Serialize writers before acquiring agent capacity, leaving queued fixes out
 * of the shared permit pool. A failed fix stops subsequent writers. */
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
  const review = await reviewModule({ ...execution, sourceVersion: await readGitStateFingerprint(execution.cwd) },
    module, 'review', schedule, undefined)
  const fix = runFix ? await runFix(review) : null
  return { review, fix, verification: null }
}

function moduleOutcomeComplete(outcome: ModuleOutcome): boolean {
  const anglesComplete = (review: ModuleReview) => review.angles.every(angle => angle.status === 'completed')
  return anglesComplete(outcome.review)
    && (outcome.verification === null || anglesComplete(outcome.verification))
    && outcome.fix?.status !== 'failed'
}

function buildReviewReport(input: {
  runId: string
  execution: ReviewExecutionOptions
  plan: ModulePlan
  selectedModules: readonly ReviewModule[]
  outcomes: ModuleOutcome[]
  progressErrors: ReviewFailure[]
}): ReviewReport {
  const { runId, execution, plan, selectedModules, outcomes, progressErrors } = input
  const findingCount = outcomes.reduce((count, outcome) => count + (outcome.verification ?? outcome.review).angles.reduce(
    (sum, angle) => sum + (angle.status === 'completed' ? angle.findings.length : 0), 0), 0)
  return {
    runId, workflowDirectory: execution.directory, cwd: execution.cwd, plan, modules: outcomes, progressErrors,
    scope: { moduleIds: selectedModules.map(module => module.id), angleIds: execution.angles.map(angle => angle.id) },
    status: outcomes.every(moduleOutcomeComplete) ? 'completed' : 'incomplete', findingCount,
  }
}

/** Analyze once, fix modules incrementally, then verify the final selected scope. */
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
    const results = await parallel(selectedModules.map(module => () => reviewModuleLifecycle({
      execution, module, schedule, runFix,
    })))
    // parallel preserves positions; retain coverage when a lifecycle task fails outside its agent calls.
    const outcomes = selectedModules.map((module, index) => results[index] ?? {
      review: failedModuleReview(execution, module, `Module task for ${module.id} failed before producing a result`),
      fix: null, verification: null,
    })
    if (outcomes.some(outcome => outcome.fix?.status === 'applied')) {
      const finalExecution = { ...execution, sourceVersion: await readGitStateFingerprint(execution.cwd) }
      const verifications = await parallel(outcomes.map(outcome => () =>
        reviewModule(finalExecution, outcome.review.module, 'verification', schedule, outcome.review)))
      for (const [index, outcome] of outcomes.entries()) {
        outcome.verification = verifications[index] ?? failedModuleReview(execution, outcome.review.module,
          `Verification task for ${outcome.review.module.id} failed before producing a result`)
      }
    }
    return buildReviewReport({ runId: run.runId, execution, plan, selectedModules, outcomes, progressErrors })
  })
  return { ...completed.result, status: completed.status === 'incomplete' ? 'incomplete' : completed.result.status }
}
