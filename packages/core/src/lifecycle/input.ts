// Detaches host input as protocol blocks; must not admit requests, check capabilities or dispatch work.
import type { InputBlock } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { Input } from '../types';

/**
 * Session.submit and the Turn.steer callback installed by Session.context call before request
 * admission. Return one text block for a string or a detached clone of an array; throw INVALID_PARAMS
 * for other values or clone failure. The callers pass the result to submission/control dispatch,
 * where protocol shape and capability checks still belong; normalization performs no native work.
 */
export function inputBlocks(input: Input): InputBlock[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!Array.isArray(input)) throw new HarnessSdkError('INVALID_PARAMS');
  try { return structuredClone(input); } catch { throw new HarnessSdkError('INVALID_PARAMS'); }
}
