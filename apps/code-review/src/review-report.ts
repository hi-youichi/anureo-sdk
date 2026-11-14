// Builds the structured review result from settled module outcomes.
import type { ReviewFailure } from './errors'
import type { ModuleOutcome, ModuleReview, ReviewReport } from './results'
import type { ModulePlan, ReviewModule } from './schema'

/** Build the report from settled outcomes supplied in selected plan order. Count each module's
 * verification when present, otherwise its original review. reviewCode returns this object from
 * the workflow body for persistence, then applies any workflow status downgrade to its library
 * result. This builder retains the supplied outcome and progress arrays by reference. */
export function buildReviewReport(input: {
  runId: string
  execution: { directory: string; cwd: string; angles: readonly { id: string }[] }
  plan: ModulePlan
  selectedModules: readonly ReviewModule[]
  outcomes: ModuleOutcome[]
  progressErrors: ReviewFailure[]
}): ReviewReport {
  const { runId, execution, plan, selectedModules, outcomes, progressErrors } = input
  const findingCount = outcomes.reduce((count, outcome) =>
    count + countFindings(outcome.verification ?? outcome.review), 0)
  return {
    runId,
    workflowDirectory: execution.directory,
    cwd: execution.cwd,
    plan,
    modules: outcomes,
    progressErrors,
    scope: { moduleIds: selectedModules.map(module => module.id), angleIds: execution.angles.map(angle => angle.id) },
    status: outcomes.every(moduleOutcomeComplete) ? 'completed' : 'incomplete',
    findingCount,
  }
}

/** Require completed angle coverage and no failed fix; a skipped fix alone does not fail the outcome. */
function moduleOutcomeComplete(outcome: ModuleOutcome): boolean {
  const anglesComplete = (review: ModuleReview) => review.angles.every(angle => angle.status === 'completed')
  return anglesComplete(outcome.review)
    && (outcome.verification === null || anglesComplete(outcome.verification))
    && outcome.fix?.status !== 'failed'
}

/** Count only observed findings; failed angle slots contribute zero without implying complete coverage. */
function countFindings(review: ModuleReview): number {
  return review.angles.reduce((count, angle) => count + (angle.status === 'completed' ? angle.findings.length : 0), 0)
}
