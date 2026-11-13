// Bounds one producer stream with exclusive reader ownership; must not route session events.
import { HarnessSdkError } from "./sdk-error";

/** Positive integer queue budgets; omitted values receive defaults in BoundedEventQueue without changing producer ordering. */
export interface QueueLimits {
  /** Buffered regular events; direct delivery to a waiting reader consumes no slot. */
  maxEvents?: number;
  /** Serialized bytes buffered by regular events; controls have a separate count budget. */
  maxBytes?: number;
  /** Serialized bytes allowed for a single regular or control event. */
  maxFrameBytes?: number;
  /** Number of producers allowed to suspend while awaiting capacity. */
  maxWaitingWriters?: number;
  /** Buffered control events delivered after regular events, even when regular capacity is full. */
  maxControlEvents?: number;
}
/** A buffered regular event and the byte count reserved until its reader consumes it. */
type Entry<T> = { value: T; bytes: number };
/** One pending read tied to its owner so detachment cannot settle a replacement reader. */
type Waiter<T> = { readerToken: symbol; resolve: (value: IteratorResult<T>) => void; reject: (cause: unknown) => void };

/** A single-active-reader queue. Returning an iterator detaches; it does not cancel its producer. */
export class BoundedEventQueue<T> implements AsyncIterable<T> {
  private readonly entries: Entry<T>[] = [];
  private bytes = 0;
  private activeReaderToken?: symbol;
  private waiting?: Waiter<T>;
  private controls: T[] = [];
  private ended = false;
  private failure?: unknown;
  private waitingWriterResumes = new Set<() => void>();
  /** Resolved construction-time budgets exposed for producers; callers must treat this object as read-only. */
  readonly limits: Required<QueueLimits>;

  /** Resolve and validate queue budgets or throw INVALID_PARAMS; sizeOf may throw during admission and must measure the same value consistently. */
  constructor(limits: QueueLimits = {}, private readonly sizeOf: (value: T) => number = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength) {
    this.limits = { maxEvents: limits.maxEvents ?? 2048, maxBytes: limits.maxBytes ?? 16 * 1024 * 1024, maxFrameBytes: limits.maxFrameBytes ?? 8 * 1024 * 1024, maxWaitingWriters: limits.maxWaitingWriters ?? 32, maxControlEvents: limits.maxControlEvents ?? 33 };
    if (Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new HarnessSdkError("INVALID_PARAMS", "Queue limits must be positive integers");
  }

  /** Count buffered regular and control events; excludes direct deliveries and suspended writers. */
  get bufferedEvents(): number { return this.entries.length + this.controls.length; }
  /** Bytes occupied by buffered regular events only; excludes control events. */
  get bufferedBytes(): number { return this.bytes; }
  /** Wake all blocked producers to recheck capacity; notifications reserve no slots and are cleared after delivery. */
  private resumeWaitingWriters(): void { for (const resume of this.waitingWriterResumes) resume(); this.waitingWriterResumes.clear(); }
  /** Reject producer work after end using the stored failure or STREAM_CLOSED; does not detach the reader. */
  private assertOpen(): void { if (this.ended) throw this.failure ?? new HarnessSdkError("STREAM_CLOSED"); }
  /** Measure one event and throw FRAME_TOO_LARGE if it cannot fit even in an empty queue; sizeOf failures propagate. */
  private checkedSize(value: T): number {
    const bytes = this.sizeOf(value);
    if (bytes > this.limits.maxFrameBytes || bytes > this.limits.maxBytes) throw new HarnessSdkError("FRAME_TOO_LARGE");
    return bytes;
  }

  /** For producers that cannot pause. Throws on closure, invalid size, or full capacity; never evicts buffered events. */
  assertWritable(value: T): void {
    this.assertOpen();
    const bytes = this.checkedSize(value);
    if (!this.waiting && (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes)) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
  }
  /** Synchronously deliver or buffer one event; throw on closed/capacity/size failure without eviction. Waiting readers bypass regular buffering. */
  push(value: T): void {
    this.assertWritable(value);
    const bytes = this.checkedSize(value);
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve({ done: false, value }); return; }
    this.entries.push({ value, bytes }); this.bytes += bytes;
  }

  /**
   * For producers which await the sink. The number of suspended writers is bounded too.
   * `accepted` runs synchronously after admission succeeds; it does not signal consumption.
   * Rejects on closure, invalid size, or exhausted waiting-writer capacity. The callback
   * is never called when admission fails.
   */
  async write(value: T, accepted?: () => void): Promise<void> {
    const bytes = this.checkedSize(value);
    // Resuming notifies all waiting writers to recheck capacity; it reserves no slot.
    while (!this.waiting && (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes)) {
      this.assertOpen();
      if (this.waitingWriterResumes.size >= this.limits.maxWaitingWriters) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      await new Promise<void>((resolve) => this.waitingWriterResumes.add(resolve));
    }
    this.push(value); accepted?.();
  }

  /**
   * Adds a control event even when the regular queue is full. Each event still
   * obeys maxFrameBytes and maxBytes; buffered controls have a separate
   * maxControlEvents limit and do not contribute to bufferedBytes.
   * Buffered regular events are delivered before buffered control events.
   */
  pushControl(value: T): void {
    this.assertOpen(); this.checkedSize(value);
    if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve({ done: false, value }); }
    else {
      if (this.controls.length >= this.limits.maxControlEvents) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Control event limit exceeded");
      this.controls.push(value);
    }
  }
  /** Append the final control before ending the producer; already-ended queues ignore it, while admission failures leave closure to the caller. */
  endWithControl(value: T): void {
    if (this.ended) return;
    this.pushControl(value); this.end();
  }
  /** Closes the producer and settles any pending read, retaining reader ownership. */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true; this.failure = cause; this.resumeWaitingWriters();
    if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; cause ? waiter.reject(cause) : waiter.resolve({ done: true, value: undefined }); }
  }

  /** Claim exclusive reader ownership or throw; drain regular events before controls and release ownership on terminal drain or iterator detachment. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.activeReaderToken) throw new HarnessSdkError("EVENT_STREAM_ALREADY_OWNED");
    const readerToken = Symbol("reader");
    this.activeReaderToken = readerToken;
    let detached = false;
    /** Release this iterator’s ownership and complete its pending read without closing the producer or discarding buffered events. */
    const detach = (): IteratorResult<T> => {
      detached = true;
      if (this.activeReaderToken === readerToken) this.activeReaderToken = undefined;
      if (this.waiting?.readerToken === readerToken) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve({ done: true, value: undefined }); }
      return { done: true, value: undefined };
    };
    return {
      next: () => {
        if (detached) return Promise.resolve({ done: true, value: undefined });
        const entry = this.entries.shift();
        if (entry) { this.bytes -= entry.bytes; this.resumeWaitingWriters(); return Promise.resolve({ done: false, value: entry.value }); }
        if (this.controls.length) return Promise.resolve({ done: false, value: this.controls.shift()! });
        // After end, next releases ownership only once both buffers are drained.
        if (this.ended) { detach(); return this.failure ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined }); }
        if (this.waiting) return Promise.reject(new HarnessSdkError("CONCURRENT_EVENT_READ"));
        return new Promise<IteratorResult<T>>((resolve, reject) => { this.waiting = { readerToken, resolve, reject }; this.resumeWaitingWriters(); });
      },
      return: async () => detach(),
      throw: async (cause) => { detach(); throw cause; },
    };
  }
}
