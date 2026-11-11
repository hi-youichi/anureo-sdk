import type { InputBlock } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { Input } from './types';
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry && typeof entry === 'object') {
      for (const child of Object.values(entry)) {
        freeze(child);
      }
      Object.freeze(entry);
    }
  };
  freeze(copy);
  return copy;
}
export function inputBlocks(input: Input): InputBlock[] {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (!Array.isArray(input)) throw new HarnessSdkError('INVALID_PARAMS');
  try { return structuredClone(input); } catch { throw new HarnessSdkError('INVALID_PARAMS'); }
}
export function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new HarnessSdkError('INVALID_PARAMS');
  return result;
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Avoid unhandled rejections before callers attach a handler. Returning the
  // original promise below preserves its rejection for callers.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
