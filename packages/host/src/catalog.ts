import { randomUUID } from 'node:crypto'
import { catalogPhase, type CatalogProbeOptions } from '@anureo/sdk/diagnostics'
import type { CatalogCache, HxCatalogRefreshResult } from './legacy-protocol'
import type { RuntimeRegistration } from './host'
import { validateCatalogModels, type CatalogStorage, type ModelSnapshot, type CatalogAttempt } from './catalog-store'
import { catalogErrorCode, type CatalogDiagnostic, type CatalogWorker } from './catalog-worker'
import { HostError } from './errors'

interface Entry {
  registration: RuntimeRegistration; key: string; fingerprint: string; generation: number
  snapshot?: ModelSnapshot; attempt?: CatalogAttempt; worker?: CatalogWorker; cleanup?: Promise<void>
  refresh?: { id: string; abort: AbortController; promise: Promise<void> }
}
export interface CatalogOptions {
  store: CatalogStorage; digest(value: unknown): string
  onChanged(runtimeConfigId: string, changes: Array<'models' | 'refresh'>): void
  onDiagnostic?(event: CatalogDiagnostic): void
  freshMs?: number; refreshTimeoutMs?: number; concurrency?: number; now?: () => number
}
/** Success values live independently of both worker lifetime and refresh failures. */
export class HarnessCatalogService {
  private readonly entries = new Map<string, Entry>()
  private readonly queue: Array<() => Promise<void>> = []
  private running = 0
  private closed = false
  private started = false
  private timer?: ReturnType<typeof setInterval>
  private generation = 0
  private readonly now: () => number
  constructor(private readonly options: CatalogOptions) { this.now = options.now ?? Date.now }
  private diagnostic(entry: Entry, event: Omit<CatalogDiagnostic, 'runtimeConfigId' | 'providerId' | 'generation'>): void {
    try { this.options.onDiagnostic?.({ runtimeConfigId: entry.registration.id, providerId: entry.registration.providerId ?? entry.registration.adapterId, generation: entry.generation, ...event }) } catch {}
  }
  private changed(id: string, changes: Array<'models' | 'refresh'>): void { try { this.options.onChanged(id, changes) } catch {} }
  replace(registrations: RuntimeRegistration[]): void {
    const remaining = new Set(registrations.map(r => r.id))
    for (const [id, old] of this.entries) if (!remaining.has(id)) { this.entries.delete(id); this.retire(old) }
    for (const registration of registrations) {
      const key = this.options.digest({ kind: 'model-catalog', id: registration.id, provider: registration.providerId ?? registration.adapterId, scope: registration.catalogScope ?? registration.id, authEpoch: this.options.store.identityEpoch(registration.id) })
      const fingerprint = registration.catalogFingerprint ?? registration.version ?? registration.id
      const old = this.entries.get(registration.id)
      if (old?.key === key && old.fingerprint === fingerprint && old.registration.available === registration.available && (registration.catalogFingerprint !== undefined || old.registration === registration)) { old.registration = registration; continue }
      if (old) this.retire(old)
      const entry: Entry = { registration, key, fingerprint, generation: ++this.generation, cleanup: old?.cleanup }
      try { entry.snapshot = this.options.store.load(key); if (entry.snapshot && this.options.digest(entry.snapshot.models) !== entry.snapshot.contentHash) { entry.snapshot = undefined; throw new Error('CATALOG_SNAPSHOT_INVALID') }; if (entry.snapshot && old && old.registration !== registration && registration.catalogFingerprint === undefined) entry.snapshot.freshUntil = 0; entry.attempt = this.options.store.attempt(key) }
      catch (cause) { this.diagnostic(entry, { event: 'cache.load', outcome: 'error', errorCode: catalogErrorCode(cause) }) }
      this.entries.set(registration.id, entry)
    }
    if (this.started) this.warm()
  }
  resetIdentity(runtimeIds: string[]): void {
    for (const id of runtimeIds) this.options.store.rotateIdentity(id, randomUUID())
    this.replace([...this.entries.values()].map(entry => entry.registration))
    for (const id of runtimeIds) { this.changed(id, ['models', 'refresh']); this.schedule(id, 'auth') }
  }
  private cleanup(entry: Entry, worker: CatalogWorker): Promise<void> {
    const started = performance.now()
    this.diagnostic(entry, { event: 'worker.cleanup', outcome: 'started' })
    return Promise.resolve().then(() => worker.dispose()).then(() => { this.diagnostic(entry, { event: 'worker.cleanup', outcome: 'success', durationMs: performance.now() - started }) }, cause => { this.diagnostic(entry, { event: 'worker.cleanup', outcome: 'error', durationMs: performance.now() - started, errorCode: catalogErrorCode(cause) }); throw cause })
  }
  private retire(entry: Entry): void {
    entry.refresh?.abort.abort()
    if (entry.worker) {
      const worker = entry.worker; entry.worker = undefined
      entry.cleanup = this.cleanup(entry, worker); void entry.cleanup.catch(() => {})
    }
  }
  private entry(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new HostError('HARNESS_UNAVAILABLE'); return entry }
  private stale(entry: Entry): boolean {
    return !entry.snapshot || entry.snapshot.lastSuccessAt > this.now() || entry.snapshot.freshUntil <= this.now() || entry.snapshot.engineFingerprint !== entry.fingerprint
  }
  view(id: string, includeModels = false): { models?: ModelSnapshot['models']; cache: CatalogCache } {
    const entry = this.entry(id)
    if (this.stale(entry)) this.schedule(id, 'expired')
    this.diagnostic(entry, { event: 'cache.read', outcome: entry.snapshot ? 'hit' : 'miss', ...(entry.refresh ? { refreshId: entry.refresh.id } : {}), ...(entry.snapshot ? { cacheAgeMs: Math.max(0, this.now() - entry.snapshot.lastSuccessAt) } : {}) })
    return {
      ...(includeModels ? { models: structuredClone(entry.snapshot?.models ?? []) } : {}),
      cache: { state: entry.snapshot ? this.stale(entry) ? 'stale' : 'fresh' : 'empty', lastSuccessAt: entry.snapshot?.lastSuccessAt ?? null, freshUntil: entry.snapshot?.freshUntil ?? null, refreshing: !!entry.refresh, ...(entry.attempt?.lastErrorCode ? { lastErrorCode: entry.attempt.lastErrorCode } : {}), ...(entry.attempt?.nextRetryAt ? { nextRetryAt: entry.attempt.nextRetryAt } : {}) },
    }
  }
  /** Legacy callers may await the first result; subsequent reads always retain the last success. */
  async legacyModels(id: string): Promise<ModelSnapshot['models']> {
    const entry = this.entry(id)
    if (entry.snapshot) { this.view(id); return structuredClone(entry.snapshot.models) }
    this.schedule(id, 'expired')
    await entry.refresh?.promise
    const refreshed = this.entry(id).snapshot
    if (!refreshed) throw new HostError(entry.attempt?.lastErrorCode ?? 'CATALOG_WARMING', undefined, true, false)
    return structuredClone(refreshed.models)
  }
  coalescedRefresh(id: string): HxCatalogRefreshResult | undefined {
    const refresh = this.entry(id).refresh
    return refresh ? { accepted: true, coalesced: true, refreshId: refresh.id } : undefined
  }
  schedule(id: string, trigger: string): HxCatalogRefreshResult {
    const entry = this.entry(id)
    if (entry.refresh) return { accepted: true, coalesced: true, refreshId: entry.refresh.id }
    const registration = entry.registration
    if (this.closed || registration.available === false || (!registration.models && !registration.catalogWorker) || (trigger !== 'manual' && (entry.attempt?.nextRetryAt ?? 0) > this.now())) return { accepted: false, coalesced: false, refreshId: 'not-scheduled' }
    const refreshId = randomUUID(), abort = new AbortController(), queuedAt = performance.now()
    let complete!: () => void
    const promise = new Promise<void>(resolve => { complete = resolve })
    entry.refresh = { id: refreshId, abort, promise }
    this.diagnostic(entry, { event: 'refresh.queued', refreshId, trigger, outcome: 'queued' })
    this.queue.push(async () => {
      const started = performance.now(), current = () => !this.closed && !abort.signal.aborted && this.entries.get(id) === entry
      let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined
      try {
        if (!current()) return
        this.diagnostic(entry, { event: 'refresh.started', refreshId, trigger, phase: 'queue', outcome: 'success', durationMs: started - queuedAt })
        this.changed(id, ['refresh'])
        const timeoutMs = this.options.refreshTimeoutMs ?? 30_000
        const probe: CatalogProbeOptions = { signal: abort.signal, timeoutMs: Math.min(timeoutMs, 10_000), onPhase: event => this.diagnostic(entry, { event: event.outcome === 'started' ? 'phase.started' : 'phase.completed', refreshId, trigger, ...event }) }
        const work = async () => {
          await entry.cleanup
          if (!current()) throw new HostError('CATALOG_CANCELLED')
          entry.worker ??= registration.catalogWorker?.() ?? { prepare: async () => {}, readModels: () => catalogPhase(probe, 'models', () => registration.models!()), dispose: async () => {} }
          await entry.worker.prepare(probe)
          return await entry.worker.readModels(probe)
        }
        const models = await Promise.race([work(), new Promise<never>((_, reject) => {
          let expired = false
          onAbort = () => reject(new HostError(expired ? 'CATALOG_REFRESH_TIMEOUT' : 'CATALOG_CANCELLED'))
          abort.signal.addEventListener('abort', onAbort, { once: true })
          if (abort.signal.aborted) onAbort()
          else timer = setTimeout(() => { expired = true; abort.abort() }, timeoutMs)
        })])
        if (!current()) return
        validateCatalogModels(models)
        const now = this.now(), next: ModelSnapshot = { models: structuredClone(models), contentHash: this.options.digest(models), engineFingerprint: entry.fingerprint, lastSuccessAt: now, freshUntil: now + (this.options.freshMs ?? 15 * 60_000) }
        const changed = !entry.snapshot || entry.snapshot.contentHash !== next.contentHash
        const persistStart = performance.now()
        this.options.store.success(entry.key, id, registration.providerId ?? registration.adapterId, next)
        entry.snapshot = next; entry.attempt = undefined
        this.diagnostic(entry, { event: 'phase.completed', refreshId, phase: 'persist', outcome: 'success', durationMs: performance.now() - persistStart })
        this.changed(id, changed ? ['models', 'refresh'] : ['refresh'])
        this.diagnostic(entry, { event: 'refresh.completed', refreshId, trigger, outcome: 'success', modelCount: models.length, totalDurationMs: performance.now() - started })
      } catch (cause) {
        if (this.closed || this.entries.get(id) !== entry) return
        const errorCode = catalogErrorCode(cause), failureCount = (entry.attempt?.failureCount ?? 0) + 1
        const delays = [5_000, 30_000, 120_000, 300_000]
        entry.attempt = { lastAttemptAt: this.now(), lastErrorCode: errorCode, failureCount, nextRetryAt: this.now() + delays[Math.min(failureCount - 1, delays.length - 1)]! }
        try { this.options.store.failure(entry.key, entry.attempt) } catch { this.diagnostic(entry, { event: 'cache.persist', outcome: 'error', errorCode: 'CATALOG_PERSIST_FAILED' }) }
        const worker = entry.worker; entry.worker = undefined
        if (worker) entry.cleanup = this.cleanup(entry, worker)
        void entry.cleanup?.catch(() => {})
        this.diagnostic(entry, { event: 'refresh.completed', refreshId, trigger, outcome: 'error', errorCode, retainedSnapshot: !!entry.snapshot, nextRetryAt: entry.attempt.nextRetryAt, totalDurationMs: performance.now() - started })
      } finally {
        if (timer) clearTimeout(timer)
        if (onAbort) abort.signal.removeEventListener('abort', onAbort)
        if (entry.refresh?.id === refreshId) entry.refresh = undefined
        if (!this.closed && this.entries.get(id) === entry) this.changed(id, ['refresh'])
        complete()
      }
    })
    queueMicrotask(() => this.pump())
    return { accepted: true, coalesced: false, refreshId }
  }
  private pump(): void {
    while (this.queue.length && this.running < (this.options.concurrency ?? 2)) {
      const job = this.queue.shift()!; this.running++
      void job().finally(() => { this.running--; this.pump() })
    }
  }
  private warm(): void { for (const [id, entry] of this.entries) if (this.stale(entry) || !entry.worker) this.schedule(id, 'startup') }
  startBackground(): void {
    if (this.started || this.closed) return
    this.started = true; this.warm()
    this.timer = setInterval(() => { for (const [id, entry] of this.entries) if (this.stale(entry)) this.schedule(id, 'retry') }, 5_000)
    this.timer.unref?.()
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer)
    const pending = [...this.entries.values()].map(entry => { this.retire(entry); return Promise.allSettled([entry.refresh?.promise, entry.cleanup]) })
    this.pump()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000) })]) } finally { if (timer) clearTimeout(timer) }
  }
}
