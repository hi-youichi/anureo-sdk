// Normalizes caught errors for reports and presentation; it must not choose recovery or cleanup actions.
import type { Failure } from './results'

/** Internal display conversion used by agent work, run lifecycle, checks and CLI diagnostics.
 * Uses Error.message or String conversion; custom conversion/accessors can still throw. */
export function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
/** Internal classification recorded by agent work and run lifecycle alongside caught error text.
 * Returns signals from object values, or null code and false flags for primitives and functions.
 * Cleanup recognizes the resource-release code, explicit true flag or nonempty cleanup-error array;
 * execution uncertainty requires explicit true and remains independent. Custom accessors can throw. */
export function failure(cause: unknown): Failure {
  const error = (cause && typeof cause === 'object' ? cause : {}) as {
    outcomeUnknown?: boolean
    code?: unknown
    details?: Record<string, unknown>
  }
  return {
    code: typeof error.code === 'string' ? error.code : null,
    outcomeUnknown: error.outcomeUnknown === true,
    cleanupFailed: error.code === 'RESOURCE_RELEASE_FAILED' || error.details?.cleanupFailed === true
      || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0),
  }
}
