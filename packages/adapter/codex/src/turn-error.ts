/** Classifies native turn failures into safe public errors; diagnostic disclosure and retry execution must not happen here. */
import type { HarnessError } from '@anureo/protocol'
import { record } from './native-values'

/** Validated evidence used by the classifier; provider diagnostics are deliberately excluded. */
type NativeTurnFailure = {
  nativeCode?: string
  httpStatusCode?: number
  /** A recognized connection variant remains retryable even without a valid HTTP status. */
  hasHttpFailure: boolean
}

/** For session completion and public mapping callers, return a definite failure using only typed categories and valid HTTP status. No retries, I/O or mutation; unknown categories and provider messages never escape. */
export function mapTurnError(value: unknown): HarnessError {
  const failure = nativeTurnFailure(value)
  return {
    ...classifyTurnFailure(failure),
    outcomeUnknown: false,
    ...(failure.httpStatusCode ? { details: { httpStatusCode: failure.httpStatusCode } } : {}),
  }
}

/** Read classification evidence for mapTurnError without effects. Preserve the first recognized connection entry in native order; an invalid status must not erase evidence of a connection failure. */
function nativeTurnFailure(value: unknown): NativeTurnFailure {
  const info = record(value).codexErrorInfo
  const entries = info && typeof info === 'object' && !Array.isArray(info) ? Object.entries(info) : []
  const httpEntry = entries.find(([key]) => [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ].includes(key))
  const httpStatusCode = httpEntry ? record(httpEntry[1]).httpStatusCode : undefined
  const status = typeof httpStatusCode === 'number'
    && Number.isInteger(httpStatusCode)
    && httpStatusCode >= 100
    && httpStatusCode <= 599
    ? httpStatusCode
    : undefined
  return {
    nativeCode: typeof info === 'string' ? info : httpEntry?.[0],
    httpStatusCode: status,
    hasHttpFailure: httpEntry !== undefined,
  }
}

/** Choose fixed public text for mapTurnError without effects. Keep precedence explicit: auth status wins before native usage/rate categories, and recognized connection failures are the final retryable fallback. */
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
