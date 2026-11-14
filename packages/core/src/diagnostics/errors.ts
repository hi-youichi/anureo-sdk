// Projects failure classifications without retaining native error text.
/**
 * Project a catalog failure to an allowlisted code or CATALOG_QUERY_FAILED without retaining raw
 * text. An object's code property takes precedence, even when invalid; only Errors without that
 * property fall back to their message. Property getters and proxy traps may throw synchronously.
 * catalogPhase uses the result in its terminal report; direct diagnostics consumers can do the same.
 */
export function safeCatalogErrorCode(cause: unknown): string {
  let code: unknown
  if (cause && typeof cause === 'object' && 'code' in cause) {
    code = cause.code
  } else if (cause instanceof Error) {
    code = cause.message
  }
  return typeof code === 'string' && safeCatalogCodes.has(code) ? code : 'CATALOG_QUERY_FAILED'
}
/**
 * Internal helper for catalogPhase's failure report: read rpcCode when its type check is numeric,
 * otherwise return undefined. No coercion or range validation is applied; accessors are read for
 * both the type check and the returned value. Property getters and proxy traps may throw, replacing
 * the phase rejection before its terminal report is emitted.
 */
export function readNativeRpcCode(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object' || !('rpcCode' in cause)) return undefined
  if (typeof cause.rpcCode !== 'number') return undefined
  return cause.rpcCode
}

/** Keep safeCatalogErrorCode's disclosure policy in one allowlist, independent of native messages. */
const safeCatalogCodes = new Set([
  'AUTH_REQUIRED',
  'AUTH_FORBIDDEN',
  'HARNESS_UNAVAILABLE',
  'HARNESS_CONFIG_INVALID',
  'REQUEST_TIMEOUT',
  'RPC_ABORTED',
  'CATALOG_REFRESH_TIMEOUT',
  'CATALOG_CANCELLED',
  'CATALOG_LIMIT_EXCEEDED',
  'CATALOG_SNAPSHOT_INVALID',
  'CATALOG_MODELS_INVALID',
  'MODELS_UNAVAILABLE',
  'NATIVE_RPC_ERROR',
  'PROTOCOL_ERROR',
  'CONNECTION_CLOSED',
  'RUNTIME_DISPOSED',
  'PROCESS_DISPOSE_FAILED',
  'PROCESS_WRITE_FAILED',
  'FRAME_TOO_LARGE',
  'MODEL_LIMIT_EXCEEDED',
  'BACKPRESSURE_EXCEEDED',
  'COMMAND_FORMAT_UNSUPPORTED',
  'EXECUTABLE_NOT_FOUND',
  'ENOENT',
  'EACCES',
  'EPERM',
])
