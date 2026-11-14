import { AsyncLocalStorage } from 'node:async_hooks'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { AgentJournal } from './persistence/journal'
import type { StoredFailure } from './persistence/records'

/** Internal run context installed for the workflow body and inherited by agent calls. */
export interface RunContext {
  /** Source replay and target journal used by memoizedAgent. */
  readonly journal: AgentJournal
  /** Admission, pending work and failure state shared with workflow. */
  readonly state: RunState
}

/** Invoke completeRun's callback with context inherited by asynchronous descendants. The caller
 * receives the callback promise or a synchronous throw and owns closing admission and draining work. */
export function runWith<T>(context: RunContext, body: () => Promise<T>): Promise<T> {
  return storage.run(context, body)
}

/** Read the current async context so agent can choose journaled or ordinary execution.
 * Async descendants can retain a closed context. RunState.track then rejects admission. */
export function currentRun(): RunContext | undefined {
  return storage.getStore()
}

/** Project abortRun's failure into manifest metadata, excluding diagnostic messages and details. */
export function storedFailure(error: HarnessSdkError): StoredFailure {
  return {
    code: error.code,
    retryable: error.retryable,
    outcomeUnknown: error.outcomeUnknown,
    cleanupFailed: cleanupFailed(error),
  }
}

/** Tell memoizedAgent and RunState.track when a failure must stop later dispatch even if caught.
 * Uncertain execution, failed cleanup and broken persistence cannot safely continue the run. */
export function isFatal(error: HarnessSdkError): boolean {
  return error.outcomeUnknown || cleanupFailed(error)
    || error.code === 'WORKFLOW_STORAGE_FAILED'
    || error.code === 'WORKFLOW_CHECKPOINT_INVALID'
}

/** Internal admission and settlement state shared by workflow and its journaled agent calls.
 * Ordinary step failures mark completion incomplete; sticky failures reject the run and block dispatch.
 * workflow's completion and abort phases close admission and drain registered work. */
export class RunState {
  /** Preserve a failure for workflow's rejection and prevent later dispatch. Active work keeps settling. */
  stop(error: HarnessSdkError): void { this.stops.add(error) }

  /** Record a normalized storage failure when abortRun cannot publish or workflow cannot release the handle. */
  noteStorageFailure(): void { this.stop(new HarnessSdkError('WORKFLOW_STORAGE_FAILED')) }

  /** Return the first sticky code and message with all recorded codes, uncertainty and cleanup evidence.
   * abortRun snapshots this for failure publication. workflow reads it again after lock release. */
  get failure(): HarnessSdkError | undefined {
    const failures = [...this.stops]
    const first = failures[0]
    if (!first) return undefined
    return new HarnessSdkError(first.code, first.message, false,
      failures.some(error => error.outcomeUnknown), {
        failureCodes: [...new Set(failures.map(error => error.code))],
        cleanupFailed: failures.some(cleanupFailed),
      })
  }

  /** Publication status for workflow when no sticky failure remains to reject the run. */
  get status(): 'completed' | 'incomplete' {
    return this.incomplete ? 'incomplete' : 'completed'
  }

  /** Mark a drop from executeJournaledAgent or a rejection observed by track incomplete.
   * Fatality is checked separately. */
  noteIncomplete(): void { this.incomplete = true }

  /** Throw the sticky aggregate. track checks this before starting registered work, and
   * executeJournaledAgent checks again after publishing started because another call may have
   * stopped dispatch during that await. */
  assertDispatch(): void {
    const failure = this.failure
    if (failure) throw failure
  }

  /** Invoke memoizedAgent's operation immediately and register it for workflow's drain.
   * Closed admission returns a WORKFLOW_CLOSED rejection without invoking the operation.
   * Sticky failures and synchronous operation throws become rejected promises. Return the work
   * promise and register a separate observer so catching its rejection cannot hide incomplete
   * work or fatal failures from workflow. */
  track<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new HarnessSdkError('WORKFLOW_CLOSED'))
    let work: Promise<T>
    try {
      this.assertDispatch()
      work = operation()
    } catch (cause) {
      work = Promise.reject(cause)
    }
    const observed = work.then(() => {}, cause => {
      this.noteIncomplete()
      const error = sdkError(cause, 'WORKFLOW_STEP_FAILED')
      if (isFatal(error)) this.stop(error)
    })
    this.pending.add(observed)
    void observed.then(() => { this.pending.delete(observed) })
    return work
  }

  /** Stop admitting agent work synchronously, then await all work already registered by track.
   * completeRun calls this before publication, and abortRun uses it on failure. Work continues
   * settling without cancellation. The observers record operation rejections in run state. */
  async closeAndDrain(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.pending])
  }

  private accepting = true
  private pending = new Set<Promise<void>>()
  private stops = new Set<HarnessSdkError>()
  private incomplete = false
}

const storage = new AsyncLocalStorage<RunContext>()

/** Recognize SDK resource-release errors and explicit cleanup evidence on another failure.
 * isFatal, storedFailure and RunState.failure share this rule for dispatch and reporting. */
function cleanupFailed(error: HarnessSdkError): boolean {
  return error.code === 'RESOURCE_RELEASE_FAILED'
    || error.details?.cleanupFailed === true
    || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
}
