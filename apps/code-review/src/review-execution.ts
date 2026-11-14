import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent, parallel } from '@anureo/workflow'
import type { ReviewAngle } from './angles'
import type { ReviewProgress } from './progress'
import { reviewFailure } from './errors'
import { buildReviewPrompt } from './prompts'
import type { AngleReview, ModuleReview } from './results'
import { reviewOutputSchema, type ReviewModule } from './schema'
import { validateFindings, validateOutput } from './validation'

/** Internal normalized run inputs supplied by reviewCode to angle execution and fix scheduling.
 * The client remains borrowed; the observer is already wrapped to collect callback errors. */
export interface ReviewExecutionOptions {
  client: Client
  /** Canonical absolute source directory established by prepareReview. */
  cwd: string
  /** Absolute workflow storage root excluded from source validation. */
  directory: string
  model?: string
  focus?: string
  /** Git metadata fingerprint embedded in prompts; null omits provenance, and no source lock is held. */
  sourceVersion: string | null
  angles: readonly ReviewAngle[]
  concurrency: number
  onProgress?: (event: ReviewProgress) => void
}

/** Prompt and progress phase: initial reviews may overlap fixes; verification follows all writers. */
export type ReviewPhase = 'review' | 'verification'
/** Await queued work under the run permit pool, propagating its value or rejection.
 * The operation retains responsibility for its resources; the scheduler releases only capacity. */
export type Schedule = <T>(execute: () => Promise<T>) => Promise<T>

/** Internal dispatch input for reviewModuleLifecycle and verifyFinalTree, sharing one run's capacity. */
export interface ModuleReviewInput {
  options: ReviewExecutionOptions
  module: ReviewModule
  phase: ReviewPhase
  schedule: Schedule
  /** Prior angle results matched by ID; only completed findings enter verification prompts. */
  previous?: ModuleReview
}

/** Create reviewCode's shared permit pool for its validated positive concurrency limit.
 * Queued work starts FIFO; each permit is released when its operation settles, including rejection. */
export function createReviewSchedule(limit: number): Schedule {
  let available = limit
  const waiting: Array<() => void> = []
  return async execute => {
    if (available === 0) await new Promise<void>(resume => waiting.push(resume))
    else available--
    try { return await execute() }
    finally {
      const resume = waiting.shift()
      if (resume) resume()
      else available++
    }
  }
}

/** Internal dispatch used by reviewModuleLifecycle and verifyFinalTree. Await every selected angle
 * through the shared schedule and return coverage in angle order, substituting failed slots for
 * rejected tasks. Fatal agent errors also stop the enclosing workflow, which can still reject. */
export async function reviewModule(input: ModuleReviewInput): Promise<ModuleReview> {
  const { options, module, phase, schedule, previous } = input
  const results = await parallel(options.angles.map(angle => () => schedule(() =>
    reviewAngle({ options, module, angle, phase, original: previous?.angles.find(value => value.angle.id === angle.id) }))))
  // parallel preserves positions; retain coverage when a task fails outside its agent call.
  return { module, angles: options.angles.map((angle, index) => results[index] ??
    failedAngleReview(angle, `Angle task for ${angle.id} failed before producing a result`)) }
}

/** Internal fallback for reviewModules and verifyFinalTree when a task produces no module result.
 * Preserve every selected angle as failed coverage instead of treating the module as finding-free. */
export function failedModuleReview(options: ReviewExecutionOptions, module: ReviewModule, message: string): ModuleReview {
  return { module, angles: options.angles.map(angle => failedAngleReview(angle, message)) }
}

interface AngleReviewInput {
  options: ReviewExecutionOptions
  module: ReviewModule
  angle: ReviewAngle
  phase: ReviewPhase
  original?: AngleReview
}

/** Await one angle agent and validate its findings; agent/output failures become failed coverage.
 * Prompt/progress failures outside that boundary reach reviewModule's parallel fallback instead. */
async function reviewAngle({ options, module, angle, phase, original }: AngleReviewInput): Promise<AngleReview> {
  const progress = { stage: phase, moduleId: module.id, angleId: angle.id }
  options.onProgress?.({ ...progress, status: 'started' })
  const prompt = buildReviewPrompt({ ...options, phase, module, angle, original })
  let result: AngleReview
  try {
    const output = await agent(prompt, {
      client: options.client, cwd: options.cwd, model: options.model, schema: reviewOutputSchema,
    })
    if (output === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Review agent returned no result')
    const findings = await validateOutput(() => validateFindings(options.cwd, module, output.findings, options.directory))
    result = { angle, status: 'completed', findings }
  } catch (cause) {
    result = { angle, status: 'failed', error: reviewFailure(cause) }
  }
  options.onProgress?.({ ...progress, status: result.status === 'completed' ? 'completed' : 'failed' })
  return result
}

/** Preserve an angle slot when parallel work returned no result, using a normalized local failure. */
function failedAngleReview(angle: ReviewAngle, message: string): AngleReview {
  return { angle, status: 'failed', error: reviewFailure(new Error(message)) }
}
