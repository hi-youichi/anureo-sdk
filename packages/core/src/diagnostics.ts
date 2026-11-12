import { getLogger } from '@logtape/logtape'

const catalogLogger = getLogger(['anureo', 'catalog'])

export interface CatalogProbeEvent {
  phase: 'spawn' | 'handshake' | 'models' | 'dispose'
  outcome: 'started' | 'success' | 'error' | 'cancelled'
  durationMs?: number
  errorCode?: string
  nativeRpcCode?: number
}
export interface CatalogProbeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onPhase?: (event: CatalogProbeEvent) => void
}
const publicCodes = new Set(['AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'HARNESS_UNAVAILABLE', 'HARNESS_CONFIG_INVALID', 'REQUEST_TIMEOUT', 'RPC_ABORTED', 'CATALOG_REFRESH_TIMEOUT', 'CATALOG_CANCELLED', 'CATALOG_LIMIT_EXCEEDED', 'CATALOG_SNAPSHOT_INVALID', 'CATALOG_MODELS_INVALID', 'MODELS_UNAVAILABLE', 'NATIVE_RPC_ERROR', 'PROTOCOL_ERROR', 'CONNECTION_CLOSED', 'RUNTIME_DISPOSED', 'PROCESS_DISPOSE_FAILED', 'PROCESS_WRITE_FAILED', 'FRAME_TOO_LARGE', 'MODEL_LIMIT_EXCEEDED', 'BACKPRESSURE_EXCEEDED', 'COMMAND_FORMAT_UNSUPPORTED', 'EXECUTABLE_NOT_FOUND', 'ENOENT', 'EACCES', 'EPERM'])
export function safeCatalogErrorCode(cause: unknown): string {
  let code: unknown
  if (cause && typeof cause === 'object' && 'code' in cause) {
    code = cause.code
  } else if (cause instanceof Error) {
    code = cause.message
  }
  return typeof code === 'string' && publicCodes.has(code) ? code : 'CATALOG_QUERY_FAILED'
}
export function emitCatalogPhase(options: CatalogProbeOptions, event: CatalogProbeEvent): void {
  logCatalogPhase(event)
  try { options.onPhase?.(event) } catch { /* Diagnostics never own execution. */ }
}

function logCatalogPhase(event: CatalogProbeEvent): void {
  try {
    const properties = {
      phase: event.phase,
      outcome: event.outcome,
      ...(event.durationMs === undefined ? {} : { durationMs: Math.round(event.durationMs) }),
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      ...(event.nativeRpcCode === undefined ? {} : { nativeRpcCode: event.nativeRpcCode }),
    }
    if (event.outcome === 'error') catalogLogger.error('catalog {phase} {outcome}', properties)
    else if (event.outcome === 'cancelled') catalogLogger.warn('catalog {phase} {outcome}', properties)
    else catalogLogger.debug('catalog {phase} {outcome}', properties)
  } catch { /* Logging never owns execution either. */ }
}
export async function catalogPhase<T>(options: CatalogProbeOptions, phase: CatalogProbeEvent['phase'], work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  emitCatalogPhase(options, { phase, outcome: 'started' })
  try {
    if (options.signal?.aborted) throw Object.assign(new Error('RPC_ABORTED'), { code: 'RPC_ABORTED' })
    const result = await work()
    if (options.signal?.aborted) throw Object.assign(new Error('RPC_ABORTED'), { code: 'RPC_ABORTED' })
    emitCatalogPhase(options, { phase, outcome: 'success', durationMs: performance.now() - started })
    return result
  } catch (cause) {
    const code = safeCatalogErrorCode(cause)
    const nativeRpcCode = cause && typeof cause === 'object' && 'rpcCode' in cause && typeof cause.rpcCode === 'number' ? cause.rpcCode : undefined
    emitCatalogPhase(options, {
      phase,
      outcome: options.signal?.aborted ? 'cancelled' : 'error',
      durationMs: performance.now() - started,
      errorCode: code,
      ...(nativeRpcCode === undefined ? {} : { nativeRpcCode }),
    })
    throw cause
  }
}
