// Normalizes caught errors for reports and diagnostics.
import type { Failure } from './results'

/** Convert a caught value for display using Error.message or String conversion.
 * Custom accessors or conversions can throw. */
export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Extract execution and resource-release signals independently from a caught object.
 * executeRun stores the result on the report. markFailed stores it on the first step failure
 * and merges later cleanup signals into that failure. Primitives and functions yield a null code
 * and false flags. Execution uncertainty requires an explicit true. Custom accessors can throw. */
export function failure(cause: unknown): Failure {
  const error = (cause && typeof cause === 'object' ? cause : {}) as FailureSource
  return {
    code: typeof error.code === 'string' ? error.code : null,
    outcomeUnknown: error.outcomeUnknown === true,
    cleanupFailed: hasCleanupFailure(error),
  }
}

interface FailureSource {
  outcomeUnknown?: unknown
  code?: unknown
  details?: Record<string, unknown>
}

/** Recognize resource-release failures reported by code, explicit flag, or cleanup errors. */
function hasCleanupFailure(error: FailureSource): boolean {
  return error.code === 'RESOURCE_RELEASE_FAILED' || error.details?.cleanupFailed === true
    || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
}
