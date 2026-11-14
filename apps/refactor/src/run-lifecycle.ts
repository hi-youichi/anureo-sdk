// Owns run identity, progress delivery and the lifetime of the checkout writer lock.
import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { failure, message } from './errors'
import { git } from './git'
import type { RefactorOptions } from './options'
import { saveReport } from './report-store'
import type { RefactorReport } from './results'

/** Run the phases supplied by refactorCode under the checkout's writer lock.
 * Phase failures produce an incomplete report and synchronous observer errors are recorded
 * separately. Setup, final publication and lock cleanup failures reject. */
export async function withRun(options: RefactorOptions & { cwd: string }, body: RunBody): Promise<RefactorReport> {
  const writer = await acquireWriter(options.cwd)
  const errors: unknown[] = []
  try {
    if (writer.root !== dirname(writer.lockPath)) await initializeStorage(writer.root)
    const report = createReport(options, writer.root)
    await mkdir(report.directory)
    await executeRun(options, report, body).catch(cause => { errors.push(cause) })
    await saveReport(report)
    return report
  } catch (cause) {
    errors.push(cause)
    throw cause
  } finally {
    await writer.lock.close().catch(cause => { errors.push(cause) })
    await rm(writer.lockPath).catch(cause => { errors.push(cause) })
    if (errors.length > 1) throw new AggregateError(errors, errors.map(message).join('\n'))
    if (errors.length === 1) throw errors[0]
  }
}

/** Resources owned by withRun after exclusive acquisition; the handle closes before path removal. */
interface RunWriter {
  root: string
  lockPath: string
  lock: FileHandle
}

/** refactorCode supplies the design, planning and module phases as this callback. executeRun
 * delivers the run event before invoking it. The callback can update the report, emit progress
 * and publish intermediate checkpoints. Its settlement determines run status. */
type RunBody = (report: RefactorReport, progress: (event: string) => void) => Promise<void>

/** Acquire checkout-wide ownership while keeping report storage relative to the target. */
async function acquireWriter(cwd: string): Promise<RunWriter> {
  const root = join(cwd, '.anureo', 'refactor')
  const checkoutRoot = await realpath((await git(cwd, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, ''))
  const lockRoot = join(checkoutRoot, '.anureo', 'refactor')
  await initializeStorage(lockRoot)
  const lockPath = join(lockRoot, 'writer.lock')
  const lock = await open(lockPath, 'wx').catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EEXIST') throw cause
    throw new Error(
      `Cannot acquire refactor lock: ${lockPath}. Check for an active run before removing a stale lock.`,
      { cause },
    )
  })
  return { root, lockPath, lock }
}

/** Ignore tool artifacts while preserving any existing storage-specific ignore rules. */
async function initializeStorage(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, '.gitignore'), '*\n', { flag: 'wx' }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== 'EEXIST') throw cause
  })
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

/** Report run progress and await orchestration, recording phase failures in the report. */
async function executeRun(options: RefactorOptions, report: RefactorReport, body: RunBody): Promise<void> {
  const progress = createProgressReporter(options, report)
  try {
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
 * display sink does not stop work. Observer return values are ignored. */
function createProgressReporter(options: RefactorOptions, report: RefactorReport): (event: string) => void {
  return event => {
    try {
      options.onProgress?.(event)
    } catch (cause) {
      report.progressErrors.push(message(cause))
    }
  }
}
