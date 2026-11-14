// Publishes the supported library surface; it must not implement phases or serve internal imports.
/** Run design and planning before dispatching concurrent module agents in separate Git worktrees.
 * Integrate their patches in plan order and validate against the target. Resolve a completed or
 * incomplete report after publishing results and releasing the writer lock. The caller owns the
 * client. See refactorCode for rejection conditions. */
export { refactorCode } from './refactor'
/** Caller-owned client and run settings; constructing options does not start or validate a run. */
export type { RefactorOptions } from './options'
export type { CheckCommand } from './checks'
/** Host observations returned to callers, including partial edits and ordered validation outcomes. */
export type { RefactorReport, GraphCoverage, ModuleResult, StepResult, CheckResult, Failure } from './results'
/** Agent response shapes; work summaries, changes and deferrals are agent claims, distinct from
 * host-observed step results. Types alone do not validate external output or module assignments. */
export type { ModulePlan, RefactorModule, Work } from './schema'
/** Render a supplied report as text without I/O or mutation; no expected errors for valid reports. */
export { formatReport } from './report'
/** Export a validated repository graph for embedders; spawns repograph and awaits temporary-file
 * cleanup while retaining its external index for reuse. Export/validation/cleanup failures reject;
 * callers must serialize shared index access. */
export { loadGraph } from './graph'
/** Validated graph shape and injectable exporter contract; importing types starts no resources. */
export type { RepositoryGraph, GraphLoader } from './graph'
