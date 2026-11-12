import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { defaultAngles } from './angles'
import { createReviewClient, fixPermissionMode, reviewHarnesses } from './client'
import { formatFailure } from './errors'
import { formatReport } from './report'
import { DEFAULT_WORKFLOW_DIRECTORY } from './paths'
import { DEFAULT_REVIEW_CONCURRENCY, reviewCode, type ReviewProgress } from './review'

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
  --fix                  Fix each module's findings directly once its review
                         completes, then re-review the selected scope after all
                         fixes finish; existing uncommitted changes are allowed
  --workflow-dir <path>   Durable run storage (default: <directory>/${DEFAULT_WORKFLOW_DIRECTORY})
  --json                 Print the structured report as JSON
  --help, -h             Show this help

Exit codes: 0 complete without findings, 1 complete with findings, 2 failed/incomplete.
`

interface CliDependencies {
  createClient?: (cwd: string, harness: typeof reviewHarnesses[number]) => Promise<Client>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  /** Ambient values overridable for tests; default to the process environment. */
  cwd?: string
  env?: Record<string, string | undefined>
}

interface CliRuntime extends CliDependencies {
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

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
  // The next three checks mirror reviewCode's validation in src/review.ts so
  // flag-shaped errors name the flag; update both sites together.
  const concurrency = values.concurrency === undefined ? DEFAULT_REVIEW_CONCURRENCY : Number(values.concurrency)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive safe integer')
  const maxModules = values['max-modules'] === undefined ? undefined : Number(values['max-modules'])
  if (maxModules !== undefined && (!Number.isSafeInteger(maxModules) || maxModules < 1)) throw new Error('--max-modules must be a positive safe integer')
  if (values.module && (values.module.some(id => !id.trim()) || new Set(values.module).size !== values.module.length)) {
    throw new Error('--module requires unique nonempty module ids')
  }
  if (values.angle && new Set(values.angle).size !== values.angle.length) throw new Error('--angle requires unique angle ids')
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

function formatProgress(event: ReviewProgress): string {
  if (event.stage === 'workflow') return `[workflow] ${event.runId} (${event.directory})\n`
  if (event.stage === 'analysis') return `[analysis] ${event.status}\n`
  if (event.stage === 'fix') return `[fix/${event.moduleId}] ${event.status}\n`
  return `[${event.stage === 'verification' ? 'verification/' : ''}${event.moduleId}/${event.angleId}] ${event.status}\n`
}

/** This execution owns the client from construction through cleanup, including output failures. */
async function executeReviewCommand(command: ReviewCommand, runtime: CliRuntime): Promise<number> {
  const cwd = await realpath(resolve(command.directory ?? runtime.cwd ?? process.cwd()))
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Review directory is not a directory: ${cwd}`)
  const client = await (runtime.createClient ?? createReviewClient)(cwd, command.harness)
  let executionFailed = false
  try {
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
