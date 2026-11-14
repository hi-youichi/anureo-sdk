/** Classifies native terminal evidence for public turn errors. */
import type { HarnessError } from '@anureo/protocol'
import { record } from './native-values'

/**
 * Return an AHP error value with fixed public text and outcomeUnknown false. Recognized native
 * categories and HTTP statuses determine code and retryable. Unknown evidence defaults to
 * NATIVE_TURN_FAILED. Details include only validated HTTP status evidence.
 *
 * CodexBackendSession.completeTurn publishes this value in turn/completed and supplies empty
 * evidence for failed turns with no error payload. Failed and interrupted turn results can
 * carry the error. Consumers decide whether to act on retryable.
 */
export function mapTurnError(value: unknown): HarnessError {
  const failure = nativeTurnFailure(value)
  return {
    ...classifyTurnFailure(failure),
    outcomeUnknown: false,
    ...(failure.httpStatusCode ? { details: { httpStatusCode: failure.httpStatusCode } } : {}),
  }
}

/** Classification evidence retained from native categories and connection errors. */
type NativeTurnFailure = {
  nativeCode?: string
  httpStatusCode?: number
  /** Whether a recognized connection variant was present, independently of its status code. */
  hasHttpFailure: boolean
}

/** Read the native category and the first recognized connection entry in native order, even if its status is invalid. */
function nativeTurnFailure(value: unknown): NativeTurnFailure {
  const info = record(value).codexErrorInfo
  const entries = info && typeof info === 'object' && !Array.isArray(info) ? Object.entries(info) : []
  const httpEntry = entries.find(([key]) => isConnectionFailure(key))
  const httpStatusCode = httpEntry ? record(httpEntry[1]).httpStatusCode : undefined
  return {
    nativeCode: typeof info === 'string' ? info : undefined,
    httpStatusCode: validHttpStatusCode(httpStatusCode),
    hasHttpFailure: httpEntry !== undefined,
  }
}

/** Recognize the native object variants that independently establish a connection failure. */
function isConnectionFailure(key: string): boolean {
  switch (key) {
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return true
    default:
      return false
  }
}

/** Accept only integer HTTP statuses in 100–599 for public error details and classification. */
function validHttpStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

/** Select fixed public text and a retry hint. Specific HTTP and category rules take precedence over the connection fallback. */
function classifyTurnFailure({ nativeCode, httpStatusCode: status, hasHttpFailure }: NativeTurnFailure): Pick<HarnessError, 'code' | 'message' | 'retryable'> {
  if (nativeCode === 'unauthorized' || status === 401) {
    return { code: 'AUTH_REQUIRED', message: 'Sign in to the independent Codex runtime before sending', retryable: false }
  }
  if (status === 403) {
    return { code: 'AUTH_FORBIDDEN', message: 'The selected Codex account cannot access this resource', retryable: false }
  }
  if (nativeCode === 'usageLimitExceeded') {
    return { code: 'USAGE_LIMIT_EXCEEDED', message: 'Codex account usage limit reached', retryable: false }
  }
  if (nativeCode === 'rateLimitExceeded' || status === 429) {
    return { code: 'RATE_LIMITED', message: 'Codex rate limit reached', retryable: true }
  }
  if (nativeCode === 'contextWindowExceeded') {
    return { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'Codex context window exceeded', retryable: false }
  }
  if (nativeCode === 'badRequest') {
    return { code: 'NATIVE_REQUEST_INVALID', message: 'Codex rejected the request', retryable: false }
  }
  if (nativeCode === 'serverOverloaded' || nativeCode === 'internalServerError' || (status !== undefined && status >= 500)) {
    return { code: 'NATIVE_SERVICE_UNAVAILABLE', message: 'Codex service is unavailable', retryable: true }
  }
  if (hasHttpFailure) {
    return { code: 'NATIVE_CONNECTION_FAILED', message: 'Codex connection to the model service failed', retryable: true }
  }
  return { code: 'NATIVE_TURN_FAILED', message: 'Codex turn failed', retryable: false }
}
