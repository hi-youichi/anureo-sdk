import type { AhpEvent, Item, Usage } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { TurnResult } from './types';
import { immutable } from './value';

type TextField = 'text' | 'summary' | 'output';
// While buffered, snapshot keeps its original field value; chunks include that
// prefix and all appended text. serializedBytes counts the materialized result.
// An authoritative snapshot replaces the entry, discarding its buffered text.
interface RetainedItem {
  snapshot: Item;
  serializedBytes: number;
  bufferedText?: { field: TextField; chunks: string[]; lastCodeUnit?: number };
}

/** Change in the materialized item's JSON byte size; joining surrogates can reduce it. */
function serializedTextAppendByteDelta(
  field: TextField,
  previous: unknown,
  chunk: string,
  lastCodeUnit: number | undefined,
  hasBufferedText: boolean,
): number {
  const chunkContentBytes = Buffer.byteLength(JSON.stringify(chunk)) - 2; // Exclude string quotes.
  let surrogatePairByteDelta = 0;
  if (lastCodeUnit !== undefined && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && chunk.charCodeAt(0) >= 0xdc00 && chunk.charCodeAt(0) <= 0xdfff) {
    // Replace two isolated JSON surrogate escapes (6 bytes each) with one UTF-8 pair (4 bytes).
    surrogatePairByteDelta = 4 - 2 * 6;
  }
  let fieldStructureByteDelta = 0;
  if (!hasBufferedText && typeof previous !== 'string') {
    fieldStructureByteDelta = previous === undefined
      ? Buffer.byteLength(JSON.stringify(field)) + 4 // Comma, colon and empty string quotes.
      : 2 - Buffer.byteLength(JSON.stringify(previous)); // Replace the previous value with empty string quotes.
  }
  return chunkContentBytes + surrogatePairByteDelta + fieldStructureByteDelta;
}

/** Deltas update provisional items; authoritative snapshots always replace them. */
export class ResultAccumulator {
  private readonly items = new Map<string, RetainedItem>();
  private readonly completed = new Set<string>();
  private bytes = 0;
  private usage?: Usage;
  constructor(private readonly maxBytes: number, private readonly maxItems: number) {}
  get size(): number { return this.bytes; }
  accept(event: AhpEvent): void {
    if (event.type === 'usage/updated' && event.payload.scope === 'turn') this.usage = structuredClone(event.payload);
    if (event.type === 'item/started' || event.type === 'item/completed') {
      this.put(event.payload.item);
      if (event.type === 'item/completed') this.completed.add(event.payload.item.id);
    } else if (event.type === 'item/delta' && !this.completed.has(event.payload.itemId)) {
      const entry = this.items.get(event.payload.itemId);
      const item = entry?.snapshot;
      const value = event.payload.value;
      if (event.payload.kind === 'patch' && value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) {
        // The event/privacy boundary already validates Item-shaped patches.
        // Their identity and discriminator must still match the existing item.
        if (!item || value.id !== item.id || value.type !== item.type) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item snapshot');
        this.put(value as unknown as Item); return;
      }
      if (!entry || !item || event.payload.text === undefined) return;
      const { kind, text } = event.payload;
      if (item.type === 'agentMessage' && kind === 'text') this.append(entry, 'text', item.text, text);
      else if (item.type === 'reasoning' && kind === 'reasoningSummary') this.append(entry, 'summary', item.summary, text);
      else if (item.type === 'toolCall' && kind === 'output') this.append(entry, 'output', item.output, text);
    }
  }
  private append(entry: RetainedItem, field: TextField, previous: unknown, chunk: string): void {
    const pending = entry.bufferedText;
    if (!chunk.length && (pending || typeof previous === 'string')) return;
    const prefix = typeof previous === 'string' ? previous : '';
    const last = pending ? pending.lastCodeUnit : prefix.charCodeAt(prefix.length - 1);
    const serializedByteDelta = serializedTextAppendByteDelta(field, previous, chunk, last, !!pending);
    if (this.bytes + serializedByteDelta > this.maxBytes) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    const bufferedText = pending ?? { field, chunks: [prefix], lastCodeUnit: last };
    bufferedText.chunks.push(chunk);
    if (chunk.length) bufferedText.lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    entry.bufferedText = bufferedText;
    entry.serializedBytes += serializedByteDelta;
    this.bytes += serializedByteDelta;
  }
  private put(item: Item): void {
    const size = Buffer.byteLength(JSON.stringify(item));
    const previous = this.items.get(item.id);
    const bytes = this.bytes - (previous?.serializedBytes ?? 0) + size;
    if (bytes > this.maxBytes || (!previous && this.items.size >= this.maxItems)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    this.items.set(item.id, { snapshot: structuredClone(item), serializedBytes: size }); this.bytes = bytes;
  }
  finish(payload: Extract<AhpEvent, { type: 'turn/completed' }>['payload']): TurnResult {
    const items = [...this.items.values()].map(({ snapshot, bufferedText }) => bufferedText
      ? { ...snapshot, [bufferedText.field]: bufferedText.chunks.join('') } as Item
      : snapshot);
    const text = items.filter((item): item is Extract<Item, { type: 'agentMessage' }> => item.type === 'agentMessage' && item.phase === 'final').map(item => item.text).join('\n');
    const usage = payload.usage?.scope === 'turn' ? payload.usage : this.usage;
    const common = { text, items, ...(usage ? { usage } : {}) };
    if (payload.status === 'failed') return immutable({ ...common, status: 'failed', error: payload.error ?? { code: 'TURN_FAILED', message: 'Turn failed', retryable: false, outcomeUnknown: false } });
    if (payload.status === 'interrupted') return immutable({ ...common, status: 'interrupted', ...(payload.error ? { error: payload.error } : {}) });
    return immutable({ ...common, status: payload.status });
  }
  clear(): void { this.items.clear(); this.completed.clear(); this.usage = undefined; this.bytes = 0; }
}
