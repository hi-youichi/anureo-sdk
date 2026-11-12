import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { defaultAngles } from './angles'
import { createReviewClient, fixPermissionMode, reviewHarnesses } from './client'
import { formatFailure } from './errors'
import { formatReport } from './report'
import { DEFAULT_WORKFLOW_DIRECTORY } from './paths'
import { DEFAULT_REVIEW_CONCURRENCY, reviewCode } from './review'

const help = `Usage: anureo-review [directory] [options]

Analyze modules, then review modules and their angles concurrently.
Defaults to the current directory and all built-in angles.
Requires Bun and configured authentication for the selected harness.
Pi runs in-process; CLI-based harnesses require their corresponding executable.

Options:
  --harness <id>          Review backend (default: codex): ${reviewHarnesses.join(', ')}
  --model <name>          Model override (defaults to CODEX_MODEL or backend default)
  --concurrency <number>  Maximum simultaneous review agents (default: ${DEFAULT_REVIEW_CONCURRENCY})
  --max-modules <number>  Review at most this many modules, in plan order
  --module <id>          Select an analyzed module ID (repeatable)
  --angle <id>           Select a built-in angle (repeatable): ${defaultAngles.map(angle => angle.id).join(', ')}
  --focus <text>          Additional focus for module analysis and review
  --fix                  Let an agent edit selected sources directly to fix findings,
                         then review again; existing uncommitted changes are allowed
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

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env
  const stdout = dependencies.stdout ?? (text => { process.stdout.write(text) })
  const stderr = dependencies.stderr ?? (text => { process.stderr.write(text) })
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, fix: { type: 'boolean' },
      model: { type: 'string' }, concurrency: { type: 'string' }, focus: { type: 'string' },
      harness: { type: 'string' },
      'workflow-dir': { type: 'string' },
      'max-modules': { type: 'string' },
      module: { type: 'string', multiple: true }, angle: { type: 'string', multiple: true },
    } })
    if (values.help) { stdout(help); return 0 }
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
    const cwd = await realpath(resolve(positionals[0] ?? dependencies.cwd ?? process.cwd()))
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Review directory is not a directory: ${cwd}`)
    const client = await (dependencies.createClient ?? createReviewClient)(cwd, harness)
    let executionFailed = false
    try {
      const report = await reviewCode({
        client, cwd, concurrency, focus: values.focus, model: values.model ?? env.CODEX_MODEL,
        angles, moduleIds: values.module, maxModules, fix: values.fix,
        ...(values.fix ? { fixPermissionMode: fixPermissionMode(harness) } : {}),
        workflowDirectory: values['workflow-dir'],
        onProgress: event => {
          if (event.stage === 'workflow') stderr(`[workflow] ${event.runId} (${event.directory})\n`)
          else if (event.stage === 'analysis') stderr(`[analysis] ${event.status}\n`)
          else if (event.stage === 'fix') stderr(`[fix] ${event.status}\n`)
          else stderr(`[${event.stage === 'verification' ? 'verification/' : ''}${event.moduleId}/${event.angleId}] ${event.status}\n`)
        },
      })
      stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
      if (report.status === 'incomplete') return 2
      // findingCount comes from the authoritative pass: post-fix verification
      // replaces the original review when a fix was applied (see reviewCode).
      return report.findingCount > 0 ? 1 : 0
    } catch (cause) {
      executionFailed = true
      throw cause
    } finally {
      try { await client.dispose() }
      catch (cause) {
        if (!executionFailed) throw cause
        stderr(`anureo-review: client cleanup failed: ${formatFailure(cause)}\n`)
      }
    }
  } catch (cause) {
    stderr(`anureo-review: ${formatFailure(cause)}\n`)
    return 2
  }
}
