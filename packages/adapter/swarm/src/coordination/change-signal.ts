import { HarnessSdkError } from '@anureo/sdk'

/** A versioned broadcast: observing a change never consumes another waiter's wakeup. */
export class ChangeSignal {
  private version = 0
  private closed?: HarnessSdkError
  private readonly listeners = new Set<(error?: HarnessSdkError) => void>()

  current() { return this.version }

  touch() {
    if (this.closed) return
    if (this.version === Number.MAX_SAFE_INTEGER) { this.close(); return }
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  close() {
    if (this.closed) return
    this.closed = new HarnessSdkError('SESSION_CLOSED')
    for (const listener of [...this.listeners]) listener(this.closed)
  }

  waitAfter(observed: number, timeoutMs: number, signal?: AbortSignal): Promise<'changed' | 'timeout'> {
    if (signal?.aborted) return Promise.reject(new HarnessSdkError('REQUEST_ABORTED'))
    if (this.closed) return Promise.reject(this.closed)
    if (this.version !== observed) return Promise.resolve('changed')
    if (timeoutMs <= 0) return Promise.resolve('timeout')
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const finish = (outcome: 'changed' | 'timeout', error?: HarnessSdkError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.listeners.delete(changed)
        signal?.removeEventListener('abort', aborted)
        if (error) reject(error)
        else resolve(outcome)
      }
      const changed = (error?: HarnessSdkError) => finish('changed', error)
      const aborted = () => finish('changed', new HarnessSdkError('REQUEST_ABORTED'))
      this.listeners.add(changed)
      signal?.addEventListener('abort', aborted, { once: true })
      timer = setTimeout(() => finish('timeout'), timeoutMs)
      if (signal?.aborted) aborted()
      else if (this.closed) changed(this.closed)
      else if (this.version !== observed) changed()
    })
  }
}
