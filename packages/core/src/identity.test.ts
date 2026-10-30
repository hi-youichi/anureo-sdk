import { expect, test } from "bun:test";
import { NativeIdentityMap } from "./identity";
test("native IDs are opaque and item identity is scoped to its turn", () => {
  let seq = 0; const map = new NativeIdentityMap(() => `item_${++seq}`);
  map.bindTurn("turn-a", "native-a");
  expect(map.turn("native-a")).toBe("turn-a"); expect(map.nativeTurn("turn-a")).toBe("native-a");
  expect(map.item("turn-a", "same")).toBe(map.item("turn-a", "same"));
  expect(map.item("turn-b", "same")).not.toBe(map.item("turn-a", "same"));
  expect(() => map.bindTurn("turn-b", "native-a")).toThrow("Conflicting native turn identity");
});

test("clearing the map forgets turns, reverse turns and items at once", () => {
  let seq = 0; const map = new NativeIdentityMap(() => `item_${++seq}`);
  map.bindTurn("turn-a", "native-a"); map.item("turn-a", "native-a");
  map.clear();
  expect(map.turn("native-a")).toBeUndefined(); expect(map.nativeTurn("turn-a")).toBeUndefined();
  expect(map.item("turn-a", "native-native-a")).toBeDefined();
});
