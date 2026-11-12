import type { WorkflowOptions } from '../workflow-types'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { atomicPublish, syncDirectory } from './atomic'
import { canonicalJson, digest, jsonCopy, type JsonValue } from './json'
import { AgentJournal, type JournalEvent } from './journal'
import { invalidCheckpoint, record, runIdSchema, type Manifest } from './records'
import { loadSourceJournal } from './replay'

export interface RunIdentity {
  runId: string
  directory: string
  name: string
  revision: string
  input: JsonValue
}

export interface StoredFailure {
  code: string
  retryable: boolean
  outcomeUnknown: boolean
  cleanupFailed: boolean
}

export interface RunHandle {
  readonly identity: RunIdentity
  readonly journal: AgentJournal
  finish(status: 'completed' | 'incomplete', result: JsonValue): Promise<void>
  abort(failure: StoredFailure): Promise<void>
  close(): Promise<void>
}

function storageError(cause: unknown): HarnessSdkError {
  if (cause instanceof HarnessSdkError) return cause
  return new HarnessSdkError('WORKFLOW_STORAGE_FAILED')
}

function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child)
    return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }
  return inside(a, b) || inside(b, a)
}

/** Ownership is tied to the inode held by this instance, including partial initialization. */
async function releaseLock(path: string, handle: FileHandle) {
  try {
    const held = await handle.stat()
    const actual = await lstat(path)
    if (actual.dev !== held.dev || actual.ino !== held.ino || !actual.isFile()) {
      throw new HarnessSdkError('WORKFLOW_LOCK_OWNERSHIP_LOST')
    }
    await unlink(path)
    await syncDirectory(dirname(path))
  } finally { await handle.close() }
}

class FileRunHandle implements RunHandle {
  private closed = false
  private manifestQueue: Promise<void> = Promise.resolve()

  constructor(readonly identity: RunIdentity, private readonly path: string,
    private readonly lock: FileHandle, private manifest: Manifest,
    readonly journal: AgentJournal) {}

  private async io<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new HarnessSdkError('WORKFLOW_CLOSED')
    try { return await operation() } catch (cause) { throw storageError(cause) }
  }

  private updateManifest(update: () => Promise<void>): Promise<void> {
    const next = this.manifestQueue.catch(() => {}).then(() => this.io(update))
    this.manifestQueue = next
    return next
  }

  async finish(status: 'completed' | 'incomplete', result: JsonValue): Promise<void> {
    await this.updateManifest(async () => {
      await atomicPublish(join(this.path, 'result.json'), result)
      const { recordDigest: _, ...payload } = this.manifest
      this.manifest = record({ ...payload, status, resultDigest: digest(result), failure: null })
      await atomicPublish(join(this.path, 'run.json'), this.manifest)
    })
  }

  async abort(failure: StoredFailure): Promise<void> {
    await this.updateManifest(async () => {
      const { recordDigest: _, ...payload } = this.manifest
      this.manifest = record({ ...payload, status: 'failed', resultDigest: null, failure })
      await atomicPublish(join(this.path, 'run.json'), this.manifest)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    try { await this.manifestQueue.catch(() => {}); await releaseLock(join(this.path, 'writer.lock'), this.lock) }
    catch (cause) { throw storageError(cause) }
    finally { this.closed = true }
  }
}

export async function openFileRun(
  options: WorkflowOptions<JsonValue> & { runId: string },
): Promise<RunHandle> {
  if (!runIdSchema.safeParse(options.runId).success || typeof options.name !== 'string' || !options.name
    || typeof options.revision !== 'string' || !options.revision || typeof options.directory !== 'string' || !options.directory) {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
  let lock: FileHandle | undefined
  let lockPath: string | undefined
  try {
    const input = jsonCopy(options.input)
    await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 })
    const directory = await realpath(resolve(options.directory))
    const path = join(directory, options.runId)
    let source: { directory: string; runId: string } | null = null
    if (options.resumeFrom !== undefined) {
      const reference = typeof options.resumeFrom === 'string'
        ? { directory, runId: options.resumeFrom } : options.resumeFrom
      if (!reference || !runIdSchema.safeParse(reference.runId).success || typeof reference.directory !== 'string') {
        throw new HarnessSdkError('INVALID_PARAMS')
      }
      source = { directory: await realpath(resolve(reference.directory)), runId: reference.runId }
      if (overlaps(path, join(source.directory, source.runId))) throw new HarnessSdkError('WORKFLOW_OVERLAPPING_RUNS')
    }
    try { await mkdir(path, { mode: 0o700 }); await syncDirectory(directory) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
    if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
    lockPath = join(path, 'writer.lock')
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new HarnessSdkError('WORKFLOW_RUN_EXISTS')
      throw cause
    }
    await lock.writeFile(`${canonicalJson(record({ checkpointFormatVersion: 2, token: randomUUID(),
      hostname: hostname(), pid: process.pid, createdAt: new Date().toISOString() }))}\n`)
    await lock.sync()
    if ((await readdir(path)).some(name => name !== 'writer.lock')) throw new HarnessSdkError('WORKFLOW_RUN_EXISTS')
    const inherited: JournalEvent[] = source
      ? await loadSourceJournal(join(source.directory, source.runId), {
        name: options.name, revision: options.revision, runId: source.runId,
      })
      : []
    const journal = new AgentJournal(join(path, 'journal.json'), inherited)
    await atomicPublish(join(path, 'journal.json'), [...inherited])
    const identity = { runId: options.runId, directory, name: options.name, revision: options.revision, input }
    const manifest: Manifest = record({ checkpointFormatVersion: 2,
      identity, createdAt: new Date().toISOString(), resumedFrom: source,
      status: 'running', resultDigest: null, failure: null })
    await atomicPublish(join(path, 'run.json'), manifest)
    return new FileRunHandle(identity, path, lock, manifest, journal)
  } catch (cause) {
    if (lock && lockPath) {
      try { await releaseLock(lockPath, lock) }
      catch { throw new HarnessSdkError('WORKFLOW_STORAGE_FAILED') }
    }
    throw storageError(cause)
  }
}
