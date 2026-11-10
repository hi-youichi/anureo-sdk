import type { AhpEvent, Item, Usage } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { TurnResult } from './types';
import { immutable } from './value';

type TextField = 'text' | 'summary' | 'output';
interface RetainedItem {
  item: Item;
  bytes: number;
  text?: { field: TextField; chunks: string[]; lastCodeUnit?: number };
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
      const item = entry?.item;
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
    const pending = entry.text;
    if (!chunk.length && (pending || typeof previous === 'string')) return;
    const prefix = typeof previous === 'string' ? previous : '';
    const last = pending ? pending.lastCodeUnit : prefix.charCodeAt(prefix.length - 1);
    let added = Buffer.byteLength(JSON.stringify(chunk)) - 2;
    // JSON escapes isolated surrogates (6 bytes each), but a joined pair is 4 UTF-8 bytes.
    if (last !== undefined && last >= 0xd800 && last <= 0xdbff && chunk.charCodeAt(0) >= 0xdc00 && chunk.charCodeAt(0) <= 0xdfff) added -= 8;
    if (!pending && typeof previous !== 'string') {
      added += previous === undefined
        ? Buffer.byteLength(JSON.stringify(field)) + 4 // comma, colon and empty string quotes
        : 2 - Buffer.byteLength(JSON.stringify(previous));
    }
    if (this.bytes + added > this.maxBytes) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    const text = pending ?? { field, chunks: [prefix], lastCodeUnit: last };
    text.chunks.push(chunk);
    if (chunk.length) text.lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    entry.text = text;
    entry.bytes += added;
    this.bytes += added;
  }
  private put(item: Item): void {
    const size = Buffer.byteLength(JSON.stringify(item));
    const previous = this.items.get(item.id);
    const bytes = this.bytes - (previous?.bytes ?? 0) + size;
    if (bytes > this.maxBytes || (!previous && this.items.size >= this.maxItems)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    this.items.set(item.id, { item: structuredClone(item), bytes: size }); this.bytes = bytes;
  }
  finish(payload: Extract<AhpEvent, { type: 'turn/completed' }>['payload']): TurnResult {
    const items = [...this.items.values()].map(({ item, text }) => text ? { ...item, [text.field]: text.chunks.join('') } as Item : item);
    const text = items.filter((item): item is Extract<Item, { type: 'agentMessage' }> => item.type === 'agentMessage' && item.phase === 'final').map(item => item.text).join('\n');
    const usage = payload.usage?.scope === 'turn' ? payload.usage : this.usage;
    const common = { text, items, ...(usage ? { usage } : {}) };
    if (payload.status === 'failed') return immutable({ ...common, status: 'failed', error: payload.error ?? { code: 'TURN_FAILED', message: 'Turn failed', retryable: false, outcomeUnknown: false } });
    return immutable({ ...common, status: payload.status });
  }
  clear(): void { this.items.clear(); this.completed.clear(); this.usage = undefined; this.bytes = 0; }
}
