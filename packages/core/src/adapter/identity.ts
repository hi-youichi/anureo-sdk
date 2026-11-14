// Maps opaque native identities to SDK identities within an adapter-owned session.
import { HarnessSdkError } from "../errors";

/**
 * Translate opaque native turn and item IDs when implementing an adapter. Keep one
 * map per native session and use it for events that share those identities. The
 * adapter owns event ordering, failure handling and clearing the map once its
 * identities are no longer needed.
 */
export class NativeIdentityMap {
  /**
   * Supply an allocator that returns unique, nonempty SDK item IDs. item() invokes it
   * synchronously on a cache miss and propagates failures. The allocator owns uniqueness.
   */
  constructor(private readonly createId: () => string) {}

  /**
   * Record a turn pair before translating it through turn() or nativeTurn(). Rebinding
   * the same pair is harmless. A conflicting nonempty stored ID throws HarnessSdkError
   * with code PROTOCOL_ERROR before either lookup changes. Empty stored values permit
   * rebinding, which writes only the supplied pair. The adapter handles conflicts.
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
   * Reuse the SDK item ID for a native item within an SDK turn. The turn can be unbound.
   * The allocator runs synchronously when the pair has no nonempty cached ID. An empty
   * result is returned and triggers another allocation on the next lookup. Allocator
   * failures propagate unchanged and leave the adapter free to retry.
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
   * Forget both turn directions and all cached item IDs once pending events no longer
   * need them. Later calls can bind and allocate again with the same allocator.
   * Repeated clears are harmless. The adapter remains responsible for native cleanup.
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
