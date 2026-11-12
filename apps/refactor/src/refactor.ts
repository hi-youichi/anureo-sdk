import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from '@anureo/sdk'
import { agent } from '@anureo/workflow'
import { loadGraph, type GraphLoader } from './graph'
import { designPrompt, modulePrompt, planPrompt } from './prompts'
import { modulePlanSchema, workSchema, type ModulePlan, type RefactorModule, type Work } from './schema'
import { captureTree, changes, exec, isSource, repositoryDirectory, treeVersion, validatePlan, validateSourcePath } from './source'

export interface CheckResult { command: string; status: 'passed' | 'failed'; output: string }
export interface Failure { code: string | null; outcomeUnknown: boolean; cleanupFailed: boolean }
/** One agent step: it reviews and edits in a single pass. */
export interface StepResult extends Work {
  status: 'applied' | 'unchanged' | 'failed'
  changedFiles: string[]
  checks: CheckResult[]
  error: string | null
  failure: Failure | null
}
export interface ModuleResult { module: RefactorModule; step: StepResult | null }
export interface RefactorReport {
  runId: string
  cwd: string
  directory: string
  status: 'completed' | 'incomplete'
  reviewOnly: boolean
  /** Cross-module design step, run before modules are planned. */
  design: StepResult | null
  plan: ModulePlan | null
  modules: ModuleResult[]
  errors: string[]
  failure: Failure | null
  progressErrors: string[]
}
export interface RefactorOptions {
  client: Client
  cwd: string
  model?: string
  /** Read-only mode is stated in the prompts; the host does not enforce it. */
  reviewOnly?: boolean
  repographEntry?: string
  /** Override the real repograph subprocess for embedding/tests. */
  graphLoader?: GraphLoader
  /** Explicit shell commands, or root package.json typecheck/test scripts by default. */
  checks?: readonly string[]
  onProgress?: (message: string) => void
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function failure(cause: unknown): Failure {
  const error = (cause && typeof cause === 'object' ? cause : {}) as { outcomeUnknown?: boolean; code?: unknown; details?: Record<string, unknown> }
  return {
    code: typeof error.code === 'string' ? error.code : null,
    outcomeUnknown: error.outcomeUnknown === true,
    cleanupFailed: error.code === 'RESOURCE_RELEASE_FAILED' || error.details?.cleanupFailed === true
      || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0),
  }
}

async function saveReport(report: RefactorReport): Promise<void> {
  const path = join(report.directory, 'report.json')
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, path)
}

async function defaultChecks(cwd: string): Promise<string[]> {
  let pkg: { packageManager?: string; scripts?: Record<string, unknown> }
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const manager = /^(bun|npm|pnpm|yarn)@/.exec(pkg.packageManager ?? '')?.[1] ?? 'npm'
  return ['typecheck', 'test'].filter(name => typeof pkg.scripts?.[name] === 'string').map(name => `${manager} run ${name}`)
}

async function runChecks(cwd: string, commands: readonly string[], results: CheckResult[]): Promise<void> {
  for (const command of commands) {
    try {
      const { stdout, stderr } = await exec('sh', ['-c', command], { cwd, maxBuffer: 8 << 20, timeout: 300_000 })
      results.push({ command, status: 'passed', output: `${stdout}${stderr}`.slice(-4000) })
    } catch (cause) {
      const error = cause as { stdout?: string; stderr?: string }
      results.push({ command, status: 'failed', output: `${error.stdout ?? ''}${error.stderr ?? ''}\n${message(cause)}`.slice(-4000) })
      throw new Error(`Validation failed: ${command}`)
    }
  }
}

async function inventory(cwd: string): Promise<{ tree: Map<string, string>; files: string[] }> {
  const tree = await captureTree(cwd)
  const files = [...tree.keys()].filter(isSource)
  if (!files.length) throw new Error('No supported Git-visible source files found')
  for (const file of files) await validateSourcePath(cwd, file)
  return { tree, files }
}

async function plan(options: RefactorOptions, files: string[], version: string): Promise<ModulePlan> {
  const result = await agent(planPrompt(files, version), {
    client: options.client, cwd: options.cwd, model: options.model, permissionMode: 'read-only', schema: modulePlanSchema,
  })
  if (!result) throw new Error('Module planning returned no result')
  validatePlan(result, files)
  return result
}

/** One agent session that reviews and edits; the host records the real diff and runs the checks. */
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

/** Hold the repository-wide lock and the run directory for the duration of `body`. */
async function withRun(options: RefactorOptions & { cwd: string }, body: (report: RefactorReport, progress: (event: string) => void) => Promise<void>): Promise<RefactorReport> {
  const root = join(options.cwd, '.anureo', 'refactor')
  await mkdir(root, { recursive: true })
  const lockPath = join(root, 'writer.lock')
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error(`Cannot acquire refactor lock: ${lockPath}. Check for an active run before removing a stale lock.`) })
  const runId = randomUUID()
  const report: RefactorReport = {
    runId, cwd: options.cwd, directory: join(root, runId), status: 'incomplete', reviewOnly: options.reviewOnly ?? false,
    design: null, plan: null, modules: [], errors: [], failure: null, progressErrors: [],
  }
  const progress = (event: string) => {
    try { options.onProgress?.(event) } catch (cause) { report.progressErrors.push(message(cause)) }
  }
  try {
    await mkdir(report.directory)
    progress(`run: ${report.directory}`)
    await body(report, progress)
    report.status = 'completed'
  } catch (cause) { report.errors.push(message(cause)); report.failure = failure(cause) }
  finally {
    // Publication failures must still release the writer lock; they do not undo edits.
    try { await saveReport(report) }
    finally { try { await lock.close() } finally { await rm(lockPath) } }
  }
  return report
}

/** Order of work: cross-module design first, then module planning on the resulting tree, then
 * one agent per module in series. Each step reviews and edits; a failed step stops the run
 * because later steps would build on an unvalidated tree. */
export async function refactorCode(input: RefactorOptions): Promise<RefactorReport> {
  if (input.checks?.some(command => !command.trim())) throw new Error('check commands must be nonempty')
  const cwd = await repositoryDirectory(input.cwd)
  const options = { ...input, cwd }
  const exportGraph = async (report: RefactorReport, name: string) => {
    const file = join(report.directory, name)
    await writeFile(file, JSON.stringify(await (input.graphLoader ?? ((directory: string) => loadGraph(directory, input.repographEntry)))(cwd)))
    return file
  }
  return withRun(options, async (report, progress) => {
    const checks = input.reviewOnly ? [] : input.checks ?? await defaultChecks(cwd)
    const initial = await inventory(cwd)
    await writeFile(join(report.directory, 'baseline.json'), JSON.stringify(Object.fromEntries(initial.tree), null, 2))

    progress('graph: started')
    const designGraph = await exportGraph(report, 'graph-design.json')
    progress('design: started')
    report.design = await runStep(options, designPrompt(initial.files, designGraph, treeVersion(initial.tree), checks, options.reviewOnly ?? false), checks)
    progress(`design: ${report.design.status}`)
    await saveReport(report)
    if (report.design.status === 'failed') throw new Error(`Cross-module design failed: ${report.design.error}`)

    const current = await inventory(cwd)
    report.plan = await plan(options, current.files, treeVersion(current.tree))
    const graphFile = report.design.changedFiles.length ? await exportGraph(report, 'graph-modules.json') : designGraph
    await saveReport(report)

    let dirty = false
    for (const module of report.plan.modules) {
      const result: ModuleResult = { module, step: null }
      report.modules.push(result)
      const file = dirty ? await exportGraph(report, `graph-before-${module.id}.json`) : graphFile
      dirty = false
      progress(`module/${module.id}: started`)
      result.step = await runStep(options, modulePrompt(module, file, treeVersion(await captureTree(cwd)), checks, options.reviewOnly ?? false, report.design.summary), checks)
      progress(`module/${module.id}: ${result.step.status}`)
      await saveReport(report)
      if (result.step.status === 'failed') throw new Error(`Module ${module.id} failed: ${result.step.error}`)
      dirty = result.step.changedFiles.length > 0
    }
  })
}
