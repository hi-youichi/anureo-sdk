// Discovers and executes ordered validation commands for changed refactor steps.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from './errors'
import { checkoutEnvironment } from './git'
import { exec } from './process'
import type { CheckResult } from './results'

/** Configure validation in the agent checkout. Strings go to the platform shell. Objects
 * launch the named executable directly with literal arguments, defaulting to no arguments. */
export type CheckCommand = string | { executable: string; args?: readonly string[] }

/** Reject a blank command or executable, or a NUL in a command, executable or literal argument.
 * refactorCode runs this before repository preflight and parseCliInput uses it before client
 * creation. Omitted and empty lists pass this check. Only omission allows script discovery. */
export function validateChecks(commands: readonly CheckCommand[] | undefined, label = 'check'): void {
  const issues: string[] = []
  let hasBlankCommand = false
  for (const [index, command] of (commands ?? []).entries()) {
    const location = `${label} #${index + 1}`
    const executable = typeof command === 'string' ? command : command.executable
    if (!executable.trim()) {
      hasBlankCommand = true
      issues.push(`${location} is blank`)
    }
    if (executable.includes('\0')) issues.push(`${location} contains NUL`)
    if (typeof command !== 'string') {
      for (const [position, arg] of (command.args ?? []).entries()) {
        if (arg.includes('\0')) issues.push(`${location} argument #${position + 1} contains NUL`)
      }
    }
  }
  if (hasBlankCommand) issues.unshift(`${label} commands must be nonempty`)
  if (issues.length) throw new Error(issues.join('\n'))
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
 * runAgentWork awaits this before merging and records rejection as a failed step.
 * Commands may modify files or start other processes.
 * Resolves void after all checks; the first failed command is recorded before rejection and stops
 * later commands. Each process has a fifteen-minute timeout and an eight-MiB
 * limit on each output stream. Reports concatenate stdout then stderr, followed by the error
 * message on failure, and retain only the final 4,000 characters. An empty command list resolves
 * without changing results; existing entries are retained. */
export async function runChecks(cwd: string, commands: readonly CheckCommand[], results: CheckResult[]): Promise<void> {
  const limits = { cwd, env: checkoutEnvironment(), maxBuffer: 8 << 20, timeout: 900_000, killSignal: 'SIGKILL' as const, windowsHide: true }
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
