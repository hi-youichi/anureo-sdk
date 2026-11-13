// Checks integer retention budgets; must not allocate storage or select resource-specific defaults.
import { HarnessSdkError } from '../errors';

/**
 * Client's assertClientOptions rejects invalid retention settings with this check. Session.context,
 * record and retainEvent also use the returned explicit value or fallback for execution, submission
 * and result budgets. Throw INVALID_PARAMS unless it is a positive safe integer; callers retain
 * allocation, admission and overflow handling. This check changes no state and performs no I/O.
 */
export function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new HarnessSdkError('INVALID_PARAMS');
  return result;
}
