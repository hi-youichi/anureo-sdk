import { z } from 'zod'

/** Internal structural schema for one analysis assignment; validatePlan checks source scope,
 * canonical ownership and ID limits after structured output parsing. Unknown fields are rejected. */
export const moduleSchema = z.strictObject({
  /** Exact selection identity; validatePlan rejects duplicates and IDs over 256 UTF-8 bytes. */
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Nonempty source list relative to the review directory; aliases are normalized by validatePlan. */
  files: z.array(z.string().min(1)).min(1),
})

/** Internal structured output contract submitted by analyzeModules; requires a nonempty plan
 * and rejects unknown fields. Filesystem validity and ownership are checked by validatePlan. */
export const modulePlanSchema = z.strictObject({
  summary: z.string().min(1),
  modules: z.array(moduleSchema).min(1),
})

/** Authoritative severity vocabulary; review prompts derive their severity
 * wording from this list — update them together. */
export const findingSeverities = ['P0', 'P1', 'P2', 'P3'] as const

/** Internal finding shape used by reviewOutputSchema. Rejects unknown fields; validateFindings
 * separately checks canonical module ownership and inclusive ranges against current source text. */
export const findingSchema = z.strictObject({
  severity: z.enum(findingSeverities),
  title: z.string().min(1),
  body: z.string().min(1),
  /** Actionable remedy text, retained for reporting and the optional fix task. */
  suggestion: z.string().min(1),
  /** Source path relative to the review directory, not to the module or repository root. */
  file: z.string().min(1),
  /** First source line, 1-based and inclusive. */
  lineStart: z.number().int().min(1),
  /** Last source line, inclusive; ordering and file bounds require validateFindings. */
  lineEnd: z.number().int().min(1),
})

/** Internal output schema supplied by reviewAngle for review and verification agents.
 * An empty findings array is valid; accepting its shape does not validate source locations. */
export const reviewOutputSchema = z.strictObject({ findings: z.array(findingSchema) })

/** Internal output schema supplied by applyFix for the agent's result after editing sources.
 * The host uses the summary but replaces advisory changedFiles with Git-reconciled paths;
 * parsing this result neither proves scope compliance nor rolls back edits on failure. */
export const fixResultSchema = z.strictObject({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
})

/** Consume a source assignment from ReviewReport.plan or a module outcome. In returned reports,
 * files are canonical '/'-separated paths relative to the review directory, with one owner per plan;
 * id is the exact identity accepted by ReviewOptions.moduleIds. */
export type ReviewModule = z.infer<typeof moduleSchema>
/** Consume the full validated analysis plan, including assignments omitted by review selection.
 * A nonempty module list and unique listed-file ownership do not prove exhaustive source coverage. */
export type ModulePlan = z.infer<typeof modulePlanSchema>
/** Consume a validated issue from a completed angle. file is canonical and relative to the review
 * directory; lineStart/lineEnd are 1-based inclusive bounds checked against source at validation time.
 * body explains the issue and suggestion describes a remedy; validation does not prove their claims. */
export type Finding = z.infer<typeof findingSchema>
/** Internal agent assertion parsed by fixResultSchema, before host scope reconciliation. */
export type FixResult = z.infer<typeof fixResultSchema>
