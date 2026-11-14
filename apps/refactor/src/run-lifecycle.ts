// Owns run identity, progress delivery and the lifetime of the per-target writer lock.
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { failure, message } from './errors'
import type { RefactorOptions } from './options'
import { saveReport } from './report-store'
import type { RefactorReport } from './results'

/** Run the phases supplied by refactorCode under the target's writer lock.
 * refactorCode supplies a canonical Git target. Its caller owns the SDK client.
 * Directory setup and phase failures usually produce an incomplete report. Synchronous
 * observer errors are recorded separately. Error conversion itself can throw.
 * Resolves after publishing the final report, closing the lock handle and removing the lock path.
 * Acquisition, report initialization, final publication and lock cleanup failures reject.
 * Report initialization precedes the cleanup guard, so an initialization failure can leave the lock. */
export async function withRun(options: RefactorOptions & { cwd: string }, body: RunBody): Promise<RefactorReport> {
  const writer = await acquireWriter(options.cwd)
  const report = createReport(options, writer.root)
  try {
    await executeRun(options, report, body)
  } finally {
    await finalizeRun(report, writer)
  }
  return report
}

/** Resources owned by withRun after exclusive acquisition; the handle closes before path removal. */
interface RunWriter {
  root: string
  lockPath: string
  lock: FileHandle
}

/** refactorCode supplies the design, planning and module phases as this callback. executeRun
 * invokes it after creating the directory and delivering the run event. The callback can update
 * the report, emit progress and publish intermediate checkpoints. Its settlement determines run
 * status. withRun owns final publication and lock release. */
type RunBody = (report: RefactorReport, progress: (event: string) => void) => Promise<void>

/** Create the storage root and acquire exclusive ownership for withRun before allocating a run ID.
 * Returns the open lock and its paths, transferring cleanup to withRun. Root creation errors
 * propagate. Any open failure rejects with the lock diagnostic and leaves any existing lock alone. */
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
 * withRun calls this after acquisition. UUID generation can throw. */
function createReport(options: RefactorOptions, root: string): RefactorReport {
  const runId = randomUUID()
  return {
    runId,
    cwd: options.cwd,
    directory: join(root, runId),
    status: 'incomplete',
    reviewOnly: options.reviewOnly ?? false,
    design: null,
    plan: null,
    modules: [],
    graphCoverage: [],
    errors: [],
    failure: null,
    progressErrors: [],
  }
}

/** Create this run's directory and await orchestration, recording setup/body failures in report.
 * Called by withRun while locked; progress precedes body dispatch and completion follows it.
 * Ordinary setup/body errors are stored instead of rejecting; error conversion can still throw. */
async function executeRun(options: RefactorOptions, report: RefactorReport, body: RunBody): Promise<void> {
  const progress = createProgressReporter(options, report)
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

/** Give executeRun and its phase callback a synchronous progress function for this report.
 * refactorCode supplies the observer through options. Record thrown observer errors so a failed
 * display sink does not stop work. Observer return values are ignored. Error conversion can throw. */
function createProgressReporter(options: RefactorOptions, report: RefactorReport): (event: string) => void {
  return event => {
    try {
      options.onProgress?.(event)
    } catch (cause) {
      report.progressErrors.push(message(cause))
    }
  }
}

/** Publish the final snapshot, then attempt both lock-release operations for withRun.
 * Publication stays under the lock so another writer cannot start before the snapshot attempt.
 * Removal errors take precedence over close errors, which take precedence over publication errors. */
async function finalizeRun(report: RefactorReport, writer: RunWriter): Promise<void> {
  try {
    await saveReport(report)
  } finally {
    try {
      await writer.lock.close()
    } finally {
      await rm(writer.lockPath)
    }
  }
}
