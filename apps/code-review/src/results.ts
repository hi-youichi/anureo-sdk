// Shared review and fix outcomes consumed by execution, prompts and report presentation.
import type { ReviewAngle } from './angles'
import type { ReviewFailure } from './errors'
import type { Finding, ModulePlan, ReviewModule } from './schema'

/** Check whether a fix wrote validated changes to the original work tree and inspect any failure. */
export interface FixReport {
  /** 'not-needed' means no findings in a complete review. 'skipped' covers incomplete reviews,
   * a prior fix failure or no observed edits. 'applied' means validated edits reached the original
   * work tree and cleanup finished. Check verification for remaining findings. */
  status: 'not-needed' | 'skipped' | 'applied' | 'failed'
  /** Agent summary when reconciliation produced an outcome, or a host explanation. */
  summary: string
  /** Sorted paths relative to the review directory, applied to the original work tree.
   * These can be present if failure occurred after integration, such as during cleanup. */
  changedFiles: string[]
  /** Normalized failure for 'failed'; null for other statuses. */
  error: ReviewFailure | null
}
/** Inspect an angle's validated findings or the failure that left its coverage incomplete. */
export type AngleReview = { angle: ReviewAngle } & (
  | { status: 'completed'; findings: Finding[] }
  | { status: 'failed'; error: ReviewFailure }
)

/** Read one module's assignment and outcomes in selected angle order, including failed slots. */
export interface ModuleReview {
  module: ReviewModule
  angles: AngleReview[]
}

/** Compare a module's original review, queued fix, and verification of the final work tree. */
export interface ModuleOutcome {
  review: ModuleReview
  /** Null when no fix was requested or the lifecycle task returned no outcome. */
  fix: FixReport | null
  /** Review after all queued fixes settle, including the effects of edits from other modules.
   * Null if no fix outcome recorded changed files. A fix that fails after integration can
   * still trigger verification. */
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
  /** 'incomplete' when any recorded angle or fix failed, or the workflow reports incomplete
   * execution. A 'completed' report can still contain findings or skipped fixes. */
  status: 'completed' | 'incomplete'
  /** Full validated analysis plan, including modules omitted by selection or limits. */
  plan: ModulePlan
  /** Reviewed module IDs in plan order and selected angle IDs in caller/default order. */
  scope: { moduleIds: string[]; angleIds: string[] }
  modules: ModuleOutcome[]
  /** Synchronous exceptions from onProgress, in delivery order. These diagnostics do not affect status. */
  progressErrors: ReviewFailure[]
  /** Sum of findings from completed angles, using each module's verification when present and its
   * original review otherwise. Failed angles contribute zero. The CLI uses this count to choose
   * exit code 0 or 1 for a completed report. */
  findingCount: number
}
