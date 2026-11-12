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
  private keys = new Set<string>()
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

  assertDispatch(): void {
    const failure = this.failure
    if (failure) throw failure
  }

  track<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new HarnessSdkError('WORKFLOW_CLOSED'))
    let work: Promise<T>
    try {
      this.assertDispatch()
      if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024) {
        throw new HarnessSdkError('WORKFLOW_INVALID_STEP_KEY')
      }
      if (this.keys.has(key)) throw new HarnessSdkError('WORKFLOW_DUPLICATE_STEP_KEY')
      this.keys.add(key)
      work = operation() // 同步准备参数，在此返回前固定输入。
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
