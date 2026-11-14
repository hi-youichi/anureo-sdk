import type { InputBlock } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { Input } from '../types';

/**
 * Normalize host input into one text block for a string or a detached copy of a block array.
 * Throw INVALID_PARAMS for other values or clone failure. Session.submit and the callback installed
 * by Session.context for Turn.steer pass the resulting blocks to request admission, which validates
 * their contents and capabilities. Both expose normalization failures as promise rejections.
 */
export function inputBlocks(input: Input): InputBlock[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!Array.isArray(input)) throw new HarnessSdkError('INVALID_PARAMS');
  try { return structuredClone(input); } catch { throw new HarnessSdkError('INVALID_PARAMS'); }
}
