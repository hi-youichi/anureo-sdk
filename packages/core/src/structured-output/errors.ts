// Builds output failure envelopes and classifies settled cleanup results.
import type { HarnessError, JsonObject } from '@anureo/protocol'
import { HarnessSdkError, sdkError } from '../errors'

/**
 * Return a nonretryable, known-outcome protocol failure using the code as its message.
 * OutputSession.bind retains binding conflicts, submitCandidate returns these failures on candidate
 * rejection and publishOutput embeds them in failed terminals consumed by Session and Turn.result.
 * Supply safe codes and JSON-compatible details. Details are retained by reference.
 */
export function failure(code: string, details?: Record<string, unknown>): HarnessError {
  return { code, message: code, retryable: false, outcomeUnknown: false, ...(details ? { details: details as JsonObject } : {}) }
}

/**
 * withStructuredOutput.dispose and OutputSession.release/dispose call this after owned release stages
 * settle. Return void when all attempts fulfilled, throw the single normalized failure, or aggregate
 * multiple failures with flattened release diagnostics. The aggregate outcome is unknown if any
 * normalized cause has an unknown outcome. sdkError preserves existing SDK errors.
 * Callers still own every cleanup
 * attempt and decide how the resulting rejection reaches Client or Session disposal consumers.
 */
export function checkRelease(results: PromiseSettledResult<unknown>[]): void {
  const causes = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => sdkError(result.reason, 'RESOURCE_RELEASE_FAILED', true))
  if (causes.length === 0) return
  if (causes.length === 1) throw causes[0]
  const errors = causes.flatMap(error => error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors)
    ? error.details.errors
    : [{ code: error.code, outcomeUnknown: error.outcomeUnknown }])
  throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output resources could not be released', false,
    causes.some(error => error.outcomeUnknown), { errors })
}
