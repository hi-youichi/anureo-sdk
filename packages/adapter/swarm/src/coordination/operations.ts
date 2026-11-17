import { createHash, randomUUID } from 'node:crypto'
import { HarnessSdkError } from '@anureo/sdk'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}

/** Bounded operation scopes: forgotten keys cannot silently become new commands. */
export class OperationStore {
  private ordinal = 0
  private current = ''
  private readonly scopes = new Map<string, Map<string, { fingerprint: string; promise: Promise<unknown>; pending: boolean; value?: unknown }>>()

  begin() {
    for (const [scope, entries] of this.scopes) {
      if (this.scopes.size < 8) break
      const unsettled = [...entries.values()].some(entry => entry.pending || (entry.value && typeof entry.value === 'object' && 'state' in entry.value && ['queued', 'unknown'].includes(String(entry.value.state))))
      if (!unsettled) this.scopes.delete(scope)
    }
    if (this.scopes.size >= 64) throw new HarnessSdkError('SWARM_OPERATION_LIMIT')
    this.current = `${++this.ordinal}-${randomUUID()}`
    this.scopes.set(this.current, new Map())
  }

  scope() { return this.current }

  run<T>(name: string, key: unknown, args: unknown, start: () => T | Promise<T>): Promise<T> {
    if (typeof key !== 'string' || key.length > 256 || !key.includes(':')) throw new HarnessSdkError('SWARM_INVALID_OPERATION_KEY')
    const separator = key.indexOf(':')
    const scope = key.slice(0, separator)
    if (!key.slice(separator + 1).trim()) throw new HarnessSdkError('SWARM_INVALID_OPERATION_KEY')
    const entries = this.scopes.get(scope)
    if (!entries) throw new HarnessSdkError('SWARM_OPERATION_EXPIRED')
    const identity = `${name}:${key}`
    const fingerprint = createHash('sha256').update(canonical(args)).digest('hex')
    const prior = entries.get(identity)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HarnessSdkError('SWARM_OPERATION_CONFLICT')
      return prior.promise as Promise<T>
    }
    if (scope !== this.current) throw new HarnessSdkError('SWARM_OPERATION_EXPIRED')
    if (entries.size >= 128) throw new HarnessSdkError('SWARM_OPERATION_LIMIT')
    const promise = Promise.resolve().then(start)
    const entry: { fingerprint: string; promise: Promise<unknown>; pending: boolean; value?: unknown } = { fingerprint, promise, pending: true }
    entries.set(identity, entry)
    void promise.then(value => { entry.pending = false; entry.value = value }, () => { entry.pending = false })
    return promise
  }
}
