// Sequences design, planning, concurrent module work and integration under the run lock.
import { writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { agent } from '@anureo/workflow'
import { inAgentWorktree, integrateAgentWork, markFailed, runAgentWork } from './agent-work'
import { defaultChecks, validateChecks, type CheckCommand } from './checks'
import { message } from './errors'
import { captureTree, repositoryDirectory, treeVersion } from './git-tree'
import { loadGraph, type RepositoryGraph } from './graph'
import type { RefactorOptions } from './options'
import { validatePlan } from './plan-validation'
import { designPrompt, modulePrompt, planPrompt } from './prompts'
import { saveReport } from './report-store'
import type { ModuleResult, RefactorReport, StepResult } from './results'
import { withRun } from './run-lifecycle'
import { modulePlanSchema, type ModulePlan } from './schema'
import { isSource, isTextSource } from './source-policy'
import { withWorktreeBaseline, type WorktreeBaseline } from './worktree'

/** Caller configuration re-exported here to preserve direct imports; ownership stays with the caller. */
export type { RefactorOptions } from './options'
/** Host-observed report types retained for direct consumers; importing them performs no work. */
export type { RefactorReport, ModuleResult, StepResult, CheckResult, Failure } from './results'

/** Run design, plan the resulting tree, then edit modules concurrently using a caller-owned client.
 * Each session gets a detached worktree. The host integrates patches in plan order and runs checks
 * against the target. Failed steps block subsequent integration and return an incomplete report.
 * Invalid input, repository preflight, lock acquisition, final publication and lock cleanup failures
 * reject. Keep the client usable until the report is published and the lock is released, and dispose
 * it separately. Review-only mode suppresses host checks and integration. */
export async function refactorCode(input: RefactorOptions): Promise<RefactorReport> {
  validateChecks(input.checks)
  if (input.noGraph && (input.repographEntry || input.graphLoader)) throw new Error('noGraph cannot be combined with a graph exporter')
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

/** Capture a host baseline for design/planning and validate eligible paths before agent dispatch.
 * Reads Git and the filesystem; rejects empty inventories, unsafe source paths and snapshot errors. */
async function inventory({ cwd, include, exclude }: RefactorOptions): Promise<{ tree: Map<string, string>; files: string[] }> {
  const tree = await captureTree(cwd)
  const files: string[] = []
  for (const file of tree.keys()) {
    if (isSource(file, include, exclude) && await isTextSource(cwd, file)) files.push(file)
  }
  if (!files.length) throw new Error('No eligible Git-visible source files found')
  return { tree, files }
}

/** Ask one read-only agent in its own worktree to partition the post-design inventory. */
async function plan(options: RefactorOptions, baseline: WorktreeBaseline, files: string[], version: string): Promise<ModulePlan> {
  const result = await inAgentWorktree(baseline, cwd =>
    agent(planPrompt(files, version), {
      client: options.client, cwd, model: options.model, permissionMode: options.readPermissionMode,
      schema: modulePlanSchema, outputFallback: 'json-text',
    }),
  )
  if (!result) throw new Error('Module planning returned no result')
  validatePlan(result, files)
  return result
}

/** Context shared by phases while withRun holds the writer lock.
 * Phases publish into the same report; checks are selected once before the initial inventory. */
interface RunContext {
  options: RefactorOptions
  report: RefactorReport
  checks: readonly CheckCommand[]
  /** An implicit exporter failure switches the remainder of the run to source inspection. */
  graphError?: string
  progress: (event: string) => void
}

/** Successful design output needed by planning; the graph describes the pre-design tree. */
interface DesignResult {
  design: StepResult
  graphFile: string | null
}

/** Prepared module work; graphFile is the post-design baseline, before any module edits. */
interface ModuleExecution {
  plan: ModulePlan
  graphFile: string | null
  design: string
  version: string
}

/** Record graph coverage for a phase, falling back to source when the implicit exporter fails. */
async function exportGraph(context: RunContext, phase: string, files: string[]): Promise<string | null> {
  const { options, report, progress } = context
  if (options.noGraph) {
    report.graphCoverage.push({ phase, status: 'disabled', filesWithoutSymbols: files })
    return null
  }
  if (context.graphError !== undefined) {
    report.graphCoverage.push({ phase, status: 'unavailable', filesWithoutSymbols: files, error: context.graphError })
    return null
  }
  let graph: RepositoryGraph
  try {
    graph = options.graphLoader ? await options.graphLoader(options.cwd) : await loadGraph(options.cwd, options.repographEntry)
  } catch (cause) {
    const error = message(cause)
    report.graphCoverage.push({ phase, status: 'unavailable', filesWithoutSymbols: files, error })
    if (options.graphLoader || options.repographEntry) throw cause
    context.graphError = error
    progress(`graph/${phase}: unavailable; continuing with source`)
    return null
  }
  const indexed = new Set(graph.nodes
    .filter(node => node.labels.some(label => !/^(file|folder|directory|package|project|module)$/i.test(label)))
    .map(({ filePath }) => (isAbsolute(filePath) ? relative(options.cwd, filePath) : filePath).split(sep).join('/')))
  report.graphCoverage.push({ phase, status: 'available', filesWithoutSymbols: files.filter(file => !indexed.has(file)) })
  const file = join(report.directory, `graph-${phase}.json`)
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
  const initial = await inventory(options)
  await writeFile(join(report.directory, 'baseline.json'), JSON.stringify(Object.fromEntries(initial.tree), null, 2))
  progress('graph: started')
  const graphFile = await exportGraph(context, 'design', initial.files)
  progress('design: started')
  const design = await withWorktreeBaseline(options.cwd, async baseline => {
    const step = await runAgentWork({
      baseline, options, patchPath: join(report.directory, 'design.patch'),
      prompt: designPrompt({
        files: initial.files, graphFile, version: treeVersion(initial.tree), checks,
        mode: options.reviewOnly ? 'read-only' : 'edit', isolated: true,
      }),
    })
    await integrateAgentWork({ baseline, options, step, checks, retainPartial: true })
    return step
  })
  report.design = design
  await checkpointStep(context, { step: design, label: 'design', failureMessage: 'Cross-module design failed' })
  return { design, graphFile }
}

/** Reinventory after successful design, validate the plan and prepare its baseline graph.
 * Called before any module; records the plan before a needed graph refresh and report write.
 * Reads Git/files, starts a read-only agent and may export a graph; any failure rejects. */
async function prepareModules(context: RunContext, baseline: WorktreeBaseline, input: DesignResult): Promise<ModuleExecution> {
  const current = await inventory(context.options)
  const version = treeVersion(current.tree)
  const modulePlan = await plan(context.options, baseline, current.files, version)
  context.report.plan = modulePlan
  const graphFile = input.design.changedFiles.length ? await exportGraph(context, 'modules', current.files) : input.graphFile
  await saveReport(context.report)
  return { plan: modulePlan, graphFile, design: input.design.summary, version }
}

/** Settle all module sessions before integrating their patches and publishing checkpoints in order. */
async function runModules(context: RunContext, baseline: WorktreeBaseline, input: ModuleExecution): Promise<void> {
  const { options, report, checks, progress } = context
  const results: ModuleResult[] = input.plan.modules.map(module => ({ module, step: null }))
  report.modules = results
  const settled = await Promise.allSettled(results.map(async result => {
    const { module } = result
    progress(`module/${module.id}: started`)
    result.step = await runAgentWork({
      baseline, options, assignedFiles: module.files, patchPath: join(report.directory, `module-${module.id}.patch`),
      prompt: modulePrompt({
        module, graphFile: input.graphFile, version: input.version, checks,
        mode: options.reviewOnly ? 'read-only' : 'edit', design: input.design, isolated: true,
      }),
    })
    progress(`module/${module.id}: finished`)
  }))
  const rejected = settled.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason

  let failed: ModuleResult | undefined
  for (const result of results) {
    const { module, step } = result
    if (!step) continue
    if (!failed) await integrateAgentWork({ baseline, options, step, checks })
    else if (step.patch && step.status !== 'failed') {
      markFailed(step, new Error(`Integration blocked by failed module ${failed.module.id}`))
    }
    if (step.status === 'failed') failed ??= result
    progress(`module/${module.id}: ${step.status}`)
    await saveReport(report)
  }
  if (failed) throw new Error(`Module ${failed.module.id} failed: ${failed.step?.error}`)
}
