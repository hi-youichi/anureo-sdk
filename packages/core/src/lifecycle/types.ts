// Defines input and terminal result values; must not perform dispatch or retain execution state.
import type { HarnessError, InputBlock, Item, Usage } from '@anureo/protocol';
/** Host submission/steering input; strings normalize to one text block and arrays are cloned before dispatch. */
export type Input = string | readonly InputBlock[];
/** Immutable observed terminal snapshot, not authoritative native history; text joins final agent messages and failure status retains a safe error. */
export type TurnResult = { text: string; items: readonly Item[]; usage?: Usage } & (
  { status: 'completed' } | { status: 'interrupted'; error?: HarnessError } | { status: 'failed'; error: HarnessError }
);
