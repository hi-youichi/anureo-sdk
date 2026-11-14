import { z } from 'zod'

/** Read a source assignment from ReviewReport.plan or a module outcome. In returned reports,
 * files are canonical, slash-separated paths relative to the review directory, with one owner
 * per plan. The exact id identifies the module for selection, progress events and reports. */
export type ReviewModule = z.infer<typeof moduleSchema>

/** Read the full validated analysis plan, including assignments omitted by review selection.
 * Every listed file has one owner. The plan may omit reviewable source files. */
export type ModulePlan = z.infer<typeof modulePlanSchema>

/** Read an issue from a completed angle. The canonical file path is relative to the review
 * directory, and the 1-based inclusive range was checked against source at validation time.
 * The body and suggested remedy are agent assessments. */
export type Finding = z.infer<typeof findingSchema>

/** Internal structured response from the fix agent. applyFix takes the summary from the
 * response and determines the report's changed files through Git reconciliation. */
export type FixResult = z.infer<typeof fixResultSchema>

/** Internal structural schema for one analysis assignment; validatePlan checks source scope,
 * canonical ownership and ID limits after structured output parsing. Unknown fields are rejected. */
export const moduleSchema = z.strictObject({
  /** Exact selection identity; validatePlan rejects duplicates and IDs over 256 UTF-8 bytes. */
  id: z.string().min(1),
  name: z.string().min(1),
  /** Module responsibilities passed to the angle agent with the source assignment. */
  description: z.string().min(1),
  /** Nonempty source list relative to the review directory; aliases are normalized by validatePlan. */
  files: z.array(z.string().min(1)).min(1),
})

/** Internal structured output contract submitted by analyzeModules; requires a nonempty plan
 * and rejects unknown fields. Filesystem validity and ownership are checked by validatePlan. */
export const modulePlanSchema = z.strictObject({
  /** Analysis overview retained in the plan and printed by formatReport. */
  summary: z.string().min(1),
  modules: z.array(moduleSchema).min(1),
})

/** Severity values accepted for Finding.severity.
 * The findings schema and review prompt both derive their vocabulary from this list. */
export const findingSeverities = ['P0', 'P1', 'P2', 'P3'] as const

/** Internal finding shape used by reviewOutputSchema. Rejects unknown fields; validateFindings
 * separately checks canonical module ownership and inclusive ranges against current source text. */
export const findingSchema = z.strictObject({
  severity: z.enum(findingSeverities),
  title: z.string().min(1),
  body: z.string().min(1),
  /** Actionable remedy text, retained for reporting and the optional fix task. */
  suggestion: z.string().min(1),
  /** Source path relative to the directory reviewed by the agent. */
  file: z.string().min(1),
  /** First source line, 1-based and inclusive. */
  lineStart: z.number().int().min(1),
  /** Last source line, inclusive; ordering and file bounds require validateFindings. */
  lineEnd: z.number().int().min(1),
})

/** Internal output schema supplied by reviewAngle for review and verification agents.
 * An empty findings array is valid. validateFindings checks source locations after parsing. */
export const reviewOutputSchema = z.strictObject({ findings: z.array(findingSchema) })

/** Internal output schema supplied by applyFix for the agent's result after editing sources.
 * applyFix checks Git state and observed edits before applying a patch to the original tree. */
export const fixResultSchema = z.strictObject({
  summary: z.string().min(1),
  /** Agent-reported paths. The field is required and may be empty. */
  changedFiles: z.array(z.string().min(1)),
})
