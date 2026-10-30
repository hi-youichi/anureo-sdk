import { HarnessSdkError } from "./errors";

/** Native identifiers are opaque and only unique inside their provider session/turn. */
export class NativeIdentityMap {
  private readonly turns = new Map<string, string>();
  private readonly reverseTurns = new Map<string, string>();
  private readonly items = new Map<string, string>();
  constructor(private readonly createId: () => string) {}
  bindTurn(turnId: string, nativeTurnId: string): void {
    const previous = this.turns.get(nativeTurnId);
    const reverse = this.reverseTurns.get(turnId);
    if ((previous && previous !== turnId) || (reverse && reverse !== nativeTurnId)) throw new HarnessSdkError("PROTOCOL_ERROR", "Conflicting native turn identity");
    this.turns.set(nativeTurnId, turnId); this.reverseTurns.set(turnId, nativeTurnId);
  }
  turn(nativeTurnId: string): string | undefined { return this.turns.get(nativeTurnId); }
  nativeTurn(turnId: string): string | undefined { return this.reverseTurns.get(turnId); }
  item(turnId: string, nativeItemId: string): string {
    const key = JSON.stringify([turnId, nativeItemId]); let value = this.items.get(key);
    if (!value) { value = this.createId(); this.items.set(key, value); }
    return value;
  }
  clear(): void { this.turns.clear(); this.reverseTurns.clear(); this.items.clear(); }
}
