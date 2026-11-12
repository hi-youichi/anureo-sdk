import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { defaultAngles } from './angles'
import { createReviewClient } from './client'
import { formatReport } from './report'
import { reviewCode } from './review'

const help = `Usage: anureo-review [directory] [options]

Analyze modules, then review modules and their angles concurrently.
Defaults to the current directory and all built-in angles.
Requires Bun and an installed, authenticated Codex CLI (CODEX_BIN overrides it).

Options:
  --model <name>          Model override (defaults to CODEX_MODEL or backend default)
  --concurrency <number>  Maximum simultaneous review agents (default: 8)
  --max-modules <number>  Review at most this many modules, in plan order
  --module <id>          Select an analyzed module ID (repeatable)
  --angle <id>           Select a built-in angle (repeatable): ${defaultAngles.map(angle => angle.id).join(', ')}
  --focus <text>          Additional focus for module analysis and review
  --workflow-dir <path>   Durable run storage (default: <directory>/.anureo/workflows)
  --json                 Print the structured report as JSON
  --help, -h             Show this help

Exit codes: 0 complete without findings, 1 complete with findings, 2 failed/incomplete.
`

interface CliDependencies {
  createClient?: (cwd: string) => Promise<Client>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => { process.stdout.write(text) })
  const stderr = dependencies.stderr ?? (text => { process.stderr.write(text) })
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      model: { type: 'string' }, concurrency: { type: 'string' }, focus: { type: 'string' },
      'workflow-dir': { type: 'string' },
      'max-modules': { type: 'string' },
      module: { type: 'string', multiple: true }, angle: { type: 'string', multiple: true },
    } })
    if (values.help) { stdout(help); return 0 }
    if (positionals.length > 1) throw new Error('Expected at most one review directory')
    const concurrency = values.concurrency === undefined ? 8 : Number(values.concurrency)
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
    const cwd = await realpath(resolve(positionals[0] ?? process.cwd()))
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Review directory is not a directory: ${cwd}`)
    const client = await (dependencies.createClient ?? createReviewClient)(cwd)
    try {
      const report = await reviewCode({
        client, cwd, concurrency, focus: values.focus, model: values.model ?? process.env.CODEX_MODEL,
        angles, moduleIds: values.module, maxModules,
        workflowDirectory: values['workflow-dir'],
        onProgress: event => {
          if (event.stage === 'workflow') stderr(`[workflow] ${event.runId} (${event.directory})\n`)
          else if (event.stage === 'analysis') stderr(`[analysis] ${event.status}\n`)
          else stderr(`[${event.moduleId}/${event.angleId}] ${event.status}\n`)
        },
      })
      stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
      if (report.status === 'incomplete') return 2
      return report.modules.some(module => module.angles.some(angle => angle.status === 'completed' && angle.findings.length > 0)) ? 1 : 0
    } finally {
      await client.dispose()
    }
  } catch (cause) {
    stderr(`anureo-review: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 2
  }
}
