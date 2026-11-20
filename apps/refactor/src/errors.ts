// Normalizes caught errors for reports and diagnostics.
import type { Failure } from './results'

/** Convert a caught value for display, including values with throwing accessors or conversions. */
export function message(cause: unknown): string {
  try {
    return String(cause instanceof Error ? cause.message : cause)
  } catch {
    return 'Error details could not be displayed'
  }
}

/** Extract execution and resource-release signals independently from a caught object.
 * executeRun stores the result on the report. markFailed stores it on the first step failure
 * and merges later cleanup signals into that failure. Primitives and functions yield a null code
 * and false flags. Execution uncertainty requires an explicit true. Custom accessors can throw. */
export function failure(cause: unknown): Failure {
  const error = (cause && typeof cause === 'object' ? cause : {}) as FailureSource
  const issues = validationIssues(error.details?.issues)
  return {
    code: typeof error.code === 'string' ? error.code : null,
    outcomeUnknown: error.outcomeUnknown === true,
    cleanupFailed: hasCleanupFailure(error),
    retryable: error.retryable === true,
    ...(issues.length ? { issues } : {}),
  }
}

interface FailureSource {
  outcomeUnknown?: unknown
  retryable?: unknown
  code?: unknown
  details?: Record<string, unknown>
}

/** Recognize resource-release failures reported by code, explicit flag, or cleanup errors. */
function hasCleanupFailure(error: FailureSource): boolean {
  return error.code === 'RESOURCE_RELEASE_FAILED' || error.details?.cleanupFailed === true
    || (Array.isArray(error.details?.cleanupErrors) && error.details.cleanupErrors.length > 0)
}

/** Keep field locations and rule codes without copying other validation details. */
function validationIssues(candidates: unknown): NonNullable<Failure['issues']> {
  const issues: NonNullable<Failure['issues']> = []
  if (!Array.isArray(candidates)) return issues
  for (const issue of candidates) {
    if (!issue || typeof issue !== 'object') continue
    const { path, code } = issue
    if (typeof code !== 'string' || !code) continue
    if (typeof path === 'string') {
      issues.push({ path, code })
    } else if (Array.isArray(path)) {
      const parts = [...path]
      if (parts.every(part => typeof part === 'string'
        || (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0))) {
        issues.push({ path: parts, code })
      }
    }
  }
  return issues
}
