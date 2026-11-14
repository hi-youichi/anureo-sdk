import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { StoredFailure } from './persistence/records'

/** Recognize SDK resource-release errors and explicit cleanup evidence on another failure.
 * isFatal, storedFailure and RunState.failure share this rule for dispatch and reporting. */
export function cleanupFailed(error: HarnessSdkError): boolean {
  return error.code === 'RESOURCE_RELEASE_FAILED'
    || error.details?.cleanupFailed === true
    || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
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

  /** Mark a drop from memoizedAgent or a rejection from track incomplete. Fatality is checked separately. */
  noteIncomplete(): void { this.incomplete = true }

  /** Throw the sticky aggregate before dispatch. memoizedAgent checks again after publishing
   * its started marker because another call may have stopped the run during that await.
   * Admission closure is checked separately by track. */
  assertDispatch(): void {
    const failure = this.failure
    if (failure) throw failure
  }

  /** Invoke memoizedAgent's operation immediately and register it for workflow's drain.
   * Closed admission returns a WORKFLOW_CLOSED rejection without invoking the operation.
   * Sticky failures and synchronous operation throws become rejected promises. Return the
   * original work promise; a separate observer marks rejections incomplete and fatal ones sticky,
   * so catching an agent failure cannot hide its effect on workflow completion. */
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
   * completeRun calls this before publication; abortRun repeats it on failure. Operation
   * rejections are recorded in state rather than rethrown by the drain. Active work is not cancelled. */
  async closeAndDrain(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.pending])
  }

  private accepting = true
  private pending = new Set<Promise<void>>()
  private stops = new Set<HarnessSdkError>()
  private incomplete = false
}
