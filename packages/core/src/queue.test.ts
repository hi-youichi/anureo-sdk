import { expect, test } from "bun:test";
import { BoundedEventQueue } from "./queue";
import { waitForRequest } from "./errors";

test("a full queue pauses an awaited writer without dropping values", async () => {
  const queue = new BoundedEventQueue<number>({ maxEvents: 1 });
  queue.push(1);
  let accepted = false;
  const pending = queue.write(2).then(() => { accepted = true; });
  await Promise.resolve(); expect(accepted).toBe(false);
  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe(1);
  await pending;
  expect((await reader.next()).value).toBe(2);
  queue.end(); expect((await reader.next()).done).toBe(true);
});

test("non-pausable overflow is explicit, with a reserved terminal slot", async () => {
  const queue = new BoundedEventQueue<string>({ maxEvents: 1 });
  queue.push("first"); expect(() => queue.push("lost")).toThrow("BACKPRESSURE_EXCEEDED");
  queue.endWithControl("failed");
  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe("first");
  expect((await reader.next()).value).toBe("failed");
  expect((await reader.next()).done).toBe(true);
});

test("an awaited reader receives the reserved failure before completion", async () => {
  const queue = new BoundedEventQueue<string>(); const reader = queue[Symbol.asyncIterator]();
  const pending = reader.next(); queue.endWithControl("failed");
  expect((await pending).value).toBe("failed"); expect((await reader.next()).done).toBe(true);
});

test("detach releases ownership without closing the producer", async () => {
  const queue = new BoundedEventQueue<number>(); const reader = queue[Symbol.asyncIterator]();
  expect(() => queue[Symbol.asyncIterator]()).toThrow("EVENT_STREAM_ALREADY_OWNED");
  const pending = reader.next(); await reader.return?.(); expect((await pending).done).toBe(true);
  queue.push(3); const next = queue[Symbol.asyncIterator](); expect((await next.next()).value).toBe(3); await next.return?.();
});

test("frame and byte limits reject oversized input; bounded writers end on close", async () => {
  const queue = new BoundedEventQueue<string>({ maxEvents: 1, maxBytes: 20, maxFrameBytes: 10, maxWaitingWriters: 1 });
  expect(() => queue.push("x".repeat(30))).toThrow("FRAME_TOO_LARGE");
  queue.push("first"); const pending = queue.write("second");
  await expect(queue.write("third")).rejects.toMatchObject({ code: "BACKPRESSURE_EXCEEDED" });
  queue.end(); await expect(pending).rejects.toMatchObject({ code: "STREAM_CLOSED" });
});

test("queue limits must be positive integers; buffered metrics observe occupancy", async () => {
  expect(() => new BoundedEventQueue<number>({ maxEvents: 0 })).toThrow("Queue limits must be positive integers");
  expect(() => new BoundedEventQueue<number>({ maxBytes: 1.5 })).toThrow("Queue limits must be positive integers");
  expect(() => new BoundedEventQueue<number>({ maxControlEvents: -1 })).toThrow("Queue limits must be positive integers");
  const queue = new BoundedEventQueue<string>({ maxEvents: 4, maxBytes: 100 });
  queue.push("first"); queue.pushControl("control");
  expect(queue.bufferedEvents).toBe(2);
  expect(queue.bufferedBytes).toBeGreaterThan(0);
});

test("throwing into a reader detaches it and ends the stream", async () => {
  const queue = new BoundedEventQueue<number>(); const reader = queue[Symbol.asyncIterator]();
  queue.push(1);
  await expect(reader.throw?.(new Error("stream aborted"))).rejects.toThrow("stream aborted");
  expect((await reader.next()).done).toBe(true);
});

test("request abort before dispatch has no side effect; abort after dispatch is unknown", async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await expect(waitForRequest(async () => ++calls, { signal: before.signal })).rejects.toMatchObject({ code: "REQUEST_ABORTED", outcomeUnknown: false });
  expect(calls).toBe(0);
  const after = new AbortController(); const pending = waitForRequest(() => { calls++; return new Promise<number>(() => {}); }, { signal: after.signal });
  after.abort(); await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED", outcomeUnknown: true }); expect(calls).toBe(1);
});

test("timeout observes a late backend rejection without resubmitting", async () => {
  let calls = 0;
  await expect(waitForRequest(() => { calls++; return new Promise((_, reject) => setTimeout(() => reject(new Error("private payload")), 15)); }, { timeoutMs: 2 })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcomeUnknown: true });
  await new Promise((resolve) => setTimeout(resolve, 25)); expect(calls).toBe(1);
});

test("a synchronous operation throw is captured like any other failure", async () => {
  await expect(waitForRequest(() => { throw new Error("sync failure") })).rejects.toThrow("sync failure");
  await expect(waitForRequest(async () => "value", { timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
});
