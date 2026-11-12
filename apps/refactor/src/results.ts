// Defines host-observed refactor results; it must not execute work, persist reports or render output.
import type { ModulePlan, RefactorModule, Work } from './schema'

/** Host-recorded result of one shell validation command, consumed by reports and formatters.
 * These result types describe observations only; constructing them performs no validation or I/O. */
export interface CheckResult {
  command: string
  status: 'passed' | 'failed'
  /** Trailing combined process output, bounded to 4,000 characters including any failure message. */
  output: string
}
/** Error signals retained for callers deciding whether inspection is needed before another run. */
export interface Failure {
  /** SDK error code when supplied; ordinary errors retain null. */
  code: string | null
  /** The backend cannot confirm whether execution completed. */
  outcomeUnknown: boolean
  /** A resource-release error was reported, independently of execution outcome. */
  cleanupFailed: boolean
}
/** Agent-authored work plus host observations from one design or module session.
 * Orchestration fills this record before checkpoint publication; partial edits survive failures. */
export interface StepResult extends Work {
  /** Based on real file changes and execution/check failures, rather than the agent's claims. */
  status: 'applied' | 'unchanged' | 'failed'
  /** Sorted Git-visible paths changed during the step, including partial edits on failure. */
  changedFiles: string[]
  /** Executed checks in command order; a failure stops subsequent checks. */
  checks: CheckResult[]
  /** Display text for the caught step error, or null when no error was caught. */
  error: string | null
  /** Classification of the caught step error, or null for successful steps. */
  failure: Failure | null
}
/** Planned module paired with its editing outcome, appended by orchestration before dispatch. */
export interface ModuleResult {
  module: RefactorModule
  /** Null until a step returns, including when export or dispatch fails first. */
  step: StepResult | null
}
/** Mutable host run record populated under the writer lock, published at checkpoints and finalized.
 * Library callers receive it only after final publication and lock cleanup succeed; live observers
 * receive event strings instead. Creating a record alone does not acquire storage or resources. */
export interface RefactorReport {
  /** UUID allocated after writer-lock acquisition, also used as the run directory name. */
  runId: string
  /** Canonical target directory, which may be a subdirectory of a Git repository. */
  cwd: string
  /** Absolute storage directory for this run's reports, graphs and baseline. */
  directory: string
  /** Completed means every phase returned successfully; deferred work may still be listed. */
  status: 'completed' | 'incomplete'
  /** Agents were asked to avoid edits; the host does not enforce read-only permissions for editing steps. */
  reviewOnly: boolean
  /** Cross-module design step, run before modules are planned. */
  design: StepResult | null
  /** Validated module assignments, or null until planning succeeds. */
  plan: ModulePlan | null
  /** Modules reached in plan order; later modules are absent after an earlier failure. */
  modules: ModuleResult[]
  /** Run-level errors; individual step errors also appear on their StepResult. */
  errors: string[]
  /** Classification of the run-level error, independently of any failed step's classification. */
  failure: Failure | null
  /** Synchronous observer callback errors retained in delivery order without interrupting work. */
  progressErrors: string[]
}
