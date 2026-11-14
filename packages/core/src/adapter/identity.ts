// Maps opaque native identities to SDK identities within an adapter-owned session.
import { HarnessSdkError } from "../errors";

/**
 * Translate native turn/item IDs to SDK IDs when implementing an adapter.
 * Identifiers are opaque strings; this map does not validate or normalize them.
 * All state is in memory and scoped to this instance. Adapters own event ordering,
 * failure handling and clearing the map after no later event needs its identities.
 */
export class NativeIdentityMap {
  /**
   * Adapters supply a synchronous SDK item ID allocator when creating a session-local
   * map. Construction does not invoke it; item() invokes it on a cache miss and
   * propagates its failures. Supply nonempty IDs to make subsequent lookups reuse them.
   * The allocator owns ID uniqueness; its results are not checked for collisions.
   */
  constructor(private readonly createId: () => string) {}

  /**
   * Adapters record an SDK/native turn pair before translating it through turn()
   * or nativeTurn(). Rebinding the same pair is harmless. A conflicting nonempty
   * stored ID throws HarnessSdkError with code PROTOCOL_ERROR before either map
   * changes; existing empty values do not reject rebinding. Rebinding writes only
   * the supplied pair and does not remove older entries involving empty IDs.
   * The adapter decides how to handle a conflict.
   */
  bindTurn(turnId: string, nativeTurnId: string): void {
    const existingTurnId = this.turnIdsByNativeTurnId.get(nativeTurnId);
    const existingNativeTurnId = this.nativeTurnIdsByTurnId.get(turnId);
    if (
      (existingTurnId && existingTurnId !== turnId) ||
      (existingNativeTurnId && existingNativeTurnId !== nativeTurnId)
    ) {
      throw new HarnessSdkError("PROTOCOL_ERROR", "Conflicting native turn identity");
    }
    this.turnIdsByNativeTurnId.set(nativeTurnId, turnId);
    this.nativeTurnIdsByTurnId.set(turnId, nativeTurnId);
  }

  /** Adapters translate a native turn ID to its stored SDK ID, or undefined, without mutation or allocation. */
  turn(nativeTurnId: string): string | undefined {
    return this.turnIdsByNativeTurnId.get(nativeTurnId);
  }

  /** Adapters translate an SDK turn ID to its stored native ID, or undefined, without mutation or allocation. */
  nativeTurn(turnId: string): string | undefined {
    return this.nativeTurnIdsByTurnId.get(turnId);
  }

  /**
   * Adapters obtain a stable SDK item ID for repeated native item events within an
   * SDK turn. No turn binding is required. Return the cached nonempty ID, or invoke
   * the supplied allocator synchronously and cache its result for this pair.
   * Allocator failures propagate unchanged without caching a result, so a later
   * call tries again; the adapter owns retry policy. Empty results are returned
   * but cause another allocation on the next lookup. clear() forgets these IDs.
   */
  item(turnId: string, nativeItemId: string): string {
    // Encode the pair so delimiter characters inside opaque IDs cannot alias another pair.
    const key = JSON.stringify([turnId, nativeItemId]);
    let itemId = this.items.get(key);
    if (!itemId) {
      itemId = this.createId();
      this.items.set(key, itemId);
    }
    return itemId;
  }

  /**
   * Adapters call this after no remaining events need the old identities. Forget
   * both turn directions and all cached item IDs; later calls can bind and allocate
   * again using the same allocator. Repeated clears are harmless and return no value.
   * Native work is not cancelled or released: the adapter retains cleanup ownership.
   */
  clear(): void {
    this.turnIdsByNativeTurnId.clear();
    this.nativeTurnIdsByTurnId.clear();
    this.items.clear();
  }

  private readonly turnIdsByNativeTurnId = new Map<string, string>();
  private readonly nativeTurnIdsByTurnId = new Map<string, string>();
  private readonly items = new Map<string, string>();
}
