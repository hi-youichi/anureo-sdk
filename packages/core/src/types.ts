// Defines public input, result, and observation types.
import type { HarnessError, InputBlock, Item, Usage } from '@anureo/protocol';
/** Host submission/steering input; strings normalize to one text block and arrays are cloned before dispatch. */
export type Input = string | readonly InputBlock[];
/** Immutable observed terminal snapshot, not authoritative native history; text joins final agent messages and failure status retains a safe error. */
export type TurnResult = { text: string; items: readonly Item[]; usage?: Usage } & (
  { status: 'completed' } | { status: 'interrupted'; error?: HarnessError } | { status: 'failed'; error: HarnessError }
);

/** Controls only a caller’s observation wait; abort/deadline never interrupt an accepted native operation. */
export interface RequestOptions {
  /** Stops this caller waiting; does not interrupt accepted native execution. */
  signal?: AbortSignal;
  /** Positive observation deadline in milliseconds; omission uses the operation default. */
  timeoutMs?: number;
}

/** Per-observer cancellation and buffering; signal ends only this subscription and queue overflow never pauses the shared native producer. */
export interface EventSubscriptionOptions {
  /** Aborts only this observer, releasing its pending read and membership. */
  signal?: AbortSignal;
  /** Per-subscription regular-event capacity in count and serialized bytes. */
  queue?: { maxEvents?: number; maxBytes?: number };
}
