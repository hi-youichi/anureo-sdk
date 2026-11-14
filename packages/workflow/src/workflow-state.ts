import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { StoredFailure } from './persistence/store'

/** Recognize SDK cleanup evidence so fatal classification and persisted failure metadata agree. */
export function cleanupFailed(error: HarnessSdkError): boolean {
  return error.code === 'RESOURCE_RELEASE_FAILED'
    || error.details?.cleanupFailed === true
    || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
}

/** Reduce workflow's abort error to the manifest's failure fields without persisting diagnostics. */
export function storedFailure(error: HarnessSdkError): StoredFailure {
  return { code: error.code, retryable: error.retryable,
    outcomeUnknown: error.outcomeUnknown, cleanupFailed: cleanupFailed(error) }
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
  /** Remember a sticky failure for workflow and future dispatch checks; does not cancel active work. */
  stop(error: HarnessSdkError): void { this.stops.add(error) }

  /** Aggregate sticky failures with the first code/message, combined uncertainty and cleanup evidence.
   * workflow reports this after draining and releasing its handle; absent means no sticky failure. */
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
    return this.rejected ? 'incomplete' : 'completed'
  }

  /** Let memoizedAgent mark a dropped, fulfilled null outcome incomplete without stopping dispatch. */
  noteIncomplete(): void { this.rejected++ }

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
      this.rejected++
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
  private rejected = 0
}
