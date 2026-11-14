/**
 * Refactor code with agents in isolated Git worktrees. The host validates edits before merging.
 * The CLI requires Bun, Git and a configured harness. With Codex on PATH, run
 * `anureo-refactor . --review-only` to inspect proposals without applying edits.
 *
 * Library callers supply and dispose an initialized client. Reports are saved under
 * `<target>/.anureo/refactor/<run-id>/report.json`. A phase failure can return an incomplete
 * report with edits already merged. Invalid input, run setup, final publication and lock
 * cleanup failures reject the call.
 *
 * ```ts
 * import { createCodexAdapter } from '@anureo/adapter-codex'
 * import { createClient } from '@anureo/sdk'
 * import { refactorCode } from '@anureo/refactor'
 *
 * const cwd = process.cwd()
 * const client = await createClient({
 *   adapter: createCodexAdapter({ command: 'codex', cwd }),
 *   identity: { adapterId: 'codex', runtimeConfigId: 'refactor-example' },
 * })
 * try {
 *   const report = await refactorCode({ client, cwd, reviewOnly: true })
 *   console.log(report.status, report.directory)
 *   if (report.status === 'incomplete') process.exitCode = 2
 * } finally {
 *   await client.dispose()
 * }
 * ```
 */
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
