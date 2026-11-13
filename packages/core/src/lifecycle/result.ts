// Retains bounded execution results; must not validate wire events, publish events or own session lifetimes.
import type { AhpEvent, Item, Usage } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { TurnResult } from '../types';
import { immutable } from './immutable';

/** Fields acceptDelta can reconstruct provisionally; authoritative snapshots replace their buffers. */
type TextField = 'text' | 'summary' | 'output';
/** Mutable retention owned by ResultAccumulator; finish materializes buffers without changing this state. */
interface RetainedItem {
  /** Detached authoritative value, kept separate from provisional text. */
  snapshot: Item;
  /** JSON bytes of the item after applying buffered text, excluding any surrounding array. */
  serializedBytes: number;
  /** One supported text field per item family; chunks avoid rebuilding the full string on every delta. */
  bufferedText?: { field: TextField; chunks: string[]; lastCodeUnit?: number };
}

/**
 * ResultAccumulator.append uses this pure calculation before reserving bytes. Inputs describe the
 * authoritative field and any existing buffer; return the exact JSON byte change for the new chunk.
 * Accounting must join split UTF-16 pairs just as eventual string materialization does.
 */
function serializedTextAppendByteDelta({ field, previous, chunk, lastCodeUnit, bufferedText }: {
  field: TextField;
  previous: unknown;
  chunk: string;
  lastCodeUnit: number | undefined;
  bufferedText: RetainedItem['bufferedText'];
}): number {
  const chunkContentBytes = Buffer.byteLength(JSON.stringify(chunk)) - 2; // Exclude string quotes.
  let surrogatePairByteDelta = 0;
  if (lastCodeUnit !== undefined && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && chunk.charCodeAt(0) >= 0xdc00 && chunk.charCodeAt(0) <= 0xdfff) {
    // Replace two isolated JSON surrogate escapes (6 bytes each) with one UTF-8 pair (4 bytes).
    surrogatePairByteDelta = 4 - 2 * 6;
  }
  let fieldStructureByteDelta = 0;
  if (!bufferedText && typeof previous !== 'string') {
    fieldStructureByteDelta = previous === undefined
      ? Buffer.byteLength(JSON.stringify(field)) + 4 // Comma, colon and empty string quotes.
      : 2 - Buffer.byteLength(JSON.stringify(previous)); // Replace the previous value with empty string quotes.
  }
  return chunkContentBytes + surrogatePairByteDelta + fieldStructureByteDelta;
}

/**
 * ResultAccumulator.finish maps retained entries through this callback in first-seen item order.
 * Overlay provisional text without consuming its buffer; finish still owns detaching/freezing the
 * result, since entries without buffers return their retained snapshot directly.
 */
function materializeItem({ snapshot, bufferedText }: RetainedItem): Item {
  return bufferedText
    ? { ...snapshot, [bufferedText.field]: bufferedText.chunks.join('') } as Item
    : snapshot;
}

/**
 * ResultAccumulator.finish derives host-visible text from materialized items. Keep final messages in
 * retained order, including empty messages and their separators; interim messages remain in items.
 */
function finalMessageText(items: readonly Item[]): string {
  return items
    .filter((item): item is Extract<Item, { type: 'agentMessage' }> => item.type === 'agentMessage' && item.phase === 'final')
    .map(item => item.text)
    .join('\n');
}

/**
 * Session.context creates one accumulator per execution; Session.retainEvent feeds privacy-projected
 * events in publication order and resolves its terminal snapshot to Turn.result. Retention is detached
 * and bounded, but Session still owns wire validation, shared budgets, publication and reclamation.
 */
export class ResultAccumulator {
  private readonly items = new Map<string, RetainedItem>();
  private readonly completed = new Set<string>();
  private bytes = 0;
  private usage?: Usage;
  /**
   * Session.context supplies validated positive byte/item limits for one execution. Construction
   * allocates no native resources; Session must feed validated events in publication order.
   */
  constructor(private readonly maxBytes: number, private readonly maxItems: number) {}
  /**
   * Session.retainEvent measures retention changes here; Session.reclaimExecution subtracts this count
   * on eviction. Count materialized item JSON bytes, including buffered text but excluding usage and
   * the terminal result envelope; reading does not materialize buffers.
   */
  get size(): number { return this.bytes; }
  /**
   * Session.retainEvent calls before execution-event publication. Retain detached turn usage and item
   * content; conflicting patches or item/byte overflow throw into Session.emit's failure chain, which
   * rejects unfinished Turn.result waits through Session.fail. Completed items ignore later deltas;
   * Session remains responsible for validating event order and enforcing its shared byte budget.
   */
  accept(event: AhpEvent): void {
    if (event.type === 'usage/updated' && event.payload.scope === 'turn') this.usage = structuredClone(event.payload);
    this.acceptItemEvent(event);
  }
  /**
   * accept routes item events here after usage handling. Replace authoritative snapshots before
   * marking completion so failed retention cannot suppress later deltas; put failures propagate.
   */
  private acceptItemEvent(event: AhpEvent): void {
    if (event.type === 'item/started' || event.type === 'item/completed') {
      this.put(event.payload.item);
      if (event.type === 'item/completed') this.completed.add(event.payload.item.id);
      return;
    }
    if (event.type !== 'item/delta' || this.completed.has(event.payload.itemId)) return;
    this.acceptDelta(event);
  }
  /**
   * acceptItemEvent passes unfinished deltas here. Item-shaped patches must preserve the retained ID
   * and family or throw PROTOCOL_ERROR; valid patches replace provisional content through put. Text
   * deltas append only to their matching family/field; missing items and unsupported kinds are inert.
   * Retention failures propagate to accept rather than publishing a partially applied delta.
   */
  private acceptDelta(event: Extract<AhpEvent, { type: 'item/delta' }>): void {
    const { itemId, kind, value, text } = event.payload;
    const entry = this.items.get(itemId);
    const item = entry?.snapshot;
    if (kind === 'patch' && value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) {
      // The event/privacy boundary validates shape; this layer enforces continuity with the retained item.
      if (!item || value.id !== item.id || value.type !== item.type) throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item snapshot');
      this.put(value as unknown as Item);
      return;
    }
    if (!entry || !item || text === undefined) return;
    if (item.type === 'agentMessage' && kind === 'text') this.append(entry, 'text', item.text, text);
    else if (item.type === 'reasoning' && kind === 'reasoningSummary') this.append(entry, 'summary', item.summary, text);
    else if (item.type === 'toolCall' && kind === 'output') this.append(entry, 'output', item.output, text);
  }
  /**
   * acceptDelta supplies a matching field and its authoritative value. Reserve the exact byte change
   * before mutating buffers/accounting, throwing RESULT_BUDGET_EXCEEDED without retaining the chunk.
   * Empty chunks still establish absent/non-string fields, but must not erase a buffered surrogate tail.
   */
  private append(entry: RetainedItem, field: TextField, previous: unknown, chunk: string): void {
    const pending = entry.bufferedText;
    if (!chunk.length && (pending || typeof previous === 'string')) return;
    const prefix = typeof previous === 'string' ? previous : '';
    const lastCodeUnit = pending ? pending.lastCodeUnit : prefix.charCodeAt(prefix.length - 1);
    const serializedByteDelta = serializedTextAppendByteDelta({ field, previous, chunk, lastCodeUnit, bufferedText: pending });
    if (this.bytes + serializedByteDelta > this.maxBytes) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    const bufferedText = pending ?? { field, chunks: [prefix], lastCodeUnit };
    bufferedText.chunks.push(chunk);
    if (chunk.length) bufferedText.lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    entry.bufferedText = bufferedText;
    entry.serializedBytes += serializedByteDelta;
    this.bytes += serializedByteDelta;
  }
  /**
   * acceptItemEvent and acceptDelta's patch path replace authoritative content here. Check capacity and
   * clone before mutation; budget failure throws RESULT_BUDGET_EXCEEDED and serialization/clone
   * failures propagate. Replacing an existing Map entry preserves first-seen order and discards its
   * provisional buffer, so finish uses the authoritative snapshot at the original position.
   */
  private put(item: Item): void {
    const size = Buffer.byteLength(JSON.stringify(item));
    const previous = this.items.get(item.id);
    const bytes = this.bytes - (previous?.serializedBytes ?? 0) + size;
    if (bytes > this.maxBytes || (!previous && this.items.size >= this.maxItems)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    this.items.set(item.id, { snapshot: structuredClone(item), serializedBytes: size });
    this.bytes = bytes;
  }
  /**
   * Session.retainEvent resolves the shared completion promise with this value before publishing the
   * terminal execution event and ending its hub. Return a detached frozen snapshot without consuming
   * retention: terminal turn usage takes precedence, final text follows first-seen item order, and
   * native failed/interrupted statuses resolve values rather than reject Turn.result. Missing failure
   * details get TURN_FAILED; cloning/freezing failures instead throw into Session.emit's failure chain.
   */
  finish(payload: Extract<AhpEvent, { type: 'turn/completed' }>['payload']): TurnResult {
    const items = [...this.items.values()].map(materializeItem);
    const usage = payload.usage?.scope === 'turn' ? payload.usage : this.usage;
    const common = { text: finalMessageText(items), items, ...(usage ? { usage } : {}) };
    if (payload.status === 'failed') {
      return immutable({ ...common, status: 'failed', error: payload.error ?? { code: 'TURN_FAILED', message: 'Turn failed', retryable: false, outcomeUnknown: false } });
    }
    if (payload.status === 'interrupted') {
      return immutable({ ...common, status: 'interrupted', ...(payload.error ? { error: payload.error } : {}) });
    }
    return immutable({ ...common, status: payload.status });
  }
  /**
   * Direct tests call this reset; no production caller currently reuses accumulators. Clear retained
   * items, completion markers, usage and byte accounting synchronously. Previously returned snapshots
   * stay independent; Session.reclaimExecution instead releases its whole execution registry entry.
   */
  clear(): void {
    this.items.clear();
    this.completed.clear();
    this.usage = undefined;
    this.bytes = 0;
  }
}
