// Library entry point for running refactors, presenting reports and supplying repository graphs.
export { refactorCode } from './refactor'
export type { RefactorOptions } from './options'
export type { CheckCommand } from './checks'
/** Host observations returned to callers, including partial edits and ordered validation outcomes. */
export type { RefactorReport, GraphCoverage, ModuleResult, StepResult, CheckResult, Failure } from './results'
/** Agent response shapes; work summaries, changes and deferrals are agent claims, distinct from
 * host-observed step results. Types alone do not validate external output or module assignments. */
export type { ModulePlan, RefactorModule, Work } from './schema'
export { formatReport } from './report'
export { loadGraph } from './graph'
export type { RepositoryGraph, GraphLoader } from './graph'
