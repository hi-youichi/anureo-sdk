// Admits CLI commands and owns the client used to execute them.
import { resolve } from 'node:path'
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import type { Client } from '@anureo/sdk'
import { validateChecks, type CheckCommand } from './checks'
import { createRefactorClient, harnessPermissions, refactorHarnesses, type HarnessSelection } from './client'
import { message } from './errors'
import type { GraphLoader } from './graph'
import { validateConcurrency, validateGraphOptions, type RefactorOptions } from './options'
import { refactorCode } from './refactor'
import { formatReport } from './report'

/** Run an installed CLI command with arguments after the executable path.
 * bin/anureo-refactor.ts awaits the result as its exit code. Returns 0 for help or completion
 * and 2 for incomplete runs or caught argument, run, output or cleanup failures.
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
  --concurrency <number>  Maximum simultaneous module tasks (default: all modules)
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
  /** Environment for the fallback CODEX_MODEL lookup. Omit to read process.env.
   * Client creation and subprocess launch still use the process environment. */
  env?: Record<string, string | undefined>
  /** Synchronous help/report sink; a thrown error enters CLI error reporting. */
  stdout?: (text: string) => void
  /** Synchronous progress/error sink; progress errors are recorded, error-reporting throws may reject runCli. */
  stderr?: (text: string) => void
}

const cliOptions = {
  help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'review-only': { type: 'boolean' },
  model: { type: 'string' }, repograph: { type: 'string' }, concurrency: { type: 'string' },
  'no-graph': { type: 'boolean' }, check: { type: 'string', multiple: true },
  'check-argv': { type: 'string', multiple: true },
  include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
  harness: { type: 'string' }, 'harness-command': { type: 'string' },
  'harness-arg': { type: 'string', multiple: true }, 'harness-url': { type: 'string' },
  'read-permission-mode': { type: 'string' }, 'edit-permission-mode': { type: 'string' },
} as const satisfies ParseArgsOptionsConfig

/** Parse strict option syntax for runCli. Help bypasses run-only admission and path resolution.
 * For runs, throw on invalid options or extra paths before runCli acquires a client. */
function parseCliInput(args: string[], dependencies: CliDependencies) {
  const { values, positionals, tokens } = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: cliOptions })
  if (values.help) return { kind: 'help' as const }
  if (positionals.length > 1) throw new Error('Expected at most one repository directory')
  const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency)
  validateConcurrency(concurrency, '--concurrency')
  const requestedHarness = values.harness ?? 'codex'
  const id = refactorHarnesses.find(id => id === requestedHarness)
  if (!id) throw new Error(`Unknown harness: ${values.harness}. Available: ${refactorHarnesses.join(', ')}`)
  const harness: HarnessSelection = { id, command: values['harness-command'], args: values['harness-arg'], url: values['harness-url'] }
  validateHarness(harness)
  validateGraphOptions(values['no-graph'], values.repograph !== undefined || Boolean(dependencies.graphLoader), '--no-graph')
  return {
    kind: 'refactor' as const, values, harness, concurrency, checks: parseChecks(tokens),
    cwd: resolve(dependencies.cwd ?? process.cwd(), positionals[0] ?? '.'),
  }
}

type CliTokens = ReturnType<typeof parseArgs<{ tokens: true; options: typeof cliOptions; allowPositionals: true }>>['tokens']

/** Read check flags in token order so shell commands and argv commands can be interleaved.
 * Throw on malformed argv or invalid commands. Return undefined when the CLI should discover checks. */
function parseChecks(tokens: Readonly<CliTokens>): CheckCommand[] | undefined {
  const checks: CheckCommand[] = []
  for (const token of tokens) {
    if (token.kind !== 'option') continue
    if (token.name === 'check') checks.push(token.value)
    if (token.name === 'check-argv') checks.push(parseCheckArgv(token.value))
  }
  validateChecks(checks, '--check')
  return checks.length ? checks : undefined
}

/** Enforce CLI transport admission before passing the selection to the client factory.
 * ACP requires stdio, and AHP requires stdio or a WebSocket URL. Invalid combinations throw. */
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

/** Decode an argv check without interpreting shell syntax. Throw on invalid JSON or array shape.
 * parseChecks validates the executable and arguments after decoding all argv flags. */
function parseCheckArgv(value: string): CheckCommand {
  let argv: unknown
  try { argv = JSON.parse(value) } catch {}
  const [executable, ...args] = Array.isArray(argv) ? argv : []
  if (typeof executable !== 'string' || !args.every(arg => typeof arg === 'string')) {
    throw new Error('--check-argv requires a JSON array of strings beginning with the executable')
  }
  return { executable, args }
}

/** Validated execution input; help commands cannot acquire a client. */
type RefactorCommand = Extract<ReturnType<typeof parseCliInput>, { kind: 'refactor' }>

/** Output callbacks selected once by runCli and shared by report, progress and cleanup paths. */
interface CliOutput {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

/** Run a validated command for runCli, print its report and return 0 for completion or 2 for an
 * incomplete run. Acquire a client and await disposal after orchestration and report delivery.
 * A disposal error rejects after a returned report, including an incomplete report. If execution
 * throws, report a disposal error separately and preserve the execution error when that sink succeeds. */
async function executeRefactor(command: RefactorCommand, dependencies: CliDependencies, output: CliOutput): Promise<number> {
  const { stdout, stderr } = output
  const client = await (dependencies.createClient ?? createRefactorClient)(command.cwd, command.harness)
  let executionThrew = false
  try {
    const report = await refactorCode(resolveRunOptions({ command, dependencies, client, stderr }))
    stdout(command.values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    return report.status === 'incomplete' ? 2 : 0
  } catch (cause) {
    executionThrew = true
    throw cause
  } finally {
    try { await client.dispose() }
    catch (cause) {
      if (!executionThrew) throw cause
      stderr(`anureo-refactor: cleanup failed: ${message(cause)}\n`)
    }
  }
}

/** Resolve CLI defaults just before executeRefactor starts orchestration with an acquired client.
 * Relative exporter paths use the invocation directory. An option resolution throw follows the
 * same client cleanup path as a failed run. */
function resolveRunOptions({ command, dependencies, client, stderr }: {
  command: RefactorCommand
  dependencies: CliDependencies
  client: Client
  stderr: CliOutput['stderr']
}): RefactorOptions {
  const { cwd, values, harness } = command
  const permissions = harnessPermissions[harness.id]
  return {
    client, cwd, concurrency: command.concurrency, reviewOnly: values['review-only'],
    model: values.model ?? (harness.id === 'codex' ? (dependencies.env ?? process.env).CODEX_MODEL : undefined),
    readPermissionMode: values['read-permission-mode'] ?? permissions?.readPermissionMode,
    editPermissionMode: values['edit-permission-mode'] ?? permissions?.editPermissionMode,
    repographEntry: values.repograph === undefined ? undefined : resolve(dependencies.cwd ?? process.cwd(), values.repograph),
    graphLoader: dependencies.graphLoader, noGraph: values['no-graph'], checks: command.checks,
    include: values.include, exclude: values.exclude,
    // Keep progress on stderr so stdout can be consumed as a single JSON document.
    onProgress: event => stderr(`[refactor] ${event}\n`),
  }
}
