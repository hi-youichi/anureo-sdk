// Verifies session-local identity contracts; must not implement production policy or manage adapter lifetimes.
import { expect, test } from "bun:test";
import { NativeIdentityMap } from "./identity";

/** Verify opaque native IDs, bidirectional turn lookup, turn-scoped allocation, and conflict rejection. */
test("native IDs are opaque and item identity is scoped to its turn", () => {
  let seq = 0;
  const map = new NativeIdentityMap(() => `item_${++seq}`);
  map.bindTurn("turn-a", "native-a");
  expect(map.turn("native-a")).toBe("turn-a");
  expect(map.nativeTurn("turn-a")).toBe("native-a");
  expect(map.item("turn-a", "same")).toBe(map.item("turn-a", "same"));
  expect(map.item("turn-b", "same")).not.toBe(map.item("turn-a", "same"));
  expect(() => map.bindTurn("turn-b", "native-a")).toThrow("Conflicting native turn identity");
  expect(() => map.bindTurn("turn-a", "native-b")).toThrow("Conflicting native turn identity");
});

/** Verify clear removes both binding directions and cached item IDs before later allocation. */
test("clearing the map forgets turn mappings and allows subsequent item creation", () => {
  let seq = 0;
  const map = new NativeIdentityMap(() => `item_${++seq}`);
  map.bindTurn("turn-a", "native-a");
  const priorItem = map.item("turn-a", "native-a");
  map.clear();
  expect(map.turn("native-a")).toBeUndefined();
  expect(map.nativeTurn("turn-a")).toBeUndefined();
  expect(map.item("turn-a", "native-a")).not.toBe(priorItem);
});
