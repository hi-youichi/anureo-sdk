import { z } from 'zod'

export const moduleSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
})

export const modulePlanSchema = z.strictObject({
  summary: z.string().min(1),
  modules: z.array(moduleSchema).min(1),
})

/** Authoritative severity vocabulary; review prompts derive their severity
 * wording from this list — update them together. */
export const findingSeverities = ['P0', 'P1', 'P2', 'P3'] as const

export const findingSchema = z.strictObject({
  severity: z.enum(findingSeverities),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().min(1),
  file: z.string().min(1),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
})

export const reviewOutputSchema = z.strictObject({ findings: z.array(findingSchema) })

/** Reported by the fix agent after editing sources directly; the host reconciles
 * changedFiles against git, so the agent's list is advisory only. */
export const fixResultSchema = z.strictObject({
  summary: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
})

export type ReviewModule = z.infer<typeof moduleSchema>
export type ModulePlan = z.infer<typeof modulePlanSchema>
export type Finding = z.infer<typeof findingSchema>
export type FixResult = z.infer<typeof fixResultSchema>
