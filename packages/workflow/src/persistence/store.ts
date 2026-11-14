import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import type { WorkflowOptions } from '../workflow-types'
import { atomicPublish, storageError, syncDirectory } from './checkpoint-files'
import { canonicalJson, digest, jsonCopy, type JsonValue } from './json'
import { AgentJournal } from './journal'
import { checkpointFormat, invalidCheckpoint, record, runIdSchema, type Manifest, type StoredFailure } from './records'
import { loadSourceJournal } from './replay'

/** Internal identity saved before workflow enters its body. */
export interface RunIdentity {
  /** Validated basename of the run within directory. */
  runId: string
  /** Canonical parent containing the run's subdirectory. */
  directory: string
  /** Workflow name used to match a compatible source run. */
  name: string
  /** Application revision used to match a compatible source run. */
  revision: string
  /** Isolated persistence snapshot. The body receives its own frozen copy from prepareRun. */
  input: JsonValue
}

/** Internal storage ownership returned to workflow. Drain agent work before finish or abort,
 * and always await close in finally. The handle serializes finish and abort. AgentJournal
 * serializes its own appends. */
export interface RunHandle {
  /** Provides the canonical storage directory for workflow's error details. */
  readonly identity: RunIdentity
  /** Installed by completeRun as the journal for agent calls in the body. */
  readonly journal: AgentJournal
  /** Publish result.json before the terminal manifest and resolve after both publications.
   * A rejection may leave a result or manifest already replaced. A queued call that starts
   * after closure rejects with WORKFLOW_CLOSED. */
  finish(status: 'completed' | 'incomplete', result: JsonValue): Promise<void>
  /** Publish a failed manifest and keep any earlier result file and the writer lock.
   * Publication failures reject, as does a queued call that starts after closure. */
  abort(failure: StoredFailure): Promise<void>
  /** Wait for queued manifests, then release the owned writer lock and close its descriptor.
   * Lock-release failures reject. Sequential repeats are no-ops, including after rejection.
   * Callers must finish scheduling work before closure. */
  close(): Promise<void>
}

/** Create a fresh file-backed run for workflow, publishing its journal and running manifest
 * before returning. An optional inactive source supplies replay events, never the final result.
 * The returned handle owns the writer lock and must be closed after registered agent work drains.
 * SDK errors propagate unless lock rollback fails. Rollback failures and otherwise unclassified
 * I/O failures reject as WORKFLOW_STORAGE_FAILED. If publication left run files behind,
 * a later attempt on the same target rejects with WORKFLOW_RUN_EXISTS. */
export async function openFileRun(options: FileRunOptions): Promise<RunHandle> {
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

  /** completeRun awaits both publications before returning the body result to workflow.
   * The manifest comes last so it refers to an already published result. */
  async finish(status: 'completed' | 'incomplete', result: JsonValue): Promise<void> {
    await this.updateManifest(async () => {
      await atomicPublish(join(this.path, checkpointFormat.result), result)
      await this.publishManifest({ status, resultDigest: digest(result), failure: null })
    })
  }

  /** abortRun awaits this after draining. Replay treats the failed manifest as authoritative
   * even if finish left an earlier result file. */
  async abort(failure: StoredFailure): Promise<void> {
    await this.updateManifest(async () => {
      await this.publishManifest({ status: 'failed', resultDigest: null, failure })
    })
  }

  /** workflow awaits this in finally and records any rejection as a storage failure.
   * A failed publication already reached finish or abort, so proceed with lock release. */
  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.manifestQueue.catch(() => {})
      await releaseLock(join(this.path, checkpointFormat.lock), this.lock)
    } catch (cause) {
      throw storageError(cause)
    } finally {
      this.closed = true
    }
  }

  readonly identity: RunIdentity
  readonly journal: AgentJournal

  private closed = false
  private manifestQueue: Promise<void> = Promise.resolve()
  private readonly path: string
  private readonly lock: FileHandle
  private manifest: Manifest

  /** Run finish/abort's publication callback in order, checking closure when it actually starts.
   * A rejected predecessor still permits abort publication. Non-SDK failures are normalized. */
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
    await atomicPublish(join(this.path, checkpointFormat.manifest), this.manifest)
  }
}

/** Throw INVALID_PARAMS for malformed target identity before copying input or touching storage. */
function validateRunOptions(options: FileRunOptions): void {
  if (!runIdSchema.safeParse(options.runId).success || typeof options.name !== 'string' || !options.name
    || typeof options.revision !== 'string' || !options.revision || typeof options.directory !== 'string' || !options.directory) {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
}

/** Snapshot input, resolve parent/source paths, and create a real target directory before locking.
 * Flush the parent when creating the target. Initialization checks existing contents under the lock. */
async function prepareRunStorage(options: FileRunOptions): Promise<PreparedRun> {
  const input = jsonCopy(options.input)
  await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 })
  const directory = await realpath(resolve(options.directory))
  const path = join(directory, options.runId)
  const source = await resolveSourceRun({ resumeFrom: options.resumeFrom, directory, path })
  try {
    await mkdir(path, { mode: 0o700 })
    await syncDirectory(directory)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
  }
  if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
  return { directory, path, input, source }
}

/** Resolve optional replay coordinates before target creation so overlapping source/target trees
 * reject before a writer claim. Omission selects fresh execution. A string uses the target's
 * canonical parent, while an object supplies its own parent to resolve. */
async function resolveSourceRun({ resumeFrom, directory, path }: {
  resumeFrom: FileRunOptions['resumeFrom']
  directory: string
  path: string
}): Promise<SourceRun | null> {
  if (resumeFrom === undefined) return null
  const reference = typeof resumeFrom === 'string' ? { directory, runId: resumeFrom } : resumeFrom
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
  const lockPath = join(prepared.path, checkpointFormat.lock)
  const lock = await open(lockPath, 'wx', 0o600).catch(cause => {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new HarnessSdkError('WORKFLOW_RUN_EXISTS')
    throw cause
  })
  try {
    await writeWriterClaim(lock)
    if ((await readdir(prepared.path)).some(name => name !== checkpointFormat.lock)) {
      throw new HarnessSdkError('WORKFLOW_RUN_EXISTS')
    }
    return await publishInitialRun({ options, prepared, lock })
  } catch (cause) {
    try { await releaseLock(lockPath, lock) }
    catch { throw new HarnessSdkError('WORKFLOW_STORAGE_FAILED') }
    throw cause
  }
}

/** Write and flush the claim on the exclusively opened descriptor. Replay validates this
 * record before probing its writer, and initializeLockedRun owns rollback on rejection. */
async function writeWriterClaim(lock: FileHandle): Promise<void> {
  const claim = record({
    checkpointFormatVersion: checkpointFormat.version,
    token: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })
  await lock.writeFile(`${canonicalJson(claim)}\n`)
  await lock.sync()
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
  const journalPath = join(path, checkpointFormat.journal)
  const journal = new AgentJournal(journalPath, inherited)
  await atomicPublish(journalPath, [...inherited])
  const identity = { runId: options.runId, directory, name: options.name, revision: options.revision, input }
  const manifest: Manifest = record({
    checkpointFormatVersion: checkpointFormat.version,
    identity,
    createdAt: new Date().toISOString(),
    resumedFrom: source,
    status: 'running',
    resultDigest: null,
    failure: null,
  })
  await atomicPublish(join(path, checkpointFormat.manifest), manifest)
  return new FileRunHandle({ identity, path, lock, manifest, journal })
}

/** Detect equal or nested run trees in either direction. resolveSourceRun uses canonical
 * parent directories so writes cannot overlap the selected source tree. */
function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child)
    return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }
  return inside(a, b) || inside(b, a)
}

/** Compare the on-disk entry with the held descriptor before unlinking, so rollback also works
 * for a partially written lock. Flush the parent after unlinking and always close the descriptor.
 * An observed inode or file kind mismatch rejects as WORKFLOW_LOCK_OWNERSHIP_LOST. */
async function releaseLock(path: string, handle: FileHandle): Promise<void> {
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
