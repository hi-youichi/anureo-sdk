import type { ModulePlan, RefactorModule, Work } from './schema'

/** Result recorded when the host runs a validation command in a worktree before integration. */
export interface CheckResult {
  command: string
  status: 'passed' | 'failed'
  /** Last 4,000 characters of stdout followed by stderr, with the error message appended on failure. */
  output: string
}
/** Error signals to consult before retrying a failed step or run. */
export interface Failure {
  /** String code on the caught object, or null when absent or not a string. */
  code: string | null
  /** The error explicitly reports that the execution outcome is unknown. */
  outcomeUnknown: boolean
  /** A resource-release error was reported, independently of execution outcome. */
  cleanupFailed: boolean
}
/** Outcome of a design or module step, including host observations from integration and validation.
 * The inherited summary, changes and deferred fields are the agent's account of the work. */
export interface StepResult extends Work {
  /** Unchanged for an empty edit, applied after integration, or failed on an error. A cleanup
   * failure can be reported after a verified merge. */
  status: 'applied' | 'unchanged' | 'failed'
  /** Sorted Git-visible paths changed by the isolated agent within the target directory. */
  changedFiles: string[]
  /** Legacy report field containing the path to a historical patch artifact. */
  patch?: string
  /** Executed checks in command order; a failure stops subsequent checks. */
  checks: CheckResult[]
  /** Display text for the caught step error, or null when no error was caught. */
  error: string | null
  /** Classification of the first caught step error, with later cleanup failures merged in. */
  failure: Failure | null
}
/** Planned module and its step record, paired in plan order before any module starts. */
export interface ModuleResult {
  module: RefactorModule
  /** Null until the worktree has finished validation, integration and cleanup. */
  step: StepResult | null
}
/** Graph availability and declaration coverage for one phase's source inventory. */
export interface GraphCoverage {
  phase: string
  status: 'available' | 'unavailable' | 'disabled'
  /** Paths with no indexed declarations, or the entire source inventory when no graph was available.
   * Indexed files can still have unresolved relationships. */
  filesWithoutSymbols: string[]
  /** Export error text when graph data is unavailable. */
  error?: string
}
/** Outcome returned by refactorCode after final publication and writer-lock release. During the
 * run, report.json is updated at checkpoints and onProgress receives event strings. An incomplete
 * report can include edits already applied to the target. The caller still owns the SDK client. */
export interface RefactorReport {
  /** UUID allocated after writer-lock acquisition, also used as the run directory name. */
  runId: string
  /** Canonical target directory, which may be a subdirectory of a Git repository. */
  cwd: string
  /** Absolute storage directory for this run's reports, graphs and baseline. */
  directory: string
  /** Completed means every phase returned successfully; deferred work may still be listed. */
  status: 'completed' | 'incomplete'
  /** Agents were asked to avoid edits and host validation commands were disabled. */
  reviewOnly: boolean
  /** Cross-module design step, run before modules are planned. */
  design: StepResult | null
  /** Validated module assignments, or null until planning succeeds. */
  plan: ModulePlan | null
  /** Module records in plan order. Successful edits merge in readiness order. */
  modules: ModuleResult[]
  /** Graph availability and file coverage for the exports attempted during the run. */
  graphCoverage: GraphCoverage[]
  /** Run-level diagnostics. Consult each failed StepResult for its own error. */
  errors: string[]
  /** Classification of the run-level error, or null when none was caught. A failed-step gate
   * throws a new error, so inspect the failed step for its original signals. */
  failure: Failure | null
  /** Display text for synchronous observer exceptions that were successfully converted, in delivery order. */
  progressErrors: string[]
}
