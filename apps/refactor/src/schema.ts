import { z } from 'zod'

/**
 * Describe the required planning response for the workflow agent called by plan in refactor.ts.
 * All strings, the module list and each file list must be nonempty. Parsing preserves whitespace
 * and rejects unknown fields in the response and its modules. plan passes the parsed response
 * to validatePlan for ID safety and exact inventory coverage before prepareModules can publish it.
 */
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

/**
 * Describe the required design and module responses for the workflow agent called by runAgentWork.
 * Parsing preserves whitespace in nonempty strings, accepts empty change and deferral lists, and
 * rejects unknown fields in the response and its deferrals. runAgentWork copies valid responses
 * into its step result and records a failed step when agent validation rejects.
 */
export const workSchema = z.strictObject({
  summary: z.string().min(1),
  /** Agent-reported edits or proposals, which need not correspond to observed file changes. */
  changes: z.array(z.string().min(1)),
  /** Unresolved findings with reasons; these do not by themselves make the host step fail. */
  deferred: z.array(z.strictObject({ title: z.string().min(1), reason: z.string().min(1) })),
})

/** Read the planner's summary and validated assignments from RefactorReport.plan.
 * Modules appear in the order the planner supplied and the host uses that order for integration.
 * Constructing this type performs no validation. */
export type ModulePlan = z.infer<typeof modulePlanSchema>

/** Read a planned module from the report's plan or a ModuleResult. Its ID identifies the module in
 * progress events and reports. Its file list describes the original assignment. Use
 * StepResult.changedFiles for the paths the host observed the agent change. */
export type RefactorModule = ModulePlan['modules'][number]

/** Read an agent's summary, reported changes or proposals, and deferred findings on a StepResult.
 * Use the step's status, changed files and check results for host-observed outcomes.
 * Empty change and deferral lists are valid. */
export type Work = z.infer<typeof workSchema>
