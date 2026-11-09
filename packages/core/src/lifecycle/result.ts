import type { AhpEvent, Item, Usage } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { TurnResult } from './types';
import { immutable } from './value';

/** Deltas update provisional items; authoritative snapshots always replace them. */
export class ResultAccumulator {
  private readonly items = new Map<string, Item>();
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
      const item = this.items.get(event.payload.itemId);
      const value = event.payload.value;
      if (event.payload.kind === 'patch' && value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) {
        // The event/privacy boundary already validates Item-shaped patches.
        // Their identity and discriminator must still match the existing item.
        if (!item || value.id !== item.id || value.type !== item.type) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item snapshot');
        this.put(value as unknown as Item); return;
      }
      if (!item || event.payload.text === undefined) return;
      const next = structuredClone(item), { kind, text } = event.payload;
      if (next.type === 'agentMessage' && kind === 'text') next.text += text;
      else if (next.type === 'reasoning' && kind === 'reasoningSummary') next.summary = (next.summary ?? '') + text;
      else if (next.type === 'toolCall' && kind === 'output') next.output = (typeof next.output === 'string' ? next.output : '') + text;
      this.put(next);
    }
  }
  private put(item: Item): void {
    const size = (value: Item) => Buffer.byteLength(JSON.stringify(value));
    const previous = this.items.get(item.id);
    const bytes = this.bytes - (previous ? size(previous) : 0) + size(item);
    if (bytes > this.maxBytes || (!previous && this.items.size >= this.maxItems)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    this.items.set(item.id, structuredClone(item)); this.bytes = bytes;
  }
  finish(payload: Extract<AhpEvent, { type: 'turn/completed' }>['payload']): TurnResult {
    const items = [...this.items.values()];
    const text = items.filter((item): item is Extract<Item, { type: 'agentMessage' }> => item.type === 'agentMessage' && item.phase === 'final').map(item => item.text).join('\n');
    const usage = payload.usage?.scope === 'turn' ? payload.usage : this.usage;
    const common = { text, items, ...(usage ? { usage } : {}) };
    if (payload.status === 'failed') return immutable({ ...common, status: 'failed', error: payload.error ?? { code: 'TURN_FAILED', message: 'Turn failed', retryable: false, outcomeUnknown: false } });
    return immutable({ ...common, status: payload.status });
  }
  clear(): void { this.items.clear(); this.completed.clear(); this.usage = undefined; this.bytes = 0; }
}
