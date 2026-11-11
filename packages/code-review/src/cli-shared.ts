import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createClient, type Client } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { errorText } from './io'

export function outside(path: string) { return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`) }
export function repoPath(path: string) { return path.split(sep).join('/') }
export const progress = (message: string) => console.error(`[${new Date().toISOString()}] ${message}`)

async function outputLocation(path: string): Promise<string> {
  const suffix: string[] = []
  let existing = path
  while (true) {
    try {
      if (!(await lstat(existing)).isDirectory()) throw new Error(`Output must be a directory: ${existing}`)
      return resolve(await realpath(existing), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      suffix.unshift(relative(dirname(existing), existing))
      existing = dirname(existing)
    }
  }
}

export async function chooseOutput(cwd: string, input: string | undefined, kind: 'reviews' | 'fixes') {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
  const outputDir = await outputLocation(resolve(input ?? join(cwd, '.anureo', kind, runId)))
  if (!outside(relative(outputDir, cwd))) throw new Error('Output cannot be the project directory or its ancestor')
  const entries = await readdir(outputDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  if (entries.length) throw new Error('Output directory must be empty; choose a new directory')
  const path = relative(cwd, outputDir)
  return { outputDir, outputExclusions: outside(path) ? [] : [repoPath(path)] }
}

export async function withClient<T>(cwd: string, maxOutputBytes: number, editing: boolean,
  run: (client: Client, shouldStop: () => boolean) => Promise<T>): Promise<T> {
  const client = await createClient({
    adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd,
      ...(editing ? { args: ['app-server', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'] } : {}),
    }),
    identity: { adapterId: 'codex', runtimeConfigId: editing ? 'code-review-fix' : 'code-review' },
    limits: { maxResultBytes: maxOutputBytes },
  })
  let stopping = false
  let cleanup: Promise<void> | undefined
  const stop = () => {
    stopping = true
    process.exitCode = 130
    cleanup ??= client.dispose()
    void cleanup.catch(error => console.error(`Cleanup: ${errorText(error)}`))
  }
  const signals: EventEmitter = process
  signals.once('SIGINT', stop)
  signals.once('SIGTERM', stop)
  let value: T | undefined
  let failure: unknown
  let failed = false
  try { value = await run(client, () => stopping) }
  catch (error) { failed = true; failure = error }
  finally {
    signals.removeListener('SIGINT', stop)
    signals.removeListener('SIGTERM', stop)
    try { await (cleanup ??= client.dispose()) }
    catch (error) { failure = failed ? new AggregateError([failure, error], 'Operation and cleanup failed') : error; failed = true }
  }
  if (failed) throw failure
  return value as T
}
