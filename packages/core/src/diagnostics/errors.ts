// Projects failure classifications without retaining native error text.
/**
 * Classify a catalog failure for reporting without disclosing raw text. Return the allowlisted
 * string or CATALOG_QUERY_FAILED. An object's own or inherited code property takes precedence,
 * even when invalid. An Error without that property uses its message as the candidate.
 * Property getters and proxy traps may throw synchronously. catalogPhase's failure report uses
 * the returned value as errorCode.
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
 * Internal to diagnostics. reportCatalogFailure reads this value for the event's nativeRpcCode.
 * Return undefined for a missing or nonnumeric rpcCode. Preserve separate reads for the type
 * check and the returned value, which an accessor can observe. Property getters and proxy traps
 * can throw synchronously, preventing the report and replacing the phase rejection.
 */
export function readNativeRpcCode(cause: unknown): number | undefined {
  if (!cause || typeof cause !== 'object' || !('rpcCode' in cause)) return undefined
  if (typeof cause.rpcCode !== 'number') return undefined
  return cause.rpcCode
}

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
