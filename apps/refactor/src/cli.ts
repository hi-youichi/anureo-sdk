import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { createRefactorClient } from './client'
import { defaultRepographEntry, type GraphLoader } from './graph'
import { refactorCode } from './refactor'
import { formatReport } from './report'

const help = `Usage: anureo-refactor [repository] [options]

Export a repograph graph; one agent fixes design between modules, then one agent per
module reviews and refactors it, serially. Defaults to the current directory, which may
be any directory inside a Git work tree. Preserves public APIs and behavior.
Requires Bun, a configured Codex CLI, Git, and the adjacent repograph checkout.

Options:
  --review-only          Ask agents to propose changes without editing (stated in the prompt, not enforced)
  --model <name>         Codex model override (or CODEX_MODEL)
  --repograph <entry>    repograph TypeScript CLI path
                        Default: ${defaultRepographEntry}
  --check <command>      Validation command after each edit (repeatable)
                        Default: root package.json typecheck/test scripts
  --json                Print the structured report
  --help, -h            Show help

Reports: <repository>/.anureo/refactor/<run-id>/report.json
Scope: Git-visible source files under the target directory; excludes docs, drafts, dependencies, generated
directories, .d.ts files, and build/run output.
Runs start fresh; partial edits are retained on failure for inspection.
Exit codes: 0 complete, 2 incomplete/error.
`

/** Seams for tests and embedding; every field defaults to the real process environment. */
interface CliDependencies {
  createClient?: (cwd: string) => Promise<Client>
  graphLoader?: GraphLoader
  cwd?: string
  env?: Record<string, string | undefined>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

/** Parse `args`, run one refactor and print its report. Returns the process exit code:
 * 0 when the run completed, 2 for bad arguments, an error, or an incomplete run.
 *
 * Arguments are validated before the client is created so a typo never starts a backend. The
 * client is owned here and always disposed; a disposal error is reported on stderr instead of
 * replacing an earlier failure, and surfaces as the failure itself only when the run succeeded. */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => { process.stdout.write(text) })
  const stderr = dependencies.stderr ?? (text => { process.stderr.write(text) })
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'review-only': { type: 'boolean' },
      model: { type: 'string' }, repograph: { type: 'string' },
      check: { type: 'string', multiple: true },
    } })
    if (values.help) { stdout(help); return 0 }
    if (positionals.length > 1) throw new Error('Expected at most one repository directory')
    if (values.check?.some(command => !command.trim())) throw new Error('--check commands must be nonempty')
    const cwd = resolve(dependencies.cwd ?? process.cwd(), positionals[0] ?? '.')
    const client = await (dependencies.createClient ?? createRefactorClient)(cwd)
    let failed = false
    try {
      const report = await refactorCode({
        client, cwd, reviewOnly: values['review-only'],
        model: values.model ?? (dependencies.env ?? process.env).CODEX_MODEL,
        repographEntry: values.repograph === undefined ? undefined : resolve(dependencies.cwd ?? process.cwd(), values.repograph),
        graphLoader: dependencies.graphLoader, checks: values.check,
        onProgress: event => stderr(`[refactor] ${event}\n`),
      })
      stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
      return report.status === 'incomplete' ? 2 : 0
    } catch (cause) { failed = true; throw cause }
    finally {
      try { await client.dispose() }
      catch (cause) {
        if (!failed) throw cause
        stderr(`anureo-refactor: cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      }
    }
  } catch (cause) {
    stderr(`anureo-refactor: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 2
  }
}
