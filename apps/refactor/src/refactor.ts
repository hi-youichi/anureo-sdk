// Sequences design, planning, concurrent module work and integration under the run lock.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agent } from '@anureo/workflow'
import { inAgentWorktree, runAgentWork } from './agent-work'
import { defaultChecks, validateChecks, type CheckCommand } from './checks'
import { repositoryDirectory } from './git'
import { captureTree, changes, treeVersion } from './git-tree'
import { exportGraph, type GraphArtifactContext } from './graph-artifacts'
import { validateConcurrency, validateGraphOptions, type RefactorOptions } from './options'
import { validatePlan } from './plan-validation'
import { designPrompt, modulePrompt, planPrompt } from './prompts'
import { saveReport } from './report-store'
import type { ModuleResult, RefactorReport, StepResult } from './results'
import { withRun } from './run-lifecycle'
import { modulePlanSchema, type ModulePlan } from './schema'
import { inventory } from './source-inventory'
import { withWorktreeBaseline, type WorktreeBaseline } from './worktree'

/** Run configuration, including the client the caller keeps and disposes. */
export type { RefactorOptions } from './options'
/** Overall run report and the step, validation and failure records it contains. */
export type { RefactorReport, ModuleResult, StepResult, CheckResult, Failure } from './results'

/** Refactor a Git target in detached worktrees. The host serializes checks of prospective
 * changes and transfers into the target as worktrees become ready. Review-only runs skip both.
 *
 * Returns a completed or incomplete report after final publication and writer-lock release. Design and planning failures
 * stop advancement. Unknown outcomes or cleanup failures stop new module sessions. Active sessions settle.
 * Invalid input, repository preflight,
 * lock acquisition, report initialization, final publication and lock cleanup failures reject.
 * Keep the supplied client usable until settlement and dispose it separately. */
export async function refactorCode(input: RefactorOptions): Promise<RefactorReport> {
  validateConcurrency(input.concurrency)
  validateChecks(input.checks)
  validateGraphOptions(input.noGraph, Boolean(input.repographEntry || input.graphLoader))
  const cwd = await repositoryDirectory(input.cwd)
  const options = { ...input, cwd }
  return withRun(options, async (report, progress) => {
    const checks = input.reviewOnly ? [] : input.checks ?? await defaultChecks(cwd)
    const context = { options, report, checks, progress }
    const design = await runDesign(context)
    await withWorktreeBaseline(cwd, async baseline => {
      const modules = await prepareModules(context, baseline, design)
      await runModules(context, baseline, modules)
    })
  })
}

/** Context shared by phases while withRun holds the writer lock.
 * Phases publish into the same report; checks are selected once before the initial inventory. */
interface RunContext extends GraphArtifactContext {
  options: RefactorOptions
  report: RefactorReport
  checks: readonly CheckCommand[]
}

/** Successful design output needed by planning; the graph describes the pre-design tree. */
interface DesignResult {
  design: StepResult
  graphFile: string | null
}

/** Validated assignments and prompt context for the shared module baseline. */
interface ModuleExecution {
  plan: ModulePlan
  /** Reuses the design graph when no design edits were observed. */
  graphFile: string | null
  /** The design agent's summary passed to each module. */
  design: string
  /** Fingerprint of the tree inventoried for planning. */
  version: string
}

/** Establish the baseline, run design and checkpoint its outcome before allowing planning.
 * refactorCode passes the result to prepareModules. Baseline, graph and report artifacts are
 * written under the writer lock. A failed step is published before rejection, and any applied
 * edits remain in the target. Inventory, export, baseline and publication errors also reject. */
async function runDesign(context: RunContext): Promise<DesignResult> {
  const { options, report, checks, progress } = context
  const initial = await inventory(options)
  await writeFile(join(report.directory, 'baseline.json'), JSON.stringify(Object.fromEntries(initial.tree), null, 2))
  progress('graph: started')
  const graphFile = await exportGraph(context, 'design', initial.files)
  progress('design: started')
  const design = await withWorktreeBaseline(options.cwd, baseline =>
    runAgentWork({
      baseline, options, checks, assignedFiles: initial.files, publish: operation => operation(),
      prompt: designPrompt({
        files: initial.files, graphFile, version: treeVersion(initial.tree), checks,
        mode: options.reviewOnly ? 'read-only' : 'edit',
      }),
    }),
  )
  if (!design) throw new Error('Cross-module design did not start')
  report.design = design
  await checkpointStep(context, 'design', design)
  if (design.status === 'failed') throw new Error(`Cross-module design failed: ${design.error}`)
  return { design, graphFile }
}

/** Reinventory after successful design, validate the plan and prepare its baseline graph.
 * refactorCode awaits this checkpoint before starting modules. Records the plan before refreshing
 * the graph, so a refresh failure can still leave the plan in the final incomplete report.
 * Inventory, planning, graph export and publication failures reject. */
async function prepareModules(context: RunContext, baseline: WorktreeBaseline, input: DesignResult): Promise<ModuleExecution> {
  const current = await inventory(context.options)
  const version = treeVersion(current.tree)
  const modulePlan = await plan(context.options, baseline, current.files, version)
  context.report.plan = modulePlan
  const graphFile = input.design.changedFiles.length ? await exportGraph(context, 'modules', current.files) : input.graphFile
  await saveReport(context.report)
  return { plan: modulePlan, graphFile, design: input.design.summary, version }
}

/** Publish verified worktrees in readiness order. Reports retain plan order for lookup. */
async function runModules(context: RunContext, baseline: WorktreeBaseline, input: ModuleExecution): Promise<void> {
  const { options, report, checks, progress } = context
  const results: ModuleResult[] = input.plan.modules.map(module => ({ module, step: null }))
  report.modules = results
  const dispatch = { stopped: false }
  let writer = Promise.resolve()
  const publish = (operation: () => Promise<void>) => {
    const result = writer.then(operation)
    writer = result.catch(() => {})
    return result
  }

  await runModuleWorkers(results, options.concurrency ?? results.length, () => !dispatch.stopped, async result => {
    const { module } = result
    progress(`module/${module.id}: started`)
    const step = await runAgentWork({
      baseline, options, checks, publish, dispatch, assignedFiles: module.files,
      prompt: modulePrompt({
        module, graphFile: input.graphFile, version: input.version, checks,
        mode: options.reviewOnly ? 'read-only' : 'edit', design: input.design,
      }),
    })
    if (!step) return
    progress(`module/${module.id}: finished`)
    await publish(async () => {
      result.step = step
      await checkpointStep(context, `module/${module.id}`, step)
    })
  })

  const failed = results.find(result => result.step?.status === 'failed')
  if (failed) throw new Error(`Module ${failed.module.id} failed: ${failed.step?.error}`)
}

/** Emit the status of a step already in the report, then save the report. runDesign and
 * runModules await publication before enforcing their failure gates. A save failure rejects first. */
async function checkpointStep(context: RunContext, label: string, step: StepResult): Promise<void> {
  context.progress(`${label}: ${step.status}`)
  await saveReport(context.report)
}

/** Partition the post-design inventory without edits, then verify coverage after checkout removal. */
async function plan(options: RefactorOptions, baseline: WorktreeBaseline, files: string[], version: string): Promise<ModulePlan> {
  const result = await inAgentWorktree(baseline, async ({ cwd, root }) => {
    const before = await captureTree(root)
    const planned = await agent(planPrompt(files, version), {
      client: options.client, cwd, model: options.model, permissionMode: options.readPermissionMode,
      schema: modulePlanSchema, outputFallback: 'json-text',
    })
    if (changes(before, await captureTree(root)).length) throw new Error('Module planner modified files')
    if (!planned) throw new Error('Module planning returned no result')
    return planned
  })
  validatePlan(result, files)
  return result
}

/** Claim available slots while dispatch is open, with at most limit callbacks active. runModules
 * supplies a callback that records the step and emits progress. Drain active workers before propagating the earliest
 * callback rejection in plan order, so baseline cleanup cannot race a running worker. */
async function runModuleWorkers(results: ModuleResult[], limit: number, mayDispatch: () => boolean, run: (result: ModuleResult) => Promise<void>): Promise<void> {
  let next = 0
  let rejection: { index: number; cause: unknown } | undefined
  const workers = Array.from({ length: Math.min(limit, results.length) }, async () => {
    while (next < results.length && mayDispatch()) {
      const index = next++
      try { await run(results[index]!) }
      catch (cause) {
        if (!rejection || index < rejection.index) rejection = { index, cause }
      }
    }
  })
  await Promise.all(workers)
  if (rejection) throw rejection.cause
}
