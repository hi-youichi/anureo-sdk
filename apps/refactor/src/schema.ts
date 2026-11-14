// Defines structured agent responses and inferred types; it must not validate inventory coverage or dispatch agents.
import { z } from 'zod'

/** Internal planning shape passed by plan in refactor.ts to the workflow agent for response validation.
 * All strings, the module list and each file list must be nonempty; whitespace is not trimmed.
 * Parsing rejects unknown keys at either object level without I/O. validatePlan must then check
 * ID safety and exact inventory coverage before module dispatch. */
export const modulePlanSchema = z.strictObject({
  summary: z.string().min(1),
  modules: z.array(z.strictObject({
    /** Artifact filename component; syntax and uniqueness are checked separately by validatePlan. */
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    /** Exact host inventory paths; validatePlan checks membership and exclusive assignment. */
    files: z.array(z.string().min(1)).min(1),
  })).min(1),
})

/** Internal work shape passed by runStep to the workflow agent for design/module response validation.
 * Strings must be nonempty without trimming; empty change and deferral lists are valid. Parsing rejects
 * unknown keys at either object level without I/O. runStep records observed edits, status and checks
 * separately so agent claims cannot replace execution facts. */
export const workSchema = z.strictObject({
  summary: z.string().min(1),
  /** Agent-reported edits or proposals, which need not correspond to observed file changes. */
  changes: z.array(z.string().min(1)),
  /** Unresolved findings with reasons; these do not by themselves make the host step fail. */
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
