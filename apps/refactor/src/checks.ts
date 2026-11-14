// Discovers and executes ordered validation commands for changed refactor steps.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from './errors'
import { exec } from './process'
import type { CheckResult } from './results'

/** Configure validation after an applied patch. Strings go to the platform shell. Objects
 * launch the named executable directly with literal arguments, defaulting to no arguments. */
export type CheckCommand = string | { executable: string; args?: readonly string[] }

/** Reject a blank command or executable, or a NUL in a command, executable or literal argument.
 * refactorCode runs this before repository preflight and parseCliInput uses it before client
 * creation. Omitted and empty lists pass this check. Only omission allows script discovery. */
export function validateChecks(commands: readonly CheckCommand[] | undefined, label = 'check'): void {
  for (const command of commands ?? []) {
    const executable = typeof command === 'string' ? command : command.executable
    if (!executable.trim()) throw new Error(`${label} commands must be nonempty`)
    if (executable.includes('\0') || (typeof command !== 'string' && command.args?.some(arg => arg.includes('\0')))) {
      throw new Error(`${label} commands and arguments cannot contain NUL`)
    }
  }
}

/** Discover typecheck then test for refactorCode when checks are omitted outside review-only mode.
 * Includes only string-valued scripts in the target package.json. A packageManager declaration
 * starting with bun@, npm@, pnpm@ or yarn@ selects that runner; otherwise uses npm.
 * Reads no parent packages and starts no process.
 * Missing package.json yields no checks; malformed JSON and other filesystem errors reject. */
export async function defaultChecks(cwd: string): Promise<CheckCommand[]> {
  let pkg: { packageManager?: string; scripts?: Record<string, unknown> }
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const manager = /^(bun|npm|pnpm|yarn)@/.exec(pkg.packageManager ?? '')?.[1] ?? 'npm'
  return ['typecheck', 'test'].filter(name => typeof pkg.scripts?.[name] === 'string').map(name =>
    // Windows package managers other than Bun are commonly provided by .cmd shims.
    process.platform === 'win32' && manager !== 'bun'
      ? `${manager} run ${name}`
      : { executable: manager, args: ['run', name] },
  )
}

/** Execute validation commands serially, appending bounded output to the caller's results array.
 * integrateAgentWork awaits this after applying a patch and converts rejection into a failed step.
 * Commands may modify files or start other processes.
 * Resolves void after all checks; the first failed command is recorded before rejection and stops
 * later commands. Each process has a five-minute timeout and an eight-MiB
 * limit on each output stream. Reports concatenate stdout then stderr, followed by the error
 * message on failure, and retain only the final 4,000 characters. An empty command list resolves
 * without changing results; existing entries are retained. */
export async function runChecks(cwd: string, commands: readonly CheckCommand[], results: CheckResult[]): Promise<void> {
  const limits = { cwd, maxBuffer: 8 << 20, timeout: 300_000, windowsHide: true }
  for (const command of commands) {
    const display = typeof command === 'string' ? command : [command.executable, ...(command.args ?? [])]
      .map(arg => /^[\w./:-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')
    try {
      const { stdout, stderr } = typeof command === 'string'
        ? await exec(command, [], { ...limits, shell: true })
        : await exec(command.executable, [...command.args ?? []], limits)
      results.push({ command: display, status: 'passed', output: `${stdout}${stderr}`.slice(-4000) })
    } catch (cause) {
      const error = cause as { stdout?: string; stderr?: string }
      results.push({ command: display, status: 'failed', output: `${error.stdout ?? ''}${error.stderr ?? ''}\n${message(cause)}`.slice(-4000) })
      throw new Error(`Validation failed: ${display}`)
    }
  }
}
