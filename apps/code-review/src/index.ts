/** Library entry point for running reviews with a caller-owned client and consuming their reports.
 * The anureo-review executable owns its client and delegates to the same reviewCode operation. */
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
