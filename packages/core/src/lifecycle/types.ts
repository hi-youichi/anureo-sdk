import type { HarnessError, InputBlock, Item, Usage } from '@anureo/protocol';
export type Input = string | readonly InputBlock[];
export type TurnResult = { text: string; items: readonly Item[]; usage?: Usage } & (
  { status: 'completed' } | { status: 'interrupted'; error?: HarnessError } | { status: 'failed'; error: HarnessError }
);
