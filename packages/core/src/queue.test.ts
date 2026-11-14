import { expect, test } from "bun:test";
import { BoundedEventQueue } from "./queue";
import { waitForRequest } from "./request";
import { EventHub } from "./lifecycle/events";

/** Fill one slot, then await write and drain it; admission must resume after consumption without dropping or reordering either value. End and exhaust the reader. */
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

/** A full regular buffer leaves room for a terminal control, which drains after the original value. */
test("regular overflow still allows a terminal control", async () => {
  const queue = new BoundedEventQueue<string>({ maxEvents: 1 });
  queue.push("first"); expect(() => queue.push("lost")).toThrow("BACKPRESSURE_EXCEEDED");
  queue.endWithControl("failed");
  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe("first");
  expect((await reader.next()).value).toBe("failed");
  expect((await reader.next()).done).toBe(true);
});

/** endWithControl delivers to a pending read before a subsequent read observes completion. */
test("a pending reader receives the terminal control before completion", async () => {
  const queue = new BoundedEventQueue<string>(); const reader = queue[Symbol.asyncIterator]();
  const pending = reader.next(); queue.endWithControl("failed");
  expect((await pending).value).toBe("failed"); expect((await reader.next()).done).toBe(true);
});

/** Returning a blocked reader releases ownership. Later calls on it cannot consume the replacement's data or complete its pending read. */
test("detach releases ownership without closing the producer", async () => {
  const queue = new BoundedEventQueue<number>();
  const reader = queue[Symbol.asyncIterator]();
  expect(() => queue[Symbol.asyncIterator]()).toThrow("EVENT_STREAM_ALREADY_OWNED");

  const pendingRead = reader.next();
  await reader.return?.();
  expect((await pendingRead).done).toBe(true);

  queue.push(3);

  const replacementReader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).done).toBe(true);
  expect((await replacementReader.next()).value).toBe(3);

  const replacementRead = replacementReader.next();
  await reader.return?.();
  queue.push(4);
  expect(await replacementRead).toEqual({ done: false, value: 4 });
  await replacementReader.return?.();
});

/** Exceed frame and suspended-writer budgets, then end a full queue; each admission must reject with its own error and the blocked writer must settle. */
test("oversized frames and excess waiting writers are rejected; closing rejects pending writers", async () => {
  const queue = new BoundedEventQueue<string>({ maxEvents: 1, maxBytes: 20, maxFrameBytes: 10, maxWaitingWriters: 1 });
  expect(() => queue.push("x".repeat(30))).toThrow("FRAME_TOO_LARGE");
  queue.push("first"); const pending = queue.write("second");
  await expect(queue.write("third")).rejects.toMatchObject({ code: "BACKPRESSURE_EXCEEDED" });
  queue.end(); await expect(pending).rejects.toMatchObject({ code: "STREAM_CLOSED" });
});

/** Reject invalid constructor budgets and inspect separate event/byte occupancy after regular and control admission; no reader or pending write is allocated. */
test("queue limits must be positive integers; buffered metrics observe occupancy", async () => {
  expect(() => new BoundedEventQueue<number>({ maxEvents: 0 })).toThrow("Queue limits must be positive integers");
  expect(() => new BoundedEventQueue<number>({ maxBytes: 1.5 })).toThrow("Queue limits must be positive integers");
  expect(() => new BoundedEventQueue<number>({ maxControlEvents: -1 })).toThrow("Queue limits must be positive integers");
  const queue = new BoundedEventQueue<string>({ maxEvents: 4, maxBytes: 100 });
  queue.push("first"); queue.pushControl("control");
  expect(queue.bufferedEvents).toBe(2);
  expect(queue.bufferedBytes).toBeGreaterThan(0);
});

/** Throw into a claimed reader; its promise must reject with the supplied cause and its next must complete after detachment. */
test("throwing into a reader detaches it without ending the producer", async () => {
  const queue = new BoundedEventQueue<number>(); const reader = queue[Symbol.asyncIterator]();
  queue.push(1);
  await expect(reader.throw?.(new Error("stream aborted"))).rejects.toThrow("stream aborted");
  expect((await reader.next()).done).toBe(true);
});

/** Abort before and after waitForRequest invokes its operation; only admitted work has an unknown outcome, and neither path may dispatch twice. */
test("request abort before dispatch has no side effect; abort after dispatch is unknown", async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await expect(waitForRequest(async () => ++calls, { signal: before.signal })).rejects.toMatchObject({ code: "REQUEST_ABORTED", outcomeUnknown: false });
  expect(calls).toBe(0);
  const after = new AbortController(); const pending = waitForRequest(() => { calls++; return new Promise<number>(() => {}); }, { signal: after.signal });
  after.abort(); await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED", outcomeUnknown: true }); expect(calls).toBe(1);
});

/** Register the abort listener before calling the operation and observe its rejection even when abort settles the wait first. */
test("synchronous abort during dispatch wins over the operation's rejection", async () => {
  const controller = new AbortController();
  const pending = waitForRequest(() => {
    controller.abort();
    return Promise.reject(new Error("operation failed"));
  }, { signal: controller.signal });
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED", outcomeUnknown: true });
});

/** Let the request deadline precede backend rejection; await both intervals to detect unobserved rejection and prove the operation is never resubmitted. */
test("timeout observes a late backend rejection without resubmitting", async () => {
  let calls = 0;
  await expect(waitForRequest(() => { calls++; return new Promise((_, reject) => setTimeout(() => reject(new Error("private payload")), 15)); }, { timeoutMs: 2 })).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", outcomeUnknown: true });
  await new Promise((resolve) => setTimeout(resolve, 25)); expect(calls).toBe(1);
});

/** Supply a throwing operation and an invalid timeout; waitForRequest must reject with the original failure or INVALID_PARAMS respectively. */
test("a synchronous operation throw is captured like any other failure", async () => {
  await expect(waitForRequest(() => { throw new Error("sync failure") })).rejects.toThrow("sync failure");
  await expect(waitForRequest(async () => "value", { timeoutMs: 0 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
});

/** Admit controls around regular data; only regular consumption releases bytes, and all regular data must drain before the separately bounded controls. */
test("regular data drains before controls regardless of admission order", async () => {
  const queue = new BoundedEventQueue<string>({ maxEvents: 1, maxBytes: 5, maxControlEvents: 2 }, () => 5);
  queue.pushControl("control first");
  queue.push("regular");
  queue.pushControl("control last");
  expect(() => queue.pushControl("excess")).toThrow("Control event limit exceeded");
  expect(queue.bufferedEvents).toBe(3);
  expect(queue.bufferedBytes).toBe(5);
  queue.end();

  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe("regular");
  expect(queue.bufferedBytes).toBe(0);
  expect((await reader.next()).value).toBe("control first");
  expect((await reader.next()).value).toBe("control last");
  expect((await reader.next()).done).toBe(true);
});

/** Closing with a cause wakes blocked writers to reject and preserves buffered delivery before read failure. */
test("failed closure rejects writers and drains admitted values before rejecting reads", async () => {
  const queue = new BoundedEventQueue<number>({ maxEvents: 1 });
  const failure = new Error("producer failed");
  queue.push(1);
  queue.pushControl(2);
  const pendingWrite = queue.write(3);
  queue.end(failure);
  await expect(pendingWrite).rejects.toBe(failure);

  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe(1);
  expect((await reader.next()).value).toBe(2);
  await expect(reader.next()).rejects.toBe(failure);
  const replacement = queue[Symbol.asyncIterator]();
  await expect(replacement.next()).rejects.toBe(failure);
});

/** Reject a second blocked next, then end the first with a failure; explicit return must release ownership and a stale return must not detach a replacement. */
test("pending-read failure retains ownership until the reader is released", async () => {
  const queue = new BoundedEventQueue<number>();
  const reader = queue[Symbol.asyncIterator]();
  const pendingRead = reader.next();
  await expect(reader.next()).rejects.toMatchObject({ code: "CONCURRENT_EVENT_READ" });
  const failure = new Error("read failed");
  queue.end(failure);
  await expect(pendingRead).rejects.toBe(failure);
  expect(() => queue[Symbol.asyncIterator]()).toThrow("EVENT_STREAM_ALREADY_OWNED");
  await reader.return?.();

  const replacement = queue[Symbol.asyncIterator]();
  await reader.return?.();
  expect(() => queue[Symbol.asyncIterator]()).toThrow("EVENT_STREAM_ALREADY_OWNED");
  await expect(replacement.next()).rejects.toBe(failure);
});

/** Admission precedes write's accepted callback; callback failure rejects the write promise without retracting the value already visible to its reader. */
test("an accepted callback failure leaves its value admitted", async () => {
  const queue = new BoundedEventQueue<number>();
  const failure = new Error("acceptance observer failed");
  await expect(queue.write(1, () => { throw failure; })).rejects.toBe(failure);
  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe(1);
  queue.end();
  expect((await reader.next()).done).toBe(true);
});

/** Fill the byte budget with event slots still available, then wake two writers; each must recheck capacity so only one is admitted per consumed value. Drain and await both writes. */
test("awakened writers recheck byte capacity before admission", async () => {
  const queue = new BoundedEventQueue<number>({ maxEvents: 3, maxBytes: 4 }, () => 4);
  const accepted: number[] = [];
  queue.push(1);
  const firstWrite = queue.write(2, () => { accepted.push(2); });
  const secondWrite = queue.write(3, () => { accepted.push(3); });
  expect(accepted).toEqual([]);

  const reader = queue[Symbol.asyncIterator]();
  expect((await reader.next()).value).toBe(1);
  expect(accepted).toHaveLength(1);
  expect(queue.bufferedBytes).toBe(4);
  const first = (await reader.next()).value;
  await Promise.all([firstWrite, secondWrite]);
  const second = (await reader.next()).value;
  expect([first, second].sort()).toEqual([2, 3]);
  expect(accepted.sort()).toEqual([2, 3]);
  queue.end();
  expect((await reader.next()).done).toBe(true);
});

/** Publish to independently bounded readers; overflow must detach the slow observer's abort listener, retain its admitted clone, and allow its sibling to continue. */
test("overflow isolates a subscriber and preserves independent event clones", async () => {
  const hub = new EventHub<{ nested: { value: number } }>();
  const controller = new AbortController();
  const slow = hub.subscribe({ queue: { maxEvents: 1 }, signal: controller.signal });
  const fast = hub.subscribe();
  const original = { nested: { value: 1 } };
  hub.publish(original);
  original.nested.value = 9;
  const slowValue = await slow.next();
  expect(slowValue.value.nested.value).toBe(1);
  slowValue.value.nested.value = 8;
  expect((await fast.next()).value.nested.value).toBe(1);

  hub.publish({ nested: { value: 2 } });
  expect((await fast.next()).value.nested.value).toBe(2);
  hub.publish({ nested: { value: 3 } });
  controller.abort();
  expect((await slow.next()).value.nested.value).toBe(2);
  await expect(slow.next()).rejects.toMatchObject({ code: "BACKPRESSURE_EXCEEDED" });
  expect((await fast.next()).value.nested.value).toBe(3);
  hub.end();
  expect((await fast.next()).done).toBe(true);
});

/** Abort/return subscriptions with blocked reads; both reads and later next calls must complete while a sibling still receives subsequent publications. End and exhaust the sibling. */
test("subscriber abort and return settle blocked reads without stopping siblings", async () => {
  const hub = new EventHub<number>();
  const controller = new AbortController();
  const aborted = hub.subscribe({ signal: controller.signal });
  const returned = hub.subscribe();
  const sibling = hub.subscribe();
  const abortedRead = aborted.next();
  const returnedRead = returned.next();
  controller.abort();
  await returned.return?.();
  expect((await abortedRead).done).toBe(true);
  expect((await returnedRead).done).toBe(true);
  hub.publish(1);
  expect((await aborted.next()).done).toBe(true);
  expect((await returned.next()).done).toBe(true);
  expect((await sibling.next()).value).toBe(1);
  hub.end();
  expect((await sibling.next()).done).toBe(true);
});

/** Terminate a hub before aborting its signal; cleanup must preserve queued drain/failure, and late subscribers must observe stored failure even with an already-aborted signal. */
test("hub termination removes abort listeners and takes precedence for late subscribers", async () => {
  const hub = new EventHub<number>();
  const controller = new AbortController();
  const reader = hub.subscribe({ signal: controller.signal });
  const failure = new Error("hub failed");
  hub.publish(1);
  hub.end(failure);
  controller.abort();
  expect((await reader.next()).value).toBe(1);
  await expect(reader.next()).rejects.toBe(failure);
  await expect(hub.subscribe({ signal: controller.signal }).next()).rejects.toBe(failure);
});

/** Supply a rejecting publication filter; its buffered event must precede its failure while another subscriber continues to receive events. */
test("filter failure ends only its own subscription after buffered values drain", async () => {
  const hub = new EventHub<number>();
  const failure = new Error("filter failed");
  const filtered = hub.subscribe({}, value => {
    if (value === 2) throw failure;
    return true;
  });
  const sibling = hub.subscribe();
  hub.publish(1);
  hub.publish(2);
  expect((await filtered.next()).value).toBe(1);
  await expect(filtered.next()).rejects.toBe(failure);
  expect((await sibling.next()).value).toBe(1);
  expect((await sibling.next()).value).toBe(2);
  hub.end();
  expect((await sibling.next()).done).toBe(true);
});

/** A clone failure must close only the accepting observer, retaining its admitted data and allowing a filtered sibling to receive later events. */
test("clone failure preserves buffered drain and isolates the accepting subscriber", async () => {
  const hub = new EventHub<{ value: number; uncloneable?: () => void }>();
  const failed = hub.subscribe();
  const sibling = hub.subscribe({}, value => !value.uncloneable);
  hub.publish({ value: 1 });
  hub.publish({ value: 2, uncloneable: () => {} });
  expect((await failed.next()).value).toEqual({ value: 1 });
  await expect(failed.next()).rejects.toMatchObject({ name: "DataCloneError" });

  hub.publish({ value: 3 });
  expect((await sibling.next()).value).toEqual({ value: 1 });
  expect((await sibling.next()).value).toEqual({ value: 3 });
  hub.end();
  expect((await sibling.next()).done).toBe(true);
});

/** Throw into observers with a blocked read or retained data; cancellation must release them before rejecting with the supplied cause, without affecting a sibling. */
test("throwing into subscriptions completes blocked reads and skips buffered values", async () => {
  const hub = new EventHub<number>();
  const blocked = hub.subscribe();
  const buffered = hub.subscribe();
  const sibling = hub.subscribe();
  const pending = blocked.next();
  const failure = new Error("consumer failed");
  await expect(blocked.throw?.(failure)).rejects.toBe(failure);
  expect((await pending).done).toBe(true);

  hub.publish(1);
  await expect(buffered.throw?.(failure)).rejects.toBe(failure);
  expect((await blocked.next()).done).toBe(true);
  expect((await buffered.next()).done).toBe(true);
  expect((await sibling.next()).value).toBe(1);
  hub.end();
  expect((await sibling.next()).done).toBe(true);
});
