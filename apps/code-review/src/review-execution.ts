import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent, parallel } from '@anureo/workflow'
import type { ReviewAngle } from './angles'
import { reviewFailure } from './errors'
import { buildReviewPrompt } from './prompts'
import type { AngleReview, ModuleReview, ReviewProgress } from './review'
import { reviewOutputSchema, type ReviewModule } from './schema'
import { validateFindings, validateOutput } from './validation'

export interface ReviewExecutionOptions {
  client: Client
  cwd: string
  directory: string
  model?: string
  focus?: string
  sourceVersion: string | null
  angles: readonly ReviewAngle[]
  concurrency: number
  onProgress?: (event: ReviewProgress) => void
}

export type ReviewPhase = 'review' | 'verification'
export type Schedule = <T>(execute: () => Promise<T>) => Promise<T>

/** One permit pool shared by every module, angle, and fix agent in a run. */
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

async function reviewAngle(
  options: ReviewExecutionOptions, module: ReviewModule, angle: ReviewAngle,
  phase: ReviewPhase, original: AngleReview | undefined,
): Promise<AngleReview> {
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

function failedAngleReview(angle: ReviewAngle, message: string): AngleReview {
  return { angle, status: 'failed', error: reviewFailure(new Error(message)) }
}

/** Review one module's angles concurrently through the shared schedule. */
export async function reviewModule(
  options: ReviewExecutionOptions, module: ReviewModule, phase: ReviewPhase,
  schedule: Schedule, previous: ModuleReview | undefined,
): Promise<ModuleReview> {
  const results = await parallel(options.angles.map(angle => () => schedule(() =>
    reviewAngle(options, module, angle, phase, previous?.angles.find(value => value.angle.id === angle.id)))))
  // parallel preserves positions; retain coverage when a task fails outside its agent call.
  return { module, angles: options.angles.map((angle, index) => results[index] ??
    failedAngleReview(angle, `Angle task for ${angle.id} failed before producing a result`)) }
}

/** Coverage placeholder when a module's lifecycle task fails before producing a result. */
export function failedModuleReview(options: ReviewExecutionOptions, module: ReviewModule, message: string): ModuleReview {
  return { module, angles: options.angles.map(angle => failedAngleReview(angle, message)) }
}
