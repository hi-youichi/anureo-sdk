import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { defaultAngles } from './angles'
import { createReviewClient, fixPermissionMode, reviewHarnesses } from './client'
import { formatFailure } from './errors'
import { formatReport } from './report'
import { DEFAULT_WORKFLOW_DIRECTORY } from './paths'
import { reviewCode } from './review'
import { DEFAULT_REVIEW_CONCURRENCY, validatePositiveInteger, validateModuleIds, hasDuplicateIds } from './options'
import type { ReviewProgress } from './progress'

/** Run the executable's arguments (without the runtime/executable prefix) without exiting the process.
 * Returns 0 for help or a complete review without findings, 1 for a complete review with findings,
 * and 2 for incomplete reviews or errors. Resolves after report output and client disposal.
 * Help/argument failures acquire no backend. Callbacks run synchronously: help/report throws become
 * CLI errors, progress throws are collected by reviewCode, and throwing error diagnostics can reject.
 * Internal CLI entry point. */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const runtime: CliRuntime = {
    ...dependencies, env: dependencies.env ?? process.env,
    stdout: dependencies.stdout ?? (text => { process.stdout.write(text) }),
    stderr: dependencies.stderr ?? (text => { process.stderr.write(text) }),
  }
  try {
    const command = parseCommand(args)
    if (command.kind === 'help') { runtime.stdout(help); return 0 }
    return await executeReviewCommand(command, runtime)
  } catch (cause) {
    runtime.stderr(`anureo-review: ${formatFailure(cause)}\n`)
    return 2
  }
}

const help = `Usage: anureo-review [directory] [options]

Analyze modules, then review modules and their angles concurrently.
Defaults to the current directory and all built-in angles.
Requires Bun and configured authentication for the selected harness.
Pi runs in-process; CLI-based harnesses require their corresponding executable.

Options:
  --harness <id>          Review backend (default: codex): ${reviewHarnesses.join(', ')}
  --model <name>          Model override (defaults to CODEX_MODEL or backend default)
  --concurrency <number>  Maximum simultaneous review and fix agents (default: ${DEFAULT_REVIEW_CONCURRENCY})
  --max-modules <number>  Review at most this many modules, in plan order
  --module <id>          Select an analyzed module ID (repeatable)
  --angle <id>           Select a built-in angle (repeatable): ${defaultAngles.map(angle => angle.id).join(', ')}
  --focus <text>          Additional focus for module analysis and review
  --fix                  Run each agent in a temporary Git worktree, apply
                         validated edits, then re-review the selected scope.
                         Existing uncommitted changes are included.
  --workflow-dir <path>   Durable run storage (default: <directory>/${DEFAULT_WORKFLOW_DIRECTORY})
  --json                 Print the structured report as JSON
  --help, -h             Show this help

Exit codes: 0 complete without findings, 1 complete with findings, 2 failed/incomplete.
`

/** Internal execution seams for runCli; omitted hooks use the production client and process streams. */
interface CliDependencies {
  /** Receives the canonical directory and selected backend after preflight. runCli owns the returned
   * initialized client and awaits its disposal, including after review or report-output failure. */
  createClient?: (cwd: string, harness: typeof reviewHarnesses[number]) => Promise<Client>
  /** Synchronously consume help or the final report. Throws become CLI errors. */
  stdout?: (text: string) => void
  /** Synchronously consume progress and diagnostics. Progress throws are retained in the report;
   * diagnostic throws can reject runCli. */
  stderr?: (text: string) => void
  /** Fallback when no positional directory is supplied; defaults to process.cwd(). Does not chdir. */
  cwd?: string
  /** Supplies only the CODEX_MODEL fallback when --model is omitted; defaults to process.env.
   * Built-in adapter factories still read process.env. */
  env?: Record<string, string | undefined>
}

/** Process defaults resolved by runCli before parsing or execution. */
interface CliRuntime extends CliDependencies {
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** Parse syntax and validate backend, limits and selections before runCli can acquire a client.
 * Throws flag-specific errors; help bypasses selection validation after strict syntax parsing.
 * Module existence is checked by reviewCode only after analysis produces the module plan. */
function parseCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, fix: { type: 'boolean' },
    model: { type: 'string' }, concurrency: { type: 'string' }, focus: { type: 'string' },
    harness: { type: 'string' },
    'workflow-dir': { type: 'string' },
    'max-modules': { type: 'string' },
    module: { type: 'string', multiple: true }, angle: { type: 'string', multiple: true },
  } })
  if (values.help) return { kind: 'help' as const }
  if (positionals.length > 1) throw new Error('Expected at most one review directory')
  const harness = values.harness === undefined ? 'codex' : reviewHarnesses.find(id => id === values.harness)
  if (!harness) throw new Error(`Unknown harness: ${values.harness}. Available: ${reviewHarnesses.join(', ')}`)
  const concurrency = values.concurrency === undefined ? DEFAULT_REVIEW_CONCURRENCY : Number(values.concurrency)
  validatePositiveInteger(concurrency, '--concurrency')
  const maxModules = values['max-modules'] === undefined ? undefined : Number(values['max-modules'])
  if (maxModules !== undefined) validatePositiveInteger(maxModules, '--max-modules')
  validateModuleIds(values.module, '--module requires unique nonempty module ids')
  if (values.angle && hasDuplicateIds(values.angle)) throw new Error('--angle requires unique angle ids')
  const angles = values.angle?.map(id => {
    const angle = defaultAngles.find(angle => angle.id === id)
    if (!angle) throw new Error(`Unknown angle: ${id}. Available: ${defaultAngles.map(angle => angle.id).join(', ')}`)
    return angle
  })
  return {
    kind: 'review' as const, directory: positionals[0], harness, concurrency, maxModules, angles,
    moduleIds: values.module, focus: values.focus, model: values.model,
    fix: values.fix, json: values.json, workflowDirectory: values['workflow-dir'],
  }
}

type ReviewCommand = Extract<ReturnType<typeof parseCommand>, { kind: 'review' }>

/** Acquire a client only after directory preflight and retain ownership through report output.
 * runCli receives failures after disposal settles: a cleanup failure rejects an otherwise successful
 * execution, while a review/output failure remains primary if the separate cleanup diagnostic succeeds.
 * A throwing cleanup diagnostic can replace the original failure. */
async function executeReviewCommand(command: ReviewCommand, runtime: CliRuntime): Promise<number> {
  const cwd = await resolveReviewDirectory(command.directory ?? runtime.cwd ?? process.cwd())
  const client = await (runtime.createClient ?? createReviewClient)(cwd, command.harness)
  let executionFailed = false
  try {
    return await reviewAndPrintReport({ command, runtime, cwd, client })
  } catch (cause) {
    executionFailed = true
    throw cause
  } finally {
    try { await client.dispose() }
    catch (cause) {
      if (!executionFailed) throw cause
      runtime.stderr(`anureo-review: client cleanup failed: ${formatFailure(cause)}\n`)
    }
  }
}

/** Canonicalize and require an existing directory before executeReviewCommand acquires a backend.
 * Relative paths resolve from the process working directory; filesystem/type failures reject. */
async function resolveReviewDirectory(directory: string): Promise<string> {
  const cwd = await realpath(resolve(directory))
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Review directory is not a directory: ${cwd}`)
  return cwd
}

/** Await reviewCode, synchronously print its report and derive the CLI exit code.
 * Review rejections and output throws propagate to executeReviewCommand, which owns client cleanup.
 * reviewCode invokes the progress observer synchronously and collects its exceptions in the report. */
async function reviewAndPrintReport({ command, runtime, cwd, client }: {
  command: ReviewCommand
  runtime: CliRuntime
  cwd: string
  client: Client
}): Promise<number> {
  const report = await reviewCode({
    client, cwd, concurrency: command.concurrency, focus: command.focus, model: command.model ?? runtime.env.CODEX_MODEL,
    angles: command.angles, moduleIds: command.moduleIds, maxModules: command.maxModules, fix: command.fix,
    ...(command.fix ? { fixPermissionMode: fixPermissionMode(command.harness) } : {}),
    workflowDirectory: command.workflowDirectory,
    onProgress: event => runtime.stderr(formatProgress(event)),
  })
  runtime.stdout(command.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
  if (report.status === 'incomplete') return 2
  // reviewCode chooses the authoritative pass, including post-fix verification.
  return report.findingCount > 0 ? 1 : 0
}

/** Format reviewCode's synchronous progress events for stderr, keeping stdout available for the report. */
function formatProgress(event: ReviewProgress): string {
  if (event.stage === 'workflow') return `[workflow] ${event.runId} (${event.directory})\n`
  if (event.stage === 'analysis') return `[analysis] ${event.status}\n`
  if (event.stage === 'fix') return `[fix/${event.moduleId}] ${event.status}\n`
  return `[${event.stage === 'verification' ? 'verification/' : ''}${event.moduleId}/${event.angleId}] ${event.status}\n`
}
