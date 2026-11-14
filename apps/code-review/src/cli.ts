import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { defaultAngles } from './angles'
import { createReviewClient, fixPermissionMode, reviewHarnesses, type ReviewHarness } from './client'
import { formatFailure } from './errors'
import { formatReport } from './report'
import { DEFAULT_WORKFLOW_DIRECTORY, resolveReviewDirectory } from './paths'
import { reviewCode } from './review'
import { DEFAULT_REVIEW_CONCURRENCY, validatePositiveInteger, validateModuleIds, hasDuplicateIds } from './options'
import type { ReviewProgress } from './progress'

/** Run the CLI with arguments following the executable name. The bin entry point awaits the result
 * and assigns it to process.exitCode. Returns 0 for help or a complete review without findings,
 * 1 for a complete review with findings, and 2 for incomplete coverage or reported errors.
 * Help and CLI parsing failures acquire no backend. When a report is available, it is written
 * before client disposal. The command awaits disposal before settling once a client is acquired.
 * A failure to emit the final diagnostic can reject.
 */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const runtime: CliRuntime = {
    ...dependencies,
    env: dependencies.env ?? process.env,
    stdout: dependencies.stdout ?? (text => { process.stdout.write(text) }),
    stderr: dependencies.stderr ?? (text => { process.stderr.write(text) }),
  }
  try {
    const command = parseCommand(args)
    if (command.kind === 'help') {
      runtime.stdout(help)
      return 0
    }
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
  createClient?: (cwd: string, harness: ReviewHarness) => Promise<Client>
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

/** Parse CLI syntax and validate flags that can be checked before runCli acquires a client.
 * Throws flag-specific errors. Help bypasses semantic checks after strict syntax parsing.
 * reviewCode checks module selection against the analyzed plan. */
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
  const angles = resolveSelectedAngles(values.angle)
  return {
    kind: 'review' as const, directory: positionals[0], harness, concurrency, maxModules, angles,
    moduleIds: values.module, focus: values.focus, model: values.model,
    fix: values.fix, json: values.json, workflowDirectory: values['workflow-dir'],
  }
}

type ReviewCommand = Extract<ReturnType<typeof parseCommand>, { kind: 'review' }>

/** Resolve built-in angle IDs in flag order for parseCommand. Omission lets reviewCode pick its
 * defaults. Duplicate flags take precedence over unknown IDs in the diagnostic. */
function resolveSelectedAngles(ids: readonly string[] | undefined) {
  if (ids && hasDuplicateIds(ids)) throw new Error('--angle requires unique angle ids')
  return ids?.map(id => {
    const angle = defaultAngles.find(angle => angle.id === id)
    if (!angle) throw new Error(`Unknown angle: ${id}. Available: ${defaultAngles.map(angle => angle.id).join(', ')}`)
    return angle
  })
}

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
    try {
      await client.dispose()
    } catch (cause) {
      if (!executionFailed) throw cause
      runtime.stderr(`anureo-review: client cleanup failed: ${formatFailure(cause)}\n`)
    }
  }
}

/** Await reviewCode, synchronously print its report and derive the CLI exit code. Incomplete
 * coverage takes precedence over finding count, which can include post-fix verification.
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
  return report.findingCount > 0 ? 1 : 0
}

/** Render a progress event as one stderr line. reviewAndPrintReport registers the observer with
 * reviewCode, so progress stays out of the report stream even in JSON mode. */
function formatProgress(event: ReviewProgress): string {
  if (event.stage === 'workflow') return `[workflow] ${event.runId} (${event.directory})\n`
  if (event.stage === 'analysis') return `[analysis] ${event.status}\n`
  if (event.stage === 'fix') return `[fix/${event.moduleId}] ${event.status}\n`
  return `[${event.stage === 'verification' ? 'verification/' : ''}${event.moduleId}/${event.angleId}] ${event.status}\n`
}
