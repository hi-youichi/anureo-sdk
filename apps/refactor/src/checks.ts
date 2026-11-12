// Discovers and executes ordered validation gates; it must not schedule agents or publish reports.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { message } from './errors'
import { exec } from './process'
import type { CheckResult } from './results'

/** Validate commands for CLI/library entry points before resource acquisition, returning void.
 * Throws a labeled error for any blank command; undefined and empty lists are allowed.
 * Does not mutate input, read files or start processes. */
export function validateChecks(commands: readonly string[] | undefined, label = 'check'): void {
  if (commands?.some(command => !command.trim())) throw new Error(`${label} commands must be nonempty`)
}

/** Read the target's package scripts for orchestration, returning typecheck before test.
 * Uses a recognized declared package manager or npm; reads no parent packages and starts no process.
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
 * Orchestration calls this after edits and awaits completion; commands may modify files or start
 * other processes. Resolves void after all checks; the first failed command is recorded before
 * rejection and stops later commands. Each process has a five-minute timeout and an eight-MiB
 * output limit; only the final 4,000 characters are retained for report size. */
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
