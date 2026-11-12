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

export const findingSchema = z.strictObject({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().min(1),
  file: z.string().min(1),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
})

export const reviewOutputSchema = z.strictObject({ findings: z.array(findingSchema) })

export const fixProposalSchema = z.strictObject({
  summary: z.string().min(1),
  edits: z.array(z.strictObject({
    file: z.string().min(1),
    before: z.string().min(1),
    after: z.string(),
  })),
})

export const appliedFixSchema = z.strictObject({ changedFiles: z.array(z.string().min(1)) })

export type ReviewModule = z.infer<typeof moduleSchema>
export type ModulePlan = z.infer<typeof modulePlanSchema>
export type Finding = z.infer<typeof findingSchema>
export type FixProposal = z.infer<typeof fixProposalSchema>
