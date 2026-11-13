// Builds observation and owned-resource failure reports; must not close resources or control cleanup order.
import { HarnessSdkError, sdkError } from '../errors';

/** Build an outcome-unknown observation failure for session teardown; stopped records native confirmation without inventing a terminal execution result. No cleanup is performed. */
export function observationClosed(stopped = false): HarnessSdkError { return new HarnessSdkError('OBSERVATION_CLOSED', stopped ? 'Observation closed before a native terminal result' : 'Observation closed; execution stop is unconfirmed', false, true, { source: 'sdk', executionStopped: stopped ? 'confirmed' : 'unconfirmed' }); }
/** Build a privacy-safe aggregate for client/session resource owners from cleanup causes; deduplicate causes and flatten safe nested release codes without performing cleanup or throwing. */
export function combined(causes: unknown[]): HarnessSdkError {
  const errors = [...new Set(causes)].flatMap(cause => {
    const error = sdkError(cause);
    if (error.code === 'RESOURCE_RELEASE_FAILED' && Array.isArray(error.details?.errors)) {
      return error.details.errors.filter((value): value is { code: string; outcomeUnknown?: boolean } => !!value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(value.code)).map(value => ({ code: value.code, outcomeUnknown: value.outcomeUnknown === true }));
    }
    return [{ code: error.code, outcomeUnknown: error.outcomeUnknown }];
  });
  return new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'One or more owned resources could not be released', false, true,
    { source: 'sdk', errors });
}
