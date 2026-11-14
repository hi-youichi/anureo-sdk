import { HarnessSdkError } from '../errors';

/**
 * Validate the selected retention budget as a positive safe integer, using the caller's fallback
 * for an omitted value. Throw INVALID_PARAMS on failure. assertClientOptions checks configured
 * limits at construction. Session.context, getOrCreateSubmission and retainEvent use the returned
 * budget for allocation or accounting in units chosen at each call site.
 */
export function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new HarnessSdkError('INVALID_PARAMS');
  return result;
}
