// Normalizes caught errors for reports and presentation; it must not choose recovery or cleanup actions.
import type { Failure } from './results'

/** Return display text for caught host/CLI values without I/O or changing the caught value.
 * Uses Error.message or String conversion; custom conversion/accessors can still throw. */
export function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
/** Return SDK-compatible failure signals for lifecycle/step callers without I/O, retries or mutation.
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
