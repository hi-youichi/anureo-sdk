// Defines structured agent responses and inferred types; it must not validate inventory coverage or dispatch agents.
import { z } from 'zod'

/** Planning response shape supplied to the workflow agent; parsing rejects empty fields and unknown keys.
 * Parsing has no I/O effects; validatePlan must check ID safety and exact inventory coverage before dispatch. */
export const modulePlanSchema = z.strictObject({
  summary: z.string().min(1),
  modules: z.array(z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
  })).min(1),
})

/** Design/module response shape supplied to workflow agents; parsing rejects empty entries and unknown keys.
 * Parsing has no I/O effects. The host adds observed edits and check results separately so agent claims
 * cannot replace execution facts; empty change and deferral lists are valid. */
export const workSchema = z.strictObject({
  summary: z.string().min(1),
  changes: z.array(z.string().min(1)),
  deferred: z.array(z.strictObject({ title: z.string().min(1), reason: z.string().min(1) })),
})

/** Planning response consumed by orchestration; this structural type alone does not guarantee schema
 * parsing or inventory validation, both of which must precede module dispatch. */
export type ModulePlan = z.infer<typeof modulePlanSchema>
/** One module passed from planning to prompt construction; the host validates exclusive file assignments
 * and safe IDs before using it to dispatch editing or name graph artifacts. */
export type RefactorModule = ModulePlan['modules'][number]
/** Agent-authored account consumed by step reporting; changes and deferrals are claims, while execution
 * status, observed file edits and validation outcomes remain separate host-owned fields. */
export type Work = z.infer<typeof workSchema>
