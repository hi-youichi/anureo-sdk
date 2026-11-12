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
  file: z.string().min(1),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
})

export const reviewOutputSchema = z.strictObject({ findings: z.array(findingSchema) })

export type ReviewModule = z.infer<typeof moduleSchema>
export type ModulePlan = z.infer<typeof modulePlanSchema>
export type Finding = z.infer<typeof findingSchema>
