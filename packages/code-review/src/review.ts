import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent, workflow } from '@anureo/workflow'
import { defaultAngles, type ReviewAngle } from './angles'
import type { ReviewFailure } from './errors'
import { fixFindings, type FixReport } from './fix'
import { DEFAULT_WORKFLOW_DIRECTORY } from './paths'
import { buildAnalysisPrompt, readOnlyInstructions } from './prompts'
import { reviewModules, type ReviewExecutionOptions } from './review-execution'
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

export interface ReviewReport {
  runId: string
  workflowDirectory: string
  cwd: string
  /** 'completed' only when every review/verification angle completed and the fix
   * (if requested) did not fail; engine-level interruption also downgrades to 'incomplete'. */
  status: 'completed' | 'incomplete'
  plan: ModulePlan
  scope: { moduleIds: string[]; angleIds: string[] }
  modules: ModuleReview[]
  fix: FixReport | null
  /** Post-fix re-review of the selected scope; null unless a fix was applied. */
  verification: ModuleReview[] | null
  /** Findings from the authoritative pass: verification when a fix was applied, otherwise the original review. */
  findingCount: number
}

export type ReviewProgress =
  | { stage: 'workflow'; status: 'started'; runId: string; directory: string }
  | { stage: 'analysis'; status: 'started' | 'completed' }
  | { stage: 'review' | 'verification'; status: 'started' | 'completed' | 'failed'; moduleId: string; angleId: string }
  | { stage: 'fix'; status: 'started' | 'completed' | 'failed' | 'skipped' }

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
  /** Let an agent fix findings by editing sources directly, then review the selected scope again. Defaults to false. */
  fix?: boolean
  /** Session permission mode for the fix agent (edits and checks). Harness-specific; see fixPermissionMode(). */
  fixPermissionMode?: string
  /** Shared limit across all modules and angles; defaults to DEFAULT_REVIEW_CONCURRENCY. */
  concurrency?: number
  /** Durable run storage. Defaults to <cwd>/.anureo/workflows. */
  workflowDirectory?: string
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

interface ReportInput {
  runId: string
  execution: ReviewExecutionOptions
  plan: ModulePlan
  selectedModules: readonly ReviewModule[]
  reviews: ModuleReview[]
  fix: FixReport | null
  verification: ModuleReview[] | null
}

function buildReviewReport(input: ReportInput): ReviewReport {
  const { runId, execution, plan, selectedModules, reviews, fix, verification } = input
  const allPassesComplete = [...reviews, ...(verification ?? [])]
    .every(module => module.angles.every(angle => angle.status === 'completed'))
  // A successful fix makes verification the authoritative pass for findings.
  const authoritativeReviews = verification ?? reviews
  const findingCount = authoritativeReviews.reduce((count, module) => count + module.angles.reduce(
    (sum, angle) => sum + (angle.status === 'completed' ? angle.findings.length : 0), 0), 0)
  return {
    runId, workflowDirectory: execution.directory, cwd: execution.cwd, plan, modules: reviews, fix, verification,
    scope: { moduleIds: selectedModules.map(module => module.id), angleIds: execution.angles.map(angle => angle.id) },
    status: allPassesComplete && fix?.status !== 'failed' ? 'completed' : 'incomplete', findingCount,
  }
}

/** Analyze modules once, then review modules and their angles concurrently. Borrows the client. */
export async function reviewCode(options: ReviewOptions): Promise<ReviewReport> {
  const prepared = await prepareReview(options)
  const { execution, fixRequested, moduleIds, maxModules } = prepared
  // Bump revision when the persisted input/checkpoint contract changes.
  // sourceVersion carries the Git state fingerprint; backendConfiguration remains reserved.
  const completed = await workflow({
    name: 'code-review', revision: '5', directory: execution.directory, input: prepared.workflowInput,
  }, async (run): Promise<ReviewReport> => {
    options.onProgress?.({ stage: 'workflow', status: 'started', runId: run.runId, directory: execution.directory })
    const plan = await analyzeModules(execution, prepared.analysisPrompt)
    const selectedModules = selectModules(plan, moduleIds, maxModules)
    const reviews = await reviewModules(execution, selectedModules, 'review')
    const fix = fixRequested ? await fixFindings({
      sourceVersion: execution.sourceVersion,
      client: options.client, cwd: execution.cwd, directory: execution.directory, modules: reviews, model: options.model,
      ...(options.fixPermissionMode !== undefined ? { permissionMode: options.fixPermissionMode } : {}),
      onProgress: status => options.onProgress?.({ stage: 'fix', status }),
    }) : null
    const verification = fix?.status === 'applied'
      ? await reviewModules(execution, selectedModules, 'verification', reviews) : null
    return buildReviewReport({ runId: run.runId, execution, plan, selectedModules, reviews, fix, verification })
  })
  return { ...completed.result, status: completed.status === 'incomplete' ? 'incomplete' : completed.result.status }
}
