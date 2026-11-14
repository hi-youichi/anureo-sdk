// Discovers and executes ordered shell validation gates for changed refactor steps.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from './errors'
import { exec } from './process'
import type { CheckResult } from './results'

/** Reject blank commands before resource acquisition in refactorCode and CLI parseCliInput.
 * Throws a labeled error for any blank command; undefined and empty lists are allowed.
 * Does not mutate input, read files or start processes. */
export function validateChecks(commands: readonly string[] | undefined, label = 'check'): void {
  if (commands?.some(command => !command.trim())) throw new Error(`${label} commands must be nonempty`)
}

/** Discover typecheck then test for refactorCode when checks are omitted outside review-only mode.
 * Includes only string-valued scripts in the target package.json. A packageManager declaration
 * starting with bun@, npm@, pnpm@ or yarn@ selects that runner; otherwise uses npm.
 * Reads no parent packages and starts no process.
 * Missing package.json yields no checks; malformed JSON and other filesystem errors reject. */
export async function defaultChecks(cwd: string): Promise<string[]> {
  let pkg: { packageManager?: string; scripts?: Record<string, unknown> }
  try { pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const manager = /^(bun|npm|pnpm|yarn)@/.exec(pkg.packageManager ?? '')?.[1] ?? 'npm'
  return ['typecheck', 'test'].filter(name => typeof pkg.scripts?.[name] === 'string').map(name => `${manager} run ${name}`)
}

/** Execute explicit shell commands serially, appending bounded output to the caller's results array.
 * runStep awaits this after observed edits outside review-only mode and converts rejection into
 * a failed step, stopping later phases. Commands may modify files or start other processes.
 * Resolves void after all checks; the first failed command is recorded before rejection and stops
 * later commands. Each process has a five-minute timeout and an eight-MiB
 * limit on each output stream. Reports concatenate stdout then stderr, followed by the error
 * message on failure, and retain only the final 4,000 characters. An empty command list resolves
 * without changing results; existing entries are retained. */
export async function runChecks(cwd: string, commands: readonly string[], results: CheckResult[]): Promise<void> {
  for (const command of commands) {
    try {
      const { stdout, stderr } = await exec('sh', ['-c', command], { cwd, maxBuffer: 8 << 20, timeout: 300_000 })
      results.push({ command, status: 'passed', output: `${stdout}${stderr}`.slice(-4000) })
    } catch (cause) {
      const error = cause as { stdout?: string; stderr?: string }
      results.push({ command, status: 'failed', output: `${error.stdout ?? ''}${error.stderr ?? ''}\n${message(cause)}`.slice(-4000) })
      throw new Error(`Validation failed: ${command}`)
    }
  }
}
