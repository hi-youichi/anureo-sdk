import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { StoredFailure } from './persistence/store'

export function cleanupFailed(error: HarnessSdkError): boolean {
  return error.code === 'RESOURCE_RELEASE_FAILED'
    || error.details?.cleanupFailed === true
    || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
}

export function storedFailure(error: HarnessSdkError): StoredFailure {
  return { code: error.code, retryable: error.retryable,
    outcomeUnknown: error.outcomeUnknown, cleanupFailed: cleanupFailed(error) }
}

export function isFatal(error: HarnessSdkError): boolean {
  return error.outcomeUnknown || cleanupFailed(error)
    || error.code === 'WORKFLOW_STORAGE_FAILED'
    || error.code === 'WORKFLOW_CHECKPOINT_INVALID'
}

export class RunState {
  private accepting = true
  private pending = new Set<Promise<void>>()
  private stops = new Set<HarnessSdkError>()
  private rejected = 0

  stop(error: HarnessSdkError): void { this.stops.add(error) }

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

  get status(): 'completed' | 'incomplete' {
    return this.rejected ? 'incomplete' : 'completed'
  }

  /** Records a settled-but-unsuccessful outcome (for example a dropped agent)
   * that does not reject the body but still marks the run incomplete. */
  noteIncomplete(): void { this.rejected++ }

  assertDispatch(): void {
    const failure = this.failure
    if (failure) throw failure
  }

  /** Registers in-flight work so body completion waits for it; late calls reject. */
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

  async closeAndDrain(): Promise<void> {
    this.accepting = false
    await Promise.all([...this.pending])
  }
}
