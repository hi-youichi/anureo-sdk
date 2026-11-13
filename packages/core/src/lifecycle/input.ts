// Normalizes host input into detached protocol blocks; must not validate capabilities or dispatch submissions.
import type { InputBlock } from '@anureo/protocol';
import { HarnessSdkError } from '../sdk-error';
import type { Input } from './types';

/** Return text as one protocol block or clone an input block array for Session; throw INVALID_PARAMS for non-array or unclonable input. Does not check capability support. */
export function inputBlocks(input: Input): InputBlock[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!Array.isArray(input)) throw new HarnessSdkError('INVALID_PARAMS');
  try { return structuredClone(input); } catch { throw new HarnessSdkError('INVALID_PARAMS'); }
}
