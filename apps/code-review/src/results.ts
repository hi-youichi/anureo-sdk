// Shared review and fix outcomes consumed by execution, prompts and report presentation.
import type { ReviewAngle } from './angles'
import type { ReviewFailure } from './errors'
import type { Finding, ModulePlan, ReviewModule } from './schema'

/** Host-observed fix outcome. Failed fixes can retain partial edits; changedFiles contains only
 * allowed modifications observed by Git reconciliation, while error can describe scope violations. */
export interface FixReport {
  /** 'not-needed' means no findings; 'skipped' covers incomplete reviews, a prior fix failure or no
   * observed edits. 'applied' means edits passed scope reconciliation, not that findings were resolved. */
  status: 'not-needed' | 'skipped' | 'applied' | 'failed'
  /** Agent summary after successful reconciliation, or an explanation of a skipped/failed fix. */
  summary: string
  /** Sorted paths relative to the review directory, observed since this fix's baseline. On failure,
   * this is best-effort and can omit changes when reconciliation fails; no edits are rolled back. */
  changedFiles: string[]
  /** Normalized failure for 'failed'; null for other statuses. */
  error: ReviewFailure | null
}
/** One angle's validated findings or normalized failure. A failed angle is missing coverage,
 * not an assertion that the module has no findings. */
export type AngleReview = { angle: ReviewAngle } & (
  | { status: 'completed'; findings: Finding[] }
  | { status: 'failed'; error: ReviewFailure }
)

/** Module assignment and angle outcomes in the selected angle order, including failed angle slots. */
export interface ModuleReview {
  module: ReviewModule
  angles: AngleReview[]
}

/** A module's original review, incremental fix, and final verification.
 * Fixes start as modules finish reviewing. Verification runs after all fixes settle. */
export interface ModuleOutcome {
  review: ModuleReview
  /** Null when no fix was requested or the lifecycle task returned no outcome. */
  fix: FixReport | null
  /** Review of the final tree, including dependency changes from other modules.
   * Null unless at least one module's fix was applied. */
  verification: ModuleReview | null
}

/** Returned after review, requested fixes and any final verification settle. Module order follows
 * the selected plan; callers inspect status and failures before treating findingCount as complete. */
export interface ReviewReport {
  /** Durable workflow identity; records are retained beneath workflowDirectory/runId. */
  runId: string
  /** Absolute workflow storage root, which can be outside the source directory. */
  workflowDirectory: string
  /** Canonical absolute directory reviewed by the agents. */
  cwd: string
  /** 'completed' only when every module's review/verification angles completed
   * and its fix (if requested) did not fail; engine-level interruption also
   * downgrades to 'incomplete'. Completed reports can still contain findings or skipped fixes. */
  status: 'completed' | 'incomplete'
  /** Full validated analysis plan, including modules omitted by selection or limits. */
  plan: ModulePlan
  /** Reviewed module IDs in plan order and selected angle IDs in caller/default order. */
  scope: { moduleIds: string[]; angleIds: string[] }
  modules: ModuleOutcome[]
  /** Errors thrown by onProgress. Observers do not change execution outcomes. */
  progressErrors: ReviewFailure[]
  /** Findings from completed angles in final verification when any fix was applied, otherwise
   * from the original reviews. Failed angles contribute zero; inspect status before treating this
   * count as complete. The CLI uses it for exit code 0/1 only when status is 'completed'. */
  findingCount: number
}
