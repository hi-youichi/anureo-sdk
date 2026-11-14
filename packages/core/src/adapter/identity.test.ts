// Verifies opaque identity scoping, reset behavior and allocator failures.
import { expect, test } from "bun:test";
import { NativeIdentityMap } from "./identity";

/** Exercise adapter lookups and ensure repeated binding/allocation preserves IDs without consuming extra IDs. */
test("native IDs are opaque and item identity is scoped to its turn", () => {
  let seq = 0;
  const map = new NativeIdentityMap(() => `item_${++seq}`);
  map.bindTurn("turn-a", "native-a");
  map.bindTurn("turn-a", "native-a");
  expect(map.turn("native-a")).toBe("turn-a");
  expect(map.nativeTurn("turn-a")).toBe("native-a");
  expect(map.item("turn-a", "same")).toBe(map.item("turn-a", "same"));
  expect(map.item("turn-b", "same")).not.toBe(map.item("turn-a", "same"));
  expect(seq).toBe(2);
  expect(() => map.bindTurn("turn-b", "native-a")).toThrow("Conflicting native turn identity");
  expect(map.nativeTurn("turn-b")).toBeUndefined();
  expect(() => map.bindTurn("turn-a", "native-b")).toThrow("Conflicting native turn identity");
  expect(map.turn("native-b")).toBeUndefined();
  expect(map.turn("native-a")).toBe("turn-a");
  expect(map.nativeTurn("turn-a")).toBe("native-a");
});

/** Verify adapter-owned clear forgets both directions and item IDs while leaving the allocator usable. */
test("clearing the map forgets turn mappings and allows subsequent item creation", () => {
  let seq = 0;
  const map = new NativeIdentityMap(() => `item_${++seq}`);
  map.bindTurn("turn-a", "native-a");
  const priorItem = map.item("turn-a", "native-a");
  map.clear();
  map.clear();
  expect(map.turn("native-a")).toBeUndefined();
  expect(map.nativeTurn("turn-a")).toBeUndefined();
  expect(map.item("turn-a", "native-a")).not.toBe(priorItem);
  map.bindTurn("turn-b", "native-a");
  map.bindTurn("turn-a", "native-b");
  expect(map.turn("native-a")).toBe("turn-b");
  expect(map.nativeTurn("turn-a")).toBe("native-b");
});

/** Protect opaque tuple keys from delimiter collisions and preserve unusual native turn strings verbatim. */
test("opaque identity pairs do not collide", () => {
  let seq = 0;
  const map = new NativeIdentityMap(() => `item_${++seq}`);
  const nativeTurnId = 'native:\u0000["雪"]';
  map.bindTurn("turn-a", nativeTurnId);
  expect(map.turn(nativeTurnId)).toBe("turn-a");
  expect(map.nativeTurn("turn-a")).toBe(nativeTurnId);
  expect(map.item("a:b", "c")).not.toBe(map.item("a", "b:c"));
  expect(map.item("a\u0000b", "c")).not.toBe(map.item("a", "b\u0000c"));
  expect(map.item('a","b', "c")).not.toBe(map.item("a", 'b","c'));
  expect(seq).toBe(6);
});

/** Verify item() invokes the adapter allocator lazily, propagates its exact failure, and permits a later retry. */
test("allocator failure leaves the item available for retry", () => {
  const failure = new Error("allocation failed");
  let attempts = 0;
  const map = new NativeIdentityMap(() => {
    attempts++;
    if (attempts === 1) throw failure;
    return "item-a";
  });
  map.bindTurn("turn-a", "native-a");
  expect(map.turn("native-a")).toBe("turn-a");
  expect(map.nativeTurn("turn-a")).toBe("native-a");
  expect(attempts).toBe(0);
  let caught: unknown;
  try {
    map.item("turn-a", "native-item");
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBe(failure);
  expect(map.item("turn-a", "native-item")).toBe("item-a");
  expect(map.item("turn-a", "native-item")).toBe("item-a");
  expect(attempts).toBe(2);
});

/** Preserve the existing truthiness rules; the map does not enforce nonempty IDs on adapter inputs or results. */
test("empty stored IDs retain their rebinding and reallocation behavior", () => {
  let allocations = 0;
  const map = new NativeIdentityMap(() => {
    allocations++;
    return "";
  });
  map.bindTurn("", "native-a");
  expect(map.turn("native-a")).toBe("");
  map.bindTurn("turn-a", "native-a");
  expect(map.turn("native-a")).toBe("turn-a");
  map.bindTurn("turn-b", "");
  expect(map.nativeTurn("turn-b")).toBe("");
  map.bindTurn("turn-b", "native-b");
  expect(map.nativeTurn("turn-b")).toBe("native-b");
  expect(map.item("", "")).toBe("");
  expect(map.item("", "")).toBe("");
  expect(allocations).toBe(2);
});
