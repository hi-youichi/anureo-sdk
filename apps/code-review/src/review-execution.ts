import { HarnessSdkError, type Client } from '@anureo/sdk'
import { agent, parallel } from '@anureo/workflow'
import type { ReviewAngle } from './angles'
import { reviewFailure } from './errors'
import type { ReviewProgress } from './progress'
import { buildReviewPrompt } from './prompts'
import type { AngleReview, ModuleReview } from './results'
import { reviewOutputSchema, type ReviewModule } from './schema'
import { validateFindings, validateOutput } from './validation'
import { withAgentWorktree } from './worktree'

/** Prepared run settings shared by analysis, angle execution and fix scheduling.
 * The client remains borrowed. reviewCode supplies an observer that collects synchronous exceptions. */
export interface ReviewExecutionOptions {
  client: Client
  /** Canonical absolute source directory established by prepareReview. */
  cwd: string
  /** Git root used to isolate agents in fix mode. Omission runs agents in cwd. */
  repositoryRoot?: string
  /** Absolute workflow storage root excluded from source validation. */
  directory: string
  model?: string
  focus?: string
  /** Git metadata fingerprint embedded in prompts. Null omits provenance. Sources can change after sampling. */
  sourceVersion: string | null
  angles: readonly ReviewAngle[]
  concurrency: number
  onProgress?: (event: ReviewProgress) => void
}

/** Phase used by angle prompts and progress events. Verification starts after the writer queue drains. */
export type ReviewPhase = 'review' | 'verification'
/** Await work under the run permit pool, propagating its value or rejection. The callback
 * owns its resources and should finish cleanup before settling so the permit covers that work. */
export type Schedule = <T>(execute: () => Promise<T>) => Promise<T>

/** Dispatch a module's angles with the run's shared capacity. Initial review takes a planned
 * module. Verification takes its original review, whose completed findings are matched by angle ID. */
export type ModuleReviewInput = {
  options: ReviewExecutionOptions
  schedule: Schedule
} & ({ phase: 'review'; module: ReviewModule } | { phase: 'verification'; previous: ModuleReview })

/** Create one permit pool for reviewCode's prevalidated positive concurrency limit.
 * reviewModule uses it for individual angles and runModuleFix uses it for the queue head.
 * Each settled operation hands its permit to the oldest waiter or returns it to the pool. */
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

/** Return a module's coverage in angle order after every scheduled angle settles.
 * reviewModuleLifecycle passes this coverage to the optional fix queue. verifyFinalTree stores
 * it for the final report. Rejected tasks become failed slots. Fatal agent errors are also
 * recorded by workflow and can cause reviewCode to reject. */
export async function reviewModule(input: ModuleReviewInput): Promise<ModuleReview> {
  const { options, phase, schedule } = input
  const module = phase === 'review' ? input.module : input.previous.module
  const previousAngles = phase === 'verification' ? input.previous.angles : undefined
  const results = await parallel(options.angles.map(angle => () => schedule(() => reviewAngle({
    options, module, angle, phase,
    original: previousAngles?.find(value => value.angle.id === angle.id),
  }))))
  // parallel preserves positions; retain coverage when a task fails outside its agent call.
  return { module, angles: options.angles.map((angle, index) => results[index] ??
    failedAngleReview(angle, `Angle task for ${angle.id} failed before producing a result`)) }
}

/** Supply failed angle slots in configured order when reviewModules or verifyFinalTree has no
 * result for a module. Each caller stores the fallback in its corresponding report slot. */
export function failedModuleReview(angles: readonly ReviewAngle[], module: ReviewModule, message: string): ModuleReview {
  return { module, angles: angles.map(angle => failedAngleReview(angle, message)) }
}

interface AngleReviewInput {
  options: ReviewExecutionOptions
  module: ReviewModule
  angle: ReviewAngle
  phase: ReviewPhase
  original?: AngleReview
}

/** Run one angle for reviewModule while it holds a permit. Validate findings in the same source
 * view the agent used and wait for any temporary checkout cleanup. Agent, validation
 * and worktree failures become failed coverage. A failure preparing the prompt or emitting an
 * event rejects the task for reviewModule's positional fallback. */
async function reviewAngle({ options, module, angle, phase, original }: AngleReviewInput): Promise<AngleReview> {
  const progress = { stage: phase, moduleId: module.id, angleId: angle.id }
  options.onProgress?.({ ...progress, status: 'started' })
  const prompt = buildReviewPrompt({ ...options, phase, module, angle, original })
  let result: AngleReview
  try {
    const findings = await withAgentWorktree({ root: options.repositoryRoot, cwd: options.cwd, directory: options.directory },
      async (cwd, directory) => {
        const output = await agent(prompt, {
          client: options.client, cwd, model: options.model, schema: reviewOutputSchema,
        })
        if (output === null) throw new HarnessSdkError('REVIEW_AGENT_INCOMPLETE', 'Review agent returned no result')
        return validateOutput(() => validateFindings(cwd, module, output.findings, directory))
      })
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
