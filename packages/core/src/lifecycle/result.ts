// Retains ordered item content and usage for one execution's terminal result.
import type { AhpEvent, Item, Usage } from '@anureo/protocol';
import { HarnessSdkError } from '../errors';
import type { TurnResult } from '../types';
import { immutable } from './immutable';

/**
 * Session.context creates one accumulator per execution. Session.retainEvent supplies privacy-projected
 * events in publication order and uses the terminal snapshot to resolve the promise read by Turn.result.
 * Session owns event validation, publication, shared budgets and reclamation.
 */
export class ResultAccumulator {
  /**
   * Session.context supplies positive safe integers for serialized bytes and distinct items.
   * Omitted session limits default to 16 MiB and 2,048 items before construction.
   */
  constructor(private readonly maxBytes: number, private readonly maxItems: number) {}
  /**
   * Return the UTF-8 JSON byte total of the individual items as if buffered text were materialized.
   * Session.retainEvent uses the difference across an update for its shared budget, and
   * Session.reclaimExecution subtracts the total on eviction. Usage and envelope bytes are excluded.
   */
  get size(): number { return this.bytes; }
  /**
   * Retain detached turn usage and item content before Session.retainEvent publishes the event.
   * Snapshots replace buffered content and completed items ignore subsequent deltas. A conflicting
   * patch throws PROTOCOL_ERROR. Exceeding either limit throws RESULT_BUDGET_EXCEEDED. These throws
   * reject Session.emit and reach Session.fail, which rejects unfinished Turn.result waits.
   * Serialization and clone failures also propagate to Session.emit.
   */
  accept(event: AhpEvent): void {
    switch (event.type) {
      case 'usage/updated':
        if (event.payload.scope === 'turn') this.usage = structuredClone(event.payload);
        break;
      case 'item/started':
      case 'item/completed':
        this.retainSnapshot(event.payload.item);
        // Mark completion only after retention succeeds, so a rejected snapshot cannot suppress deltas.
        if (event.type === 'item/completed') this.completed.add(event.payload.item.id);
        break;
      case 'item/delta':
        if (!this.completed.has(event.payload.itemId)) this.acceptDelta(event.payload);
        break;
    }
  }
  /**
   * Build a detached, frozen snapshot from the current retention. Turn-scoped usage in the terminal
   * event takes precedence over the latest retained turn usage. Final messages are joined with
   * newlines in first-seen order. Failed results without native error details get TURN_FAILED.
   * Session.retainEvent resolves the promise read by Turn.result with this snapshot for every native
   * terminal status, then publishes the terminal event and ends the execution stream. If cloning or
   * freezing throws, Session.emit rejects before the snapshot or event is delivered.
   */
  finish(payload: Extract<AhpEvent, { type: 'turn/completed' }>['payload']): TurnResult {
    const items = [...this.items.values()].map(materializeItem);
    const usage = payload.usage?.scope === 'turn' ? payload.usage : this.usage;
    const common = { text: finalMessageText(items), items, ...(usage ? { usage } : {}) };
    if (payload.status === 'failed') {
      const error = payload.error ?? {
        code: 'TURN_FAILED',
        message: 'Turn failed',
        retryable: false,
        outcomeUnknown: false,
      };
      return immutable({ ...common, status: 'failed', error });
    }
    if (payload.status === 'interrupted') {
      return immutable({ ...common, status: 'interrupted', ...(payload.error ? { error: payload.error } : {}) });
    }
    return immutable({ ...common, status: payload.status });
  }
  /**
   * Reset retained items, completion markers, usage and bytes for reuse. Previously returned snapshots
   * stay independent.
   */
  clear(): void {
    this.items.clear();
    this.completed.clear();
    this.usage = undefined;
    this.bytes = 0;
  }

  private readonly items = new Map<string, RetainedItem>();
  private readonly completed = new Set<string>();
  private bytes = 0;
  private usage?: Usage;
  /**
   * Apply a delta for an item without a completion marker. Snapshot patches take the replacement
   * path. Text deltas buffer only their matching field on a retained item. Retention failures
   * propagate to accept.
   */
  private acceptDelta({ itemId, kind, value, text }: ItemDelta): void {
    const entry = this.items.get(itemId);
    if (kind === 'patch') {
      this.applySnapshotPatch(entry?.snapshot, value);
      return;
    }
    if (!entry || text === undefined) return;
    const item = entry.snapshot;
    if (item.type === 'agentMessage' && kind === 'text') this.append(entry, 'text', item.text, text);
    else if (item.type === 'reasoning' && kind === 'reasoningSummary') this.append(entry, 'summary', item.summary, text);
    else if (item.type === 'toolCall' && kind === 'output') this.append(entry, 'output', item.output, text);
  }
  /**
   * acceptDelta passes patch values here after Session.publish has projected them.
   * Only a patch object with a type discriminator can replace a snapshot. SecretRedactor.deltaValue
   * validates its shape upstream. Throw PROTOCOL_ERROR on a missing base item or a mismatch in ID
   * or family. A valid patch replaces the snapshot and discards its text buffer.
   */
  private applySnapshotPatch(current: Item | undefined, value: ItemDelta['value']): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value)) return;
    if (!current || value.id !== current.id || value.type !== current.type) {
      throw new HarnessSdkError('PROTOCOL_ERROR', 'Conflicting item snapshot');
    }
    this.retainSnapshot(value as unknown as Item);
  }
  /**
   * acceptDelta supplies a matching field and its snapshot value. Check the exact JSON byte change
   * before updating the buffer or accounting. Throw RESULT_BUDGET_EXCEEDED without retaining the
   * chunk on overflow. An empty chunk can establish an absent or non-string field. Preserve a
   * buffered surrogate tail across empty chunks so a later chunk can complete the pair.
   */
  private append(entry: RetainedItem, field: TextField, previous: unknown, chunk: string): void {
    const pending = entry.bufferedText;
    if (!chunk.length && (pending || typeof previous === 'string')) return;
    const serializedByteDelta = serializedTextAppendByteDelta({ field, previous, chunk, bufferedText: pending });
    if (this.bytes + serializedByteDelta > this.maxBytes) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    const bufferedText: NonNullable<RetainedItem['bufferedText']> = pending ?? {
      field,
      chunks: [typeof previous === 'string' ? previous : ''],
    };
    bufferedText.chunks.push(chunk);
    if (chunk.length) bufferedText.lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    entry.bufferedText = bufferedText;
    entry.serializedBytes += serializedByteDelta;
    this.bytes += serializedByteDelta;
  }
  /**
   * accept and applySnapshotPatch store detached snapshots here. Check capacity and clone before
   * mutation. Budget failure throws RESULT_BUDGET_EXCEEDED and serialization or clone failures
   * propagate. Replacing an existing entry discards its provisional buffer while preserving its
   * first-seen position for finish.
   */
  private retainSnapshot(item: Item): void {
    const size = Buffer.byteLength(JSON.stringify(item));
    const previous = this.items.get(item.id);
    const bytes = this.bytes - (previous?.serializedBytes ?? 0) + size;
    if (bytes > this.maxBytes || (!previous && this.items.size >= this.maxItems)) throw new HarnessSdkError('RESULT_BUDGET_EXCEEDED');
    this.items.set(item.id, { snapshot: structuredClone(item), serializedBytes: size });
    this.bytes = bytes;
  }
}

type ItemDelta = Extract<AhpEvent, { type: 'item/delta' }>['payload'];

/** Fields acceptDelta can reconstruct provisionally. */
type TextField = 'text' | 'summary' | 'output';
/** Mutable retention owned by ResultAccumulator; finish materializes buffers without changing this state. */
interface RetainedItem {
  /** Detached authoritative value, kept separate from provisional text. */
  snapshot: Item;
  /** JSON bytes of the item after applying buffered text, excluding any surrounding array. */
  serializedBytes: number;
  /** One supported text field per item family; chunks avoid rebuilding the full string on every delta. */
  bufferedText?: {
    field: TextField;
    chunks: string[];
    /** Tail used to account for surrogate pairs spanning deltas; empty chunks must preserve it. */
    lastCodeUnit?: number;
  };
}

/**
 * Return the JSON byte change that append uses to check capacity, including the structural cost of
 * establishing a text field and any surrogate pair formed with the end of the existing text.
 */
function serializedTextAppendByteDelta({ field, previous, chunk, bufferedText }: {
  field: TextField;
  previous: unknown;
  chunk: string;
  bufferedText: RetainedItem['bufferedText'];
}): number {
  const prefix = typeof previous === 'string' ? previous : '';
  const lastCodeUnit = bufferedText ? bufferedText.lastCodeUnit : prefix.charCodeAt(prefix.length - 1);
  const chunkContentBytes = Buffer.byteLength(JSON.stringify(chunk)) - 2; // Exclude string quotes.
  const surrogatePairByteDelta = splitSurrogateByteAdjustment(lastCodeUnit, chunk);
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
 * Correct append accounting when a chunk joins a trailing high surrogate to a leading low surrogate.
 * JSON replaces two isolated escapes (6 bytes each) with one UTF-8 pair (4 bytes); empty chunks and
 * non-pair boundaries need no adjustment.
 */
function splitSurrogateByteAdjustment(previousCodeUnit: number | undefined, chunk: string): number {
  const endsWithHighSurrogate = previousCodeUnit !== undefined && previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff;
  const firstCodeUnit = chunk.charCodeAt(0);
  const startsWithLowSurrogate = firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff;
  return endsWithHighSurrogate && startsWithLowSurrogate ? 4 - 2 * 6 : 0;
}
