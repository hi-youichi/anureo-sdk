// Reports observation loss and cleanup failures; must not release resources or choose teardown order.
import { HarnessSdkError, sdkError } from '../errors';

/**
 * Construct the package-internal error used to reject unfinished Turn results and streams.
 * Session.finishClose passes native stop confirmation; Session.dispose uses the unconfirmed default.
 * Even confirmed stop supplies no terminal result, so outcomeUnknown stays true. Callers still own
 * interaction cancellation and backend release; constructing this error performs neither.
 */
export function observationClosed({ executionStopped = 'unconfirmed' }: { executionStopped?: 'confirmed' | 'unconfirmed' } = {}): HarnessSdkError {
  const message = executionStopped === 'confirmed'
    ? 'Observation closed before a native terminal result'
    : 'Observation closed; execution stop is unconfirmed';
  return new HarnessSdkError('OBSERVATION_CLOSED', message, false, true,
    { source: 'sdk', executionStopped });
}

/**
 * Construct a package-internal aggregate of cleanup failures without releasing resources.
 * Client.dispose and Session.finishClose throw this after their release attempts; the client's
 * rethrowAfterCleanup uses it when setup and cleanup both fail. Return a privacy-safe SDK aggregate,
 * deduplicating cause identity and flattening nested release codes in order. Callers own every
 * cleanup attempt and propagation to the host; this function only constructs the error.
 */
export function combined(causes: unknown[]): HarnessSdkError {
  const errors = [...new Set(causes)].flatMap(releaseDiagnostics);
  return new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'One or more owned resources could not be released', false, true,
    { source: 'sdk', errors });
}

/** Safe nested release diagnostic accepted by isReleaseDiagnostic; raw messages must never be copied. */
interface ReleaseDiagnostic {
  code: string;
  /** Only literal true survives normalization into the returned aggregate. */
  outcomeUnknown?: boolean;
}

/**
 * releaseDiagnostics filters nested aggregates with this guard before copying their codes. Accept
 * only bounded machine-readable codes; do not trust nested messages or arbitrary error details.
 */
function isReleaseDiagnostic(value: unknown): value is ReleaseDiagnostic {
  return !!value && typeof value === 'object' && 'code' in value
    && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(value.code);
}

/**
 * combined flat-maps each distinct cause through this normalization. Flatten an existing release
 * aggregate or return one safe code/unknown flag, preserving input order and discarding raw causes.
 * No cleanup is attempted; callers decide when to throw the aggregate.
 */
function releaseDiagnostics(cause: unknown): ReleaseDiagnostic[] {
  const error = sdkError(cause);
  if (error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors)) {
    return error.details.errors.filter(isReleaseDiagnostic)
      .map(value => ({ code: value.code, outcomeUnknown: value.outcomeUnknown === true }));
  }
  return [{ code: error.code, outcomeUnknown: error.outcomeUnknown }];
}
