import type { CatalogProbeOptions, CatalogProbeEvent } from '@anureo/sdk/diagnostics'
import type { CatalogModel } from './catalog-store'
export { safeCatalogErrorCode as catalogErrorCode } from '@anureo/sdk/diagnostics'
export interface CatalogWorker {
  prepare(options: CatalogProbeOptions): Promise<void>
  readModels(options: CatalogProbeOptions): Promise<readonly CatalogModel[]>
  dispose(): Promise<void>
}
export interface CatalogDiagnostic {
  event: string; runtimeConfigId: string; providerId: string; generation: number
  refreshId?: string; trigger?: string; phase?: CatalogProbeEvent['phase'] | 'queue' | 'persist'
  outcome?: string; durationMs?: number; totalDurationMs?: number; cacheAgeMs?: number
  modelCount?: number; errorCode?: string; nativeRpcCode?: number; retainedSnapshot?: boolean; nextRetryAt?: number
}
