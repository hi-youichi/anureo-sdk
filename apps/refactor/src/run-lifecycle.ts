// Owns run identity, writer locking and finalization; it must not choose or execute refactor phases.
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { failure, message } from './errors'
import type { RefactorOptions } from './options'
import { saveReport } from './report-store'
import type { RefactorReport } from './results'

/** Internal lifecycle entry used by refactorCode to await its phase callback under the writer lock.
 * Creates run storage, delivers progress synchronously and returns the final report only after
 * publication and lock release. Setup/body failures become report errors; observer throws are
 * recorded separately, though error conversion can itself throw. Returned observer promises are
 * not awaited. The caller must validate cwd first and retains ownership of the SDK client.
 * After report initialization, final publication, handle close and lock removal are always
 * attempted in that order. Acquisition, initialization, publication and cleanup failures reject;
 * initialization fails before the cleanup guard and can leave the acquired lock in place. */
export async function withRun(options: RefactorOptions & { cwd: string }, body: RunBody): Promise<RefactorReport> {
  const writer = await acquireWriter(options.cwd)
  const report = createReport(options, writer.root)
  try { await executeRun(options, report, body) }
  finally { await finalizeRun(report, writer) }
  return report
}

/** Resources owned by withRun after exclusive acquisition; the handle closes before path removal. */
interface RunWriter {
  root: string
  lockPath: string
  lock: FileHandle
}

/** Supplied by refactorCode and invoked by executeRun after directory creation and the first event.
 * Mutates the report and emits synchronous progress; resolution marks the run completed, rejection
 * records a run failure. Publication and lock release remain owned by withRun. */
type RunBody = (report: RefactorReport, progress: (event: string) => void) => Promise<void>

/** Create the storage root and acquire exclusive ownership for withRun before allocating a run ID.
 * Returns the open lock and its paths; root creation rejects directly, while any open failure
 * rejects with the shared lock diagnostic. A failed acquisition must never remove another lock. */
async function acquireWriter(cwd: string): Promise<RunWriter> {
  const root = join(cwd, '.anureo', 'refactor')
  await mkdir(root, { recursive: true })
  const lockPath = join(root, 'writer.lock')
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new Error(`Cannot acquire refactor lock: ${lockPath}. Check for an active run before removing a stale lock.`)
  })
  return { root, lockPath, lock }
}

/** Allocate the initial incomplete record for a locked run without creating its directory.
 * Called by withRun after acquisition; UUID generation can throw, and completion is recorded
 * only after the orchestration body returns. No report or options fields are mutated here. */
function createReport(options: RefactorOptions, root: string): RefactorReport {
  const runId = randomUUID()
  return {
    runId, cwd: options.cwd, directory: join(root, runId), status: 'incomplete', reviewOnly: options.reviewOnly ?? false,
    design: null, plan: null, modules: [], graphCoverage: [], errors: [], failure: null, progressErrors: [],
  }
}

/** Create this run's directory and await orchestration, recording setup/body failures in report.
 * Called by withRun while locked; progress precedes body dispatch and completion follows it.
 * Ordinary setup/body errors are stored instead of rejecting; error conversion can still throw. */
async function executeRun(options: RefactorOptions, report: RefactorReport, body: RunBody): Promise<void> {
  /** Deliver an event synchronously for orchestration; observer errors append to this run's report.
   * Keeping observers outside the failure gate lets editing continue when a display sink fails.
   * No observer promise is awaited; error conversion itself can throw. */
  const progress = (event: string) => {
    try { options.onProgress?.(event) }
    catch (cause) { report.progressErrors.push(message(cause)) }
  }
  try {
    await mkdir(report.directory)
    progress(`run: ${report.directory}`)
    await body(report, progress)
    report.status = 'completed'
  } catch (cause) {
    report.errors.push(message(cause))
    report.failure = failure(cause)
  }
}

/** Publish the final snapshot, then attempt both lock-release operations for withRun.
 * Publication stays under the lock so another writer cannot start before the snapshot attempt.
 * Each finally protects cleanup from earlier failures; removal errors take precedence over close
 * errors, which take precedence over publication errors. Partial edits are never undone. */
async function finalizeRun(report: RefactorReport, writer: RunWriter): Promise<void> {
  try { await saveReport(report) }
  finally {
    try { await writer.lock.close() }
    finally { await rm(writer.lockPath) }
  }
}
