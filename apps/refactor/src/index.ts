// Publishes the supported library surface; it must not implement phases or serve internal imports.
/** Run design, planning and serial module phases under the writer lock; may edit files and spawn
 * processes. Resolve a completed/incomplete report after final publication and lock cleanup;
 * preflight, lock, publication and cleanup failures reject. Partial edits remain on failure,
 * and the caller retains client ownership. */
export { refactorCode } from './refactor'
/** Caller-owned client and run settings; constructing options does not start or validate a run. */
export type { RefactorOptions } from './options'
/** Host observations returned to callers, including partial edits and ordered validation outcomes. */
export type { RefactorReport, ModuleResult, StepResult, CheckResult, Failure } from './results'
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
