// Adapts CLI input/output and owns the client lifecycle; it must not implement refactor phases or shared validation policy.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { validateChecks } from './checks'
import { createRefactorClient } from './client'
import { message } from './errors'
import { defaultRepographEntry, type GraphLoader } from './graph'
import { refactorCode } from './refactor'
import { formatReport } from './report'

/** Usage printed by runCli; interpolate the graph default so help and execution paths stay aligned. */
const help = `Usage: anureo-refactor [repository] [options]

Export a repograph graph; one agent fixes design between modules, then one agent per
module reviews and refactors it, serially. Defaults to the current directory, which may
be any directory inside a Git work tree. Preserves public APIs and behavior.
Requires Bun, a configured Codex CLI and Git. Uses the installed @youichi/repograph package.

Options:
  --review-only          Ask agents to propose changes without editing (stated in the prompt, not enforced)
  --model <name>         Codex model override (or CODEX_MODEL)
  --repograph <entry>    Override the installed repograph CLI with a JS/TS entry path
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

/** Overrides for runCli callers; omitted fields use production factories, paths and streams. */
interface CliDependencies {
  /** Factory for the CLI-owned client; runCli awaits disposal even after execution fails. */
  createClient?: (cwd: string) => Promise<Client>
  /** Substitute graph export without starting the repograph subprocess. */
  graphLoader?: GraphLoader
  /** Base directory for relative CLI paths; defaults to process.cwd(). */
  cwd?: string
  /** Model-default environment; adapter-specific environment remains owned by client setup. */
  env?: Record<string, string | undefined>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

/** Parse and validate runCli input before resource acquisition, returning help or a run command.
 * Reads the base cwd only for runs; invalid syntax, extra paths and blank checks throw. Help
 * bypasses run-only validation so it remains available even with an unusable target. */
function parseCliInput(args: string[], dependencies: CliDependencies) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'review-only': { type: 'boolean' },
    model: { type: 'string' }, repograph: { type: 'string' },
    check: { type: 'string', multiple: true },
  } })
  if (values.help) return { kind: 'help' as const }
  if (positionals.length > 1) throw new Error('Expected at most one repository directory')
  validateChecks(values.check, '--check')
  return {
    kind: 'refactor' as const, values,
    cwd: resolve(dependencies.cwd ?? process.cwd(), positionals[0] ?? '.'),
  }
}

/** Validated execution input; help commands cannot acquire a client. */
type RefactorCommand = Extract<ReturnType<typeof parseCliInput>, { kind: 'refactor' }>

/** Output callbacks selected once by runCli and shared by report, progress and cleanup paths. */
interface CliOutput {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** Execute a validated command and print its report, returning 0 complete or 2 incomplete.
 * Called only by runCli; acquires and always awaits disposal of its client after orchestration
 * and output. Acquisition/run/output failures reject; disposal rejects after a returned report,
 * but is diagnosed separately when preserving an earlier rejection. Diagnostics may also throw. */
async function executeRefactor(command: RefactorCommand, dependencies: CliDependencies, output: CliOutput): Promise<number> {
  const { cwd, values } = command
  const { stdout, stderr } = output
  const client = await (dependencies.createClient ?? createRefactorClient)(cwd)
  let failed = false
  try {
    const report = await refactorCode({
      client, cwd, reviewOnly: values['review-only'],
      model: values.model ?? (dependencies.env ?? process.env).CODEX_MODEL,
      repographEntry: values.repograph === undefined ? undefined : resolve(dependencies.cwd ?? process.cwd(), values.repograph),
      graphLoader: dependencies.graphLoader, checks: values.check,
      /** Route orchestration progress to stderr so stdout remains a parseable report. */
      onProgress: event => stderr(`[refactor] ${event}\n`),
    })
    stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    return report.status === 'incomplete' ? 2 : 0
  } catch (cause) { failed = true; throw cause }
  finally {
    try { await client.dispose() }
    catch (cause) {
      // An incomplete report is a returned result, not an exception: disposal is still primary.
      if (!failed) throw cause
      stderr(`anureo-refactor: cleanup failed: ${message(cause)}\n`)
    }
  }
}

/** CLI/executable entry point: parse args, execute once, print output and return an exit code.
 * Returns 0 for help/completion, 2 for incomplete runs or caught argument/run/cleanup failures.
 * Owns the created client; orchestration may edit files and start processes. Supplied output
 * callbacks run synchronously, and an error diagnostic callback that throws still rejects. */
export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => { process.stdout.write(text) })
  const stderr = dependencies.stderr ?? (text => { process.stderr.write(text) })
  try {
    const command = parseCliInput(args, dependencies)
    if (command.kind === 'help') { stdout(help); return 0 }
    return await executeRefactor(command, dependencies, { stdout, stderr })
  } catch (cause) {
    stderr(`anureo-refactor: ${message(cause)}\n`)
    return 2
  }
}
