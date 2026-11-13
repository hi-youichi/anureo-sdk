// Maps session-local native identities to SDK identities; must not own sessions, events, or execution lifetimes.
import { HarnessSdkError } from "./sdk-error";

/**
 * Maintains bidirectional turn bindings and turn-scoped item IDs for adapter callers.
 * All state is in memory and scoped to this instance; clear it only after no later
 * event needs the old identities. This class does not own provider or session work.
 */
export class NativeIdentityMap {
  private readonly turns = new Map<string, string>();
  private readonly reverseTurns = new Map<string, string>();
  private readonly items = new Map<string, string>();

  /**
   * Create an empty session-local map using the adapter's SDK ID allocator.
   * No IDs are allocated until an item lookup misses; allocator failures propagate.
   */
  constructor(private readonly createId: () => string) {}

  /**
   * Bind a native/SDK turn pair, checking existing nonempty bindings before
   * changing either direction. Adapter callers bind protocol-valid IDs before
   * publishing events that rely on this pair; conflicts throw PROTOCOL_ERROR.
   */
  bindTurn(turnId: string, nativeTurnId: string): void {
    const existingTurnId = this.turns.get(nativeTurnId);
    const existingNativeTurnId = this.reverseTurns.get(turnId);
    if (
      (existingTurnId && existingTurnId !== turnId) ||
      (existingNativeTurnId && existingNativeTurnId !== nativeTurnId)
    ) {
      throw new HarnessSdkError("PROTOCOL_ERROR", "Conflicting native turn identity");
    }
    this.turns.set(nativeTurnId, turnId);
    this.reverseTurns.set(turnId, nativeTurnId);
  }

  /** Look up an SDK turn ID without allocation or mutation; return undefined when unbound. */
  turn(nativeTurnId: string): string | undefined {
    return this.turns.get(nativeTurnId);
  }

  /** Look up the native peer ID without allocation or mutation; return undefined when unbound. */
  nativeTurn(turnId: string): string | undefined {
    return this.reverseTurns.get(turnId);
  }

  /**
   * Resolve the SDK item ID for this turn/item pair, using the adapter allocator
   * when the cache has no nonempty ID. Allocator failures propagate.
   */
  item(turnId: string, nativeItemId: string): string {
    const key = JSON.stringify([turnId, nativeItemId]);
    let value = this.items.get(key);
    if (!value) {
      value = this.createId();
      this.items.set(key, value);
    }
    return value;
  }

  /**
   * Drop all session-local mappings. Adapter callers must ensure no remaining
   * events need these identities; this does not cancel or clean up provider work.
   */
  clear(): void {
    this.turns.clear();
    this.reverseTurns.clear();
    this.items.clear();
  }
}
