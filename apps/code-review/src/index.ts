/**
 * Run a modular code review with an initialized SDK client. Inspect the report status for incomplete
 * coverage, and release the client when finished. To render the report yourself, use formatReport.
 * The anureo-review executable calls the same review operation and manages its own client.
 *
 * With a configured Codex CLI on PATH:
 * ```ts
 * import { createCodexAdapter } from '@anureo/adapter-codex'
 * import { createClient } from '@anureo/sdk'
 * import { formatReport, reviewCode } from '@anureo/code-review'
 *
 * const cwd = process.cwd()
 * const client = await createClient({
 *   adapter: createCodexAdapter({ command: 'codex', cwd }),
 *   identity: { adapterId: 'codex', runtimeConfigId: 'review-example' },
 * })
 * try {
 *   const report = await reviewCode({ client, cwd })
 *   process.stdout.write(formatReport(report))
 *   if (report.status === 'incomplete') process.exitCode = 2
 * } finally {
 *   await client.dispose()
 * }
 * ```
 */
export { reviewCode } from './review'
export type { ReviewOptions } from './options'
export type { ReviewReport, ModuleOutcome, ModuleReview, AngleReview, FixReport } from './results'
export type { ReviewFailure } from './errors'
export type { ReviewProgress } from './progress'
export { correctnessAngle, codeQualityAngle, designAngle, defaultAngles } from './angles'
export type { ReviewAngle } from './angles'
export { findingSeverities } from './schema'
export type { Finding, ModulePlan, ReviewModule } from './schema'
export { OPERATIONAL_PATH_SEGMENTS, DEFAULT_WORKFLOW_DIRECTORY } from './paths'
export { formatReport } from './report'
