// Adapts CLI input/output and owns the client lifecycle; it must not implement refactor phases or shared validation policy.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Client } from '@anureo/sdk'
import { validateChecks, type CheckCommand } from './checks'
import { createRefactorClient, harnessPermissions, refactorHarnesses, type HarnessSelection } from './client'
import { message } from './errors'
import type { GraphLoader } from './graph'
import { refactorCode } from './refactor'
import { formatReport } from './report'

/** Internal executable entry point; bin/anureo-refactor.ts awaits its result as process.exitCode.
 * Returns 0 for help/completion, 2 for incomplete runs or caught argument/run/cleanup failures.
 * Help and argument errors acquire no client; disposal of an acquired client is awaited before this settles.
 * Orchestration may edit files and start processes. Supplied output callbacks run synchronously,
 * and an error diagnostic callback that throws still rejects. */
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

/** Usage printed by runCli without loading the optional exporter. */
const help = `Usage: anureo-refactor [repository] [options]

One agent fixes design between modules, then module agents work concurrently in separate Git
worktrees. The host applies and checks their patches in plan order. Defaults to the current directory, which may
be any directory inside a Git work tree. Preserves public APIs and behavior.
Requires Bun, Git, and a configured harness. Graph export uses @youichi/repograph when installed.
Use CODEX_BIN, CLAUDE_BIN, HERMES_BIN or DSH_BIN to override an executable.

Options:
  --harness <id>         Backend (default: codex): ${refactorHarnesses.join(', ')}
  --harness-command <exe>  ACP or AHP stdio executable
  --harness-arg <arg>    ACP or AHP stdio argument (repeatable; use = for flags)
  --harness-url <url>    AHP WebSocket endpoint in place of a stdio command
  --read-permission-mode <mode>  Override the backend mode for planning and review-only sessions
  --edit-permission-mode <mode>  Override the backend mode for editing sessions
  --review-only          Ask agents to propose changes; enforcement depends on the backend mode
  --model <name>         Override the selected harness model (Codex also reads CODEX_MODEL)
  --repograph <entry>    Override the installed repograph CLI with a JS/TS entry path
  --no-graph             Inspect source directly without exporting a graph
  --include <glob>       Select Git-relative text paths (repeatable, slash separators)
  --exclude <glob>       Skip matching paths (repeatable, slash separators)
  --check <command>      Validation command using the platform shell (repeatable)
  --check-argv <json>    Validation executable and arguments as a JSON string array (repeatable)
                        Default: root package.json typecheck/test scripts
  --json                Print the structured report
  --help, -h            Show help

Reports: <repository>/.anureo/refactor/<run-id>/report.json
Scope: Git-visible UTF-8 or BOM-marked UTF-16 text under the target directory. Excludes docs and draft
directories, dependencies, generated directories, and build/run output. Without --include, common
metadata and prose are skipped.
Runs start fresh. Captured patches and edits already applied remain available after a failure.
Exit codes: 0 complete, 2 incomplete/error.
`

/** Internal overrides for runCli tests; omitted fields use production factories, paths and streams. */
interface CliDependencies {
  /** Factory for the CLI-owned client; runCli awaits disposal even after execution fails. */
  createClient?: (cwd: string, harness: HarnessSelection) => Promise<Client>
  /** Supply a validated graph for the canonical target, finishing exporter cleanup before resolving. */
  graphLoader?: GraphLoader
  /** Base directory for relative repository and repograph paths; defaults to process.cwd(). */
  cwd?: string
  /** CODEX_MODEL lookup; defaults to process.env. A supplied object replaces this lookup entirely;
   * it does not change the environment used to create the client or launch subprocesses. */
  env?: Record<string, string | undefined>
  /** Synchronous help/report sink; a thrown error enters CLI error reporting. */
  stdout?: (text: string) => void
  /** Synchronous progress/error sink; progress errors are recorded, error-reporting throws may reject runCli. */
  stderr?: (text: string) => void
}

/** Parse and validate runCli input before resource acquisition, returning help or a run command.
 * Reads the base cwd only for runs; invalid syntax, extra paths and blank checks throw. Help
 * bypasses run-only validation so it remains available even with an unusable target. */
function parseCliInput(args: string[], dependencies: CliDependencies) {
  const { values, positionals, tokens } = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'review-only': { type: 'boolean' },
    model: { type: 'string' }, repograph: { type: 'string' },
    'no-graph': { type: 'boolean' }, check: { type: 'string', multiple: true },
    'check-argv': { type: 'string', multiple: true },
    include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    harness: { type: 'string' }, 'harness-command': { type: 'string' },
    'harness-arg': { type: 'string', multiple: true }, 'harness-url': { type: 'string' },
    'read-permission-mode': { type: 'string' }, 'edit-permission-mode': { type: 'string' },
  } })
  if (values.help) return { kind: 'help' as const }
  if (positionals.length > 1) throw new Error('Expected at most one repository directory')
  const id = refactorHarnesses.find(id => id === (values.harness ?? 'codex'))
  if (!id) throw new Error(`Unknown harness: ${values.harness}. Available: ${refactorHarnesses.join(', ')}`)
  const harness: HarnessSelection = { id, command: values['harness-command'], args: values['harness-arg'], url: values['harness-url'] }
  validateHarness(harness)
  if (values['no-graph'] && (values.repograph !== undefined || dependencies.graphLoader)) {
    throw new Error('--no-graph cannot be combined with a graph exporter')
  }
  const checks: CheckCommand[] = []
  for (const token of tokens) {
    if (token.kind !== 'option') continue
    if (token.name === 'check') checks.push(token.value!)
    if (token.name === 'check-argv') checks.push(parseCheckArgv(token.value!))
  }
  validateChecks(checks, '--check')
  return {
    kind: 'refactor' as const, values, harness, checks: checks.length ? checks : undefined,
    cwd: resolve(dependencies.cwd ?? process.cwd(), positionals[0] ?? '.'),
  }
}

function validateHarness({ id, command, args, url }: HarnessSelection): void {
  if (url !== undefined && (id !== 'ahp' || command !== undefined || args !== undefined || !url.trim())) {
    throw new Error('--harness-url requires ahp and cannot be combined with stdio options')
  }
  if (command !== undefined && ((id !== 'ahp' && id !== 'acp') || !command.trim())) {
    throw new Error('--harness-command requires acp or ahp and a nonempty executable')
  }
  if (args !== undefined && command === undefined) throw new Error('--harness-arg requires --harness-command')
  if ((id === 'acp' || id === 'ahp') && command === undefined && url === undefined) {
    throw new Error(`Harness ${id} requires --harness-command${id === 'ahp' ? ' or --harness-url' : ''}`)
  }
}

/** Parse an executable and its literal arguments without interpreting shell syntax. */
function parseCheckArgv(value: string): CheckCommand {
  let argv: unknown
  try { argv = JSON.parse(value) } catch {}
  if (!Array.isArray(argv) || !argv.length || !argv.every(arg => typeof arg === 'string')) {
    throw new Error('--check-argv requires a JSON array of strings beginning with the executable')
  }
  const [executable, ...args] = argv as string[]
  return { executable: executable!, args }
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
  const { cwd, values, harness } = command
  const { stdout, stderr } = output
  const client = await (dependencies.createClient ?? createRefactorClient)(cwd, harness)
  let failed = false
  try {
    const permissions = harnessPermissions[harness.id]
    const report = await refactorCode({
      client, cwd, reviewOnly: values['review-only'],
      model: values.model ?? (harness.id === 'codex' ? (dependencies.env ?? process.env).CODEX_MODEL : undefined),
      readPermissionMode: values['read-permission-mode'] ?? permissions?.readPermissionMode,
      editPermissionMode: values['edit-permission-mode'] ?? permissions?.editPermissionMode,
      repographEntry: values.repograph === undefined ? undefined : resolve(dependencies.cwd ?? process.cwd(), values.repograph),
      graphLoader: dependencies.graphLoader, noGraph: values['no-graph'], checks: command.checks,
      include: values.include, exclude: values.exclude,
      /** Route orchestration progress to stderr so stdout remains a parseable report. */
      onProgress: event => stderr(`[refactor] ${event}\n`),
    })
    stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    return report.status === 'incomplete' ? 2 : 0
  } catch (cause) {
    failed = true
    throw cause
  }
  finally {
    try { await client.dispose() }
    catch (cause) {
      // An incomplete report is a returned result, not an exception: disposal is still primary.
      if (!failed) throw cause
      stderr(`anureo-refactor: cleanup failed: ${message(cause)}\n`)
    }
  }
}
