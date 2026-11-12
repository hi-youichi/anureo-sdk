import { z } from 'zod'

export const modulePlanSchema = z.strictObject({
  summary: z.string().min(1),
  modules: z.array(z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
  })).min(1),
})

/** Result of one agent step (cross-module design or one module): it reviews and edits in one pass. */
export const workSchema = z.strictObject({
  summary: z.string().min(1),
  changes: z.array(z.string().min(1)),
  deferred: z.array(z.strictObject({ title: z.string().min(1), reason: z.string().min(1) })),
})

export type ModulePlan = z.infer<typeof modulePlanSchema>
export type RefactorModule = ModulePlan['modules'][number]
export type Work = z.infer<typeof workSchema>
