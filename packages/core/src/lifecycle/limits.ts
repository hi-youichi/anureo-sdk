// Validates positive integer budgets; must not own queues or choose resource-specific defaults.
import { HarnessSdkError } from '../errors';

/** Return the explicit budget or fallback for runtime owners; throw INVALID_PARAMS unless the resolved value is a positive safe integer. Performs no allocation or I/O. */
export function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new HarnessSdkError('INVALID_PARAMS');
  return result;
}
