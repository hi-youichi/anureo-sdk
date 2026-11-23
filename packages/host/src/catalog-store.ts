import type { SqliteConnection } from './sqlite-driver'
import { validateHxResult, type HxHarnessModelsResult } from './legacy-protocol'
export type CatalogModel = HxHarnessModelsResult['models'][number]
export interface ModelSnapshot {
  models: CatalogModel[]; contentHash: string; engineFingerprint: string
  lastSuccessAt: number; freshUntil: number
}
export interface CatalogAttempt { lastAttemptAt: number; failureCount: number; lastErrorCode?: string; nextRetryAt?: number }
export function validateCatalogModels(models: unknown): asserts models is CatalogModel[] {
  if (!Array.isArray(models) || models.length > 10_000 || new TextEncoder().encode(JSON.stringify(models)).byteLength > 4 * 1024 * 1024) throw new Error('CATALOG_LIMIT_EXCEEDED')
  validateHxResult('hx.harness.models', { models, source: 'live' })
}
export class CatalogStore {
  constructor(private readonly db: SqliteConnection) {}
  identityEpoch(runtimeId: string): string {
    const row = this.db.query('SELECT value FROM hx_meta WHERE key=?').get(`catalog-auth:${runtimeId}`) as { value: string } | null
    return row?.value ?? 'initial'
  }
  rotateIdentity(runtimeId: string, epoch: string): void {
    this.db.query('INSERT INTO hx_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`catalog-auth:${runtimeId}`, epoch)
  }
  load(key: string): ModelSnapshot | undefined {
    const row = this.db.query('SELECT * FROM hx_model_catalog_snapshots WHERE identity_key=?').get(key) as { schema_version: number; models_json: string; content_hash: string; engine_fingerprint: string; last_success_at: number; fresh_until: number } | null
    if (!row) return
    if (row.schema_version !== 1 || !Number.isSafeInteger(row.last_success_at) || !Number.isSafeInteger(row.fresh_until) || row.last_success_at < 0 || row.fresh_until < row.last_success_at) throw new Error('CATALOG_SNAPSHOT_INVALID')
    const models: unknown = JSON.parse(row.models_json); validateCatalogModels(models)
    return { models, contentHash: row.content_hash, engineFingerprint: row.engine_fingerprint, lastSuccessAt: row.last_success_at, freshUntil: row.fresh_until }
  }
  attempt(key: string): CatalogAttempt | undefined {
    const row = this.db.query('SELECT * FROM hx_model_catalog_attempts WHERE identity_key=?').get(key) as { last_attempt_at: number; failure_count: number; last_error_code: string | null; next_retry_at: number | null } | null
    return row ? { lastAttemptAt: row.last_attempt_at, failureCount: row.failure_count, ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}), ...(row.next_retry_at === null ? {} : { nextRetryAt: row.next_retry_at }) } : undefined
  }
  success(key: string, runtimeConfigId: string, providerId: string, value: ModelSnapshot): void {
    validateCatalogModels(value.models)
    this.db.transaction(() => {
      this.db.query(`INSERT INTO hx_model_catalog_snapshots VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET schema_version=excluded.schema_version,models_json=excluded.models_json,content_hash=excluded.content_hash,engine_fingerprint=excluded.engine_fingerprint,last_success_at=excluded.last_success_at,fresh_until=excluded.fresh_until`).run(key, runtimeConfigId, providerId, 1, JSON.stringify(value.models), value.contentHash, value.engineFingerprint, value.lastSuccessAt, value.freshUntil)
      this.db.query('DELETE FROM hx_model_catalog_attempts WHERE identity_key=?').run(key)
    })()
  }
  failure(key: string, value: CatalogAttempt): void {
    this.db.query(`INSERT INTO hx_model_catalog_attempts VALUES(?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error_code=excluded.last_error_code,failure_count=excluded.failure_count,next_retry_at=excluded.next_retry_at`).run(key, value.lastAttemptAt, value.lastErrorCode ?? null, value.failureCount, value.nextRetryAt ?? null)
  }
}

export type CatalogStorage = Pick<CatalogStore, keyof CatalogStore>
