// Owns output failure envelopes and release-result classification. Cleanup execution and ordering stay with resource owners.
import type { HarnessError, JsonObject } from '@anureo/protocol'
import { HarnessSdkError, sdkError } from '../errors'

/**
 * OutputSession.bind and submitCandidate retain these failures, while publishOutput embeds them in
 * failed terminals consumed by Session and Turn.result. Return a nonretryable, known-outcome protocol
 * envelope using the code as its message. Callers must supply safe codes/details because this helper
 * retains details by reference and performs no sanitization or cleanup.
 */
export function failure(code: string, details?: Record<string, unknown>): HarnessError {
  return { code, message: code, retryable: false, outcomeUnknown: false, ...(details ? { details: details as JsonObject } : {}) }
}
/**
 * withStructuredOutput.dispose and OutputSession.release/dispose call this after owned release stages
 * settle. Return void when all attempts fulfilled, throw the single normalized failure, or aggregate
 * multiple failures with flattened release diagnostics and their unknown-outcome flags. Native error
 * normalization uses sdkError, which preserves existing SDK errors. Callers still own every cleanup
 * attempt and decide how the resulting rejection reaches Client or Session disposal consumers.
 */
export function checkRelease(results: PromiseSettledResult<unknown>[]): void {
  const causes = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => sdkError(result.reason, 'RESOURCE_RELEASE_FAILED', true))
  if (causes.length === 1) throw causes[0]
  if (causes.length) {
    const errors = causes.flatMap(error => error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors)
      ? error.details.errors
      : [{ code: error.code, outcomeUnknown: error.outcomeUnknown }])
    throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Structured output resources could not be released', false,
      causes.some(error => error.outcomeUnknown), { errors })
  }
}
