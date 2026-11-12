// Sequences design, planning and serial module work; it must not own locking, command policy or result types.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agent } from '@anureo/workflow'
import { defaultChecks, runChecks, validateChecks } from './checks'
import { failure, message } from './errors'
import { captureTree, changes, repositoryDirectory, treeVersion } from './git-tree'
import { loadGraph } from './graph'
import type { RefactorOptions } from './options'
import { validatePlan } from './plan-validation'
import { designPrompt, modulePrompt, planPrompt } from './prompts'
import { saveReport } from './report-store'
import type { ModuleResult, RefactorReport, StepResult } from './results'
import { withRun } from './run-lifecycle'
import { modulePlanSchema, workSchema, type ModulePlan } from './schema'
import { isSource, validateSourcePath } from './source-policy'

/** Caller configuration re-exported here to preserve direct imports; ownership stays with the caller. */
export type { RefactorOptions } from './options'
/** Host-observed report types retained for direct consumers; importing them performs no work. */
export type { RefactorReport, ModuleResult, StepResult, CheckResult, Failure } from './results'

/** Capture a host baseline for design/planning and validate eligible paths before agent dispatch.
 * Reads Git and the filesystem; rejects empty inventories, unsafe source paths and snapshot errors. */
async function inventory(cwd: string): Promise<{ tree: Map<string, string>; files: string[] }> {
  const tree = await captureTree(cwd)
  const files = [...tree.keys()].filter(isSource)
  if (!files.length) throw new Error('No supported Git-visible source files found')
  for (const file of files) await validateSourcePath(cwd, file)
  return { tree, files }
}

/** Ask one read-only agent to partition the post-design inventory for module preparation.
 * Returns an exact-cover plan without writing files; uses the caller-owned client and rejects
 * absent output, invalid assignments, schema errors and agent failures. */
async function plan(options: RefactorOptions, files: string[], version: string): Promise<ModulePlan> {
  const result = await agent(planPrompt(files, version), {
    client: options.client, cwd: options.cwd, model: options.model, permissionMode: 'read-only', schema: modulePlanSchema,
  })
  if (!result) throw new Error('Module planning returned no result')
  validatePlan(result, files)
  return result
}

/** Run a design/module session with the caller-owned client and return its host-observed result.
 * The agent and shell checks may edit files; unchanged work never runs checks.
 * Agent/check failures become a failed step with partial edits retained; initial or recovery snapshot
 * errors still reject. Review-only is a prompt instruction and only suppresses host checks. */
async function runStep(options: RefactorOptions, prompt: string, checks: readonly string[]): Promise<StepResult> {
  const step: StepResult = { summary: '', changes: [], deferred: [], status: 'unchanged', changedFiles: [], checks: [], error: null, failure: null }
  const before = await captureTree(options.cwd)
  try {
    const work = await agent(prompt, { client: options.client, cwd: options.cwd, model: options.model, permissionMode: 'agent', schema: workSchema })
    if (!work) throw new Error('Agent returned no result')
    Object.assign(step, work)
    step.changedFiles = changes(before, await captureTree(options.cwd))
    if (step.changedFiles.length) {
      step.status = 'applied'
      if (!options.reviewOnly) await runChecks(options.cwd, checks, step.checks)
    }
  } catch (cause) {
    step.status = 'failed'
    step.error = message(cause)
    step.failure = failure(cause)
    step.changedFiles = changes(before, await captureTree(options.cwd))
  }
  return step
}

/** Context shared by serial phases only while withRun holds the writer lock.
 * Phases publish into the same report; checks are selected once before the initial inventory. */
interface RunContext {
  options: RefactorOptions
  report: RefactorReport
  checks: readonly string[]
  progress: (event: string) => void
}

/** Successful design output needed by planning; the graph describes the pre-design tree. */
interface DesignResult {
  design: StepResult
  graphFile: string
}

/** Prepared module work; graphFile is the post-design baseline, before any module edits. */
interface ModuleExecution {
  plan: ModulePlan
  graphFile: string
  design: string
}

/** Export the current graph for a locked phase and return its artifact path.
 * May start the graph subprocess and writes under the run directory; loader, serialization
 * and filesystem errors reject before the phase can dispatch an agent. */
async function exportGraph({ options, report }: RunContext, name: string): Promise<string> {
  const file = join(report.directory, name)
  const loader = options.graphLoader
  const graph = loader
    ? await loader(options.cwd)
    : await loadGraph(options.cwd, options.repographEntry)
  await writeFile(file, JSON.stringify(graph))
  return file
}

/** Publish an already-recorded step for design/module callers, then enforce the failure gate.
 * Reports progress before writing the checkpoint; publication errors reject before step errors.
 * Saving failed work before throwing preserves partial edits in the report seen by finalization. */
async function checkpointStep(context: RunContext, input: { step: StepResult; label: string; failureMessage: string }): Promise<void> {
  context.progress(`${input.label}: ${input.step.status}`)
  await saveReport(context.report)
  if (input.step.status === 'failed') throw new Error(`${input.failureMessage}: ${input.step.error}`)
}

/** Establish the baseline, run design and checkpoint its outcome before allowing planning.
 * Called under the run lock; writes baseline/graph/report artifacts and may edit/check files.
 * Inventory, export, snapshot, publication and failed-step errors reject without undoing edits. */
async function runDesign(context: RunContext): Promise<DesignResult> {
  const { options, report, checks, progress } = context
  const initial = await inventory(options.cwd)
  await writeFile(join(report.directory, 'baseline.json'), JSON.stringify(Object.fromEntries(initial.tree), null, 2))
  progress('graph: started')
  const graphFile = await exportGraph(context, 'graph-design.json')
  progress('design: started')
  const design = await runStep(options, designPrompt({
    files: initial.files, graphFile, version: treeVersion(initial.tree), checks,
    mode: options.reviewOnly ? 'read-only' : 'edit',
  }), checks)
  report.design = design
  await checkpointStep(context, { step: design, label: 'design', failureMessage: 'Cross-module design failed' })
  return { design, graphFile }
}

/** Reinventory after successful design, validate the plan and prepare its baseline graph.
 * Called before any module; records the plan before a needed graph refresh and report write.
 * Reads Git/files, starts a read-only agent and may export a graph; any failure rejects. */
async function prepareModules(context: RunContext, input: DesignResult): Promise<ModuleExecution> {
  const current = await inventory(context.options.cwd)
  const modulePlan = await plan(context.options, current.files, treeVersion(current.tree))
  context.report.plan = modulePlan
  const graphFile = input.design.changedFiles.length ? await exportGraph(context, 'graph-modules.json') : input.graphFile
  await saveReport(context.report)
  return { plan: modulePlan, graphFile, design: input.design.summary }
}

/** Execute prepared modules serially under the run lock, stopping after the first failed checkpoint.
 * Owns the previous-step edit flag: refresh immediately after edits, otherwise use the prepared
 * baseline graph. Records a module before export/dispatch so failures leave its pending slot.
 * Agent/check edits remain on disk; export, snapshot, publication and failed-step errors reject. */
async function runModules(context: RunContext, input: ModuleExecution): Promise<void> {
  const { options, report, checks, progress } = context
  let previousStepChangedFiles = false
  for (const module of input.plan.modules) {
    const result: ModuleResult = { module, step: null }
    report.modules.push(result)
    const graphFile = previousStepChangedFiles ? await exportGraph(context, `graph-before-${module.id}.json`) : input.graphFile
    progress(`module/${module.id}: started`)
    const step = await runStep(options, modulePrompt({
      module, graphFile, version: treeVersion(await captureTree(options.cwd)), checks,
      mode: options.reviewOnly ? 'read-only' : 'edit', design: input.design,
    }), checks)
    result.step = step
    await checkpointStep(context, { step, label: `module/${module.id}`, failureMessage: `Module ${module.id} failed` })
    previousStepChangedFiles = step.changedFiles.length > 0
  }
}

/** Run design, plan the resulting tree, then edit modules serially using a caller-owned client.
 * Writes baselines, graphs and reports under cwd/.anureo/refactor while holding a writer lock;
 * agent edits and explicit check commands may modify the target. A failed phase stops later work
 * and returns an incomplete report, including checkpoint write failures, so later work cannot
 * build on an unvalidated tree. Invalid input, repository preflight, lock, final publication
 * and cleanup failures reject; partial edits remain. */
export async function refactorCode(input: RefactorOptions): Promise<RefactorReport> {
  validateChecks(input.checks)
  const cwd = await repositoryDirectory(input.cwd)
  const options = { ...input, cwd }
  return withRun(options, async (report, progress) => {
    const checks = input.reviewOnly ? [] : input.checks ?? await defaultChecks(cwd)
    const context = { options, report, checks, progress }
    const design = await runDesign(context)
    const modules = await prepareModules(context, design)
    await runModules(context, modules)
  })
}
