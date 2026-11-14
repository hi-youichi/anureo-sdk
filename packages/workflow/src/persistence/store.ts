import type { WorkflowOptions } from '../workflow-types'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { atomicPublish, syncDirectory } from './atomic'
import { canonicalJson, digest, jsonCopy, type JsonValue } from './json'
import { AgentJournal } from './journal'
import { invalidCheckpoint, record, runIdSchema, type Manifest } from './records'
import { loadSourceJournal } from './replay'

/** Internal identity saved before workflow enters its body. */
export interface RunIdentity {
  runId: string
  /** Canonical parent directory, not the run's own subdirectory. */
  directory: string
  name: string
  revision: string
  /** Isolated JSON snapshot; workflow separately freezes the copy exposed to its body. */
  input: JsonValue
}

/** Safe failure metadata supplied by storedFailure when workflow aborts; excludes diagnostics. */
export interface StoredFailure {
  code: string
  retryable: boolean
  /** The failure left execution's outcome uncertain. */
  outcomeUnknown: boolean
  /** Resource release failed even if execution itself had a known outcome. */
  cleanupFailed: boolean
}

/** Internal storage ownership returned to workflow. Drain agent work before finish/abort and
 * always await close in finally; manifest operations serialize but journal draining is caller-owned. */
export interface RunHandle {
  readonly identity: RunIdentity
  readonly journal: AgentJournal
  /** Publish result.json before the terminal manifest; resolves after both publications.
   * Publication failures reject and may leave a result or manifest already replaced. */
  finish(status: 'completed' | 'incomplete', result: JsonValue): Promise<void>
  /** Publish a failed manifest without deleting any previously written result; does not release the lock. */
  abort(failure: StoredFailure): Promise<void>
  /** Wait for queued manifests, then release the owned writer lock and close its descriptor.
   * Sequential repeats are no-ops, including after rejection; callers must not race closure with work. */
  close(): Promise<void>
}

/** Create a fresh file-backed run for workflow, publishing its journal and running manifest
 * before returning. An optional inactive source supplies replay events, never the final result.
 * The returned handle owns the writer lock and must be closed after registered agent work drains.
 * Invalid options, overlapping/reused runs and invalid/active/incompatible sources reject with
 * their SDK errors; other I/O failures become WORKFLOW_STORAGE_FAILED. Initialization failures
 * attempt to release any acquired lock; partially published run files remain and must not be reused. */
export async function openFileRun(
  options: WorkflowOptions<JsonValue> & { runId: string },
): Promise<RunHandle> {
  validateRunOptions(options)
  try {
    const prepared = await prepareRunStorage(options)
    return await initializeLockedRun({ options, prepared })
  } catch (cause) { throw storageError(cause) }
}

type FileRunOptions = WorkflowOptions<JsonValue> & { runId: string }
type SourceRun = { directory: string; runId: string }

/** Storage coordinates prepared before claiming writer ownership. */
interface PreparedRun {
  directory: string
  path: string
  input: JsonValue
  source: SourceRun | null
}

/** Own the open lock descriptor and serialize manifest transitions until workflow releases it. */
class FileRunHandle implements RunHandle {
  readonly identity: RunIdentity
  readonly journal: AgentJournal

  /** Take ownership only after initial publication; initialization retains rollback responsibility. */
  constructor({ identity, path, lock, manifest, journal }: {
    identity: RunIdentity
    path: string
    lock: FileHandle
    manifest: Manifest
    journal: AgentJournal
  }) {
    this.identity = identity
    this.path = path
    this.lock = lock
    this.manifest = manifest
    this.journal = journal
  }

  /** completeRun calls after draining agents; commit the result before its manifest digest. */
  async finish(status: 'completed' | 'incomplete', result: JsonValue): Promise<void> {
    await this.updateManifest(async () => {
      await atomicPublish(join(this.path, 'result.json'), result)
      await this.publishManifest({ status, resultDigest: digest(result), failure: null })
    })
  }

  /** abortRun records failure after draining; an earlier result file is ignored by failed-run replay. */
  async abort(failure: StoredFailure): Promise<void> {
    await this.updateManifest(async () => {
      await this.publishManifest({ status: 'failed', resultDigest: null, failure })
    })
  }

  /** workflow's finally releases ownership even after failed publication; earlier queue rejections
   * have already reached their callers and do not prevent the lock-release attempt. */
  async close(): Promise<void> {
    if (this.closed) return
    try { await this.manifestQueue.catch(() => {}); await releaseLock(join(this.path, 'writer.lock'), this.lock) }
    catch (cause) { throw storageError(cause) }
    finally { this.closed = true }
  }

  private closed = false
  private manifestQueue: Promise<void> = Promise.resolve()
  private readonly path: string
  private readonly lock: FileHandle
  private manifest: Manifest

  /** Run finish/abort's publication callback in order, checking closure when it actually starts.
   * A rejected predecessor does not poison later abort publication; non-SDK failures are normalized. */
  private updateManifest(update: () => Promise<void>): Promise<void> {
    const next = this.manifestQueue.catch(() => {}).then(async () => {
      if (this.closed) throw new HarnessSdkError('WORKFLOW_CLOSED')
      try { await update() } catch (cause) { throw storageError(cause) }
    })
    this.manifestQueue = next
    return next
  }

  /** Recompute the digest from payload only for every terminal transition, then publish it.
   * Keep the in-memory transition even if publication rejects, as abort may follow a failed finish. */
  private async publishManifest(update: Pick<Manifest, 'status' | 'resultDigest' | 'failure'>): Promise<void> {
    const { recordDigest: _, ...payload } = this.manifest
    this.manifest = record({ ...payload, ...update })
    await atomicPublish(join(this.path, 'run.json'), this.manifest)
  }
}

/** Reject malformed target identity before copying input or touching storage. */
function validateRunOptions(options: FileRunOptions): void {
  if (!runIdSchema.safeParse(options.runId).success || typeof options.name !== 'string' || !options.name
    || typeof options.revision !== 'string' || !options.revision || typeof options.directory !== 'string' || !options.directory) {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
}

/** Snapshot input, resolve parent/source paths, and create a real target directory before locking.
 * Only a newly created target needs a parent flush; an existing target is checked under its lock. */
async function prepareRunStorage(options: FileRunOptions): Promise<PreparedRun> {
  const input = jsonCopy(options.input)
  await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 })
  const directory = await realpath(resolve(options.directory))
  const path = join(directory, options.runId)
  const source = await resolveSourceRun({ options, directory, path })
  try { await mkdir(path, { mode: 0o700 }); await syncDirectory(directory) }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
  if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
  return { directory, path, input, source }
}

/** Resolve optional replay coordinates before target creation so overlapping source/target trees
 * reject before a writer claim. A string uses the target's canonical parent directory. */
async function resolveSourceRun({ options, directory, path }: {
  options: FileRunOptions
  directory: string
  path: string
}): Promise<SourceRun | null> {
  if (options.resumeFrom === undefined) return null
  const reference = typeof options.resumeFrom === 'string'
    ? { directory, runId: options.resumeFrom } : options.resumeFrom
  if (!reference || !runIdSchema.safeParse(reference.runId).success || typeof reference.directory !== 'string') {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
  const source = { directory: await realpath(resolve(reference.directory)), runId: reference.runId }
  if (overlaps(path, join(source.directory, source.runId))) throw new HarnessSdkError('WORKFLOW_OVERLAPPING_RUNS')
  return source
}

/** Exclusively claim and initialize the lock before inspecting target contents or source records.
 * Transfer ownership only on successful publication; rollback also covers partial lock writes.
 * Cleanup failure takes precedence as WORKFLOW_STORAGE_FAILED; other failures reach openFileRun. */
async function initializeLockedRun({ options, prepared }: {
  options: FileRunOptions
  prepared: PreparedRun
}): Promise<RunHandle> {
  const lockPath = join(prepared.path, 'writer.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(cause => {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new HarnessSdkError('WORKFLOW_RUN_EXISTS')
    throw cause
  })
  try {
    await lock.writeFile(`${canonicalJson(record({ checkpointFormatVersion: 2, token: randomUUID(),
      hostname: hostname(), pid: process.pid, createdAt: new Date().toISOString() }))}\n`)
    await lock.sync()
    if ((await readdir(prepared.path)).some(name => name !== 'writer.lock')) throw new HarnessSdkError('WORKFLOW_RUN_EXISTS')
    return await publishInitialRun({ options, prepared, lock })
  } catch (cause) {
    try { await releaseLock(lockPath, lock) }
    catch { throw new HarnessSdkError('WORKFLOW_STORAGE_FAILED') }
    throw cause
  }
}

/** Validate replay under the target lock, publish a self-contained journal before its manifest,
 * then hand the descriptor to FileRunHandle. Failures leave lock cleanup to initializeLockedRun. */
async function publishInitialRun({ options, prepared, lock }: {
  options: FileRunOptions
  prepared: PreparedRun
  lock: FileHandle
}): Promise<RunHandle> {
  const { directory, path, input, source } = prepared
  const inherited = source
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
  return new FileRunHandle({ identity, path, lock, manifest, journal })
}

/** Preserve deliberate SDK failures while hiding filesystem-specific errors from workflow consumers. */
function storageError(cause: unknown): HarnessSdkError {
  if (cause instanceof HarnessSdkError) return cause
  return new HarnessSdkError('WORKFLOW_STORAGE_FAILED')
}

/** Reject equal or nested run trees in either direction so target writes cannot overlap replay input. */
function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child)
    return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }
  return inside(a, b) || inside(b, a)
}

/** Unlink only the inode held by this instance, including partial initialization, then flush the
 * parent and always close the descriptor. Ownership loss rejects without removing another lock. */
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
