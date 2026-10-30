import { HarnessSdkError } from "./errors";

export interface QueueLimits { maxEvents?: number; maxBytes?: number; maxFrameBytes?: number; maxWaitingWriters?: number; maxControlEvents?: number }
type Entry<T> = { value: T; bytes: number };
type Waiter<T> = { reader: symbol; resolve: (value: IteratorResult<T>) => void; reject: (cause: unknown) => void };

/** A single-active-reader queue. Returning an iterator detaches; it does not cancel its producer. */
export class BoundedEventQueue<T> implements AsyncIterable<T> {
  private readonly entries: Entry<T>[] = [];
  private bytes = 0;
  private reader?: symbol;
  private waiting?: Waiter<T>;
  private controls: T[] = [];
  private ended = false;
  private failure?: unknown;
  private writers = new Set<() => void>();
  readonly limits: Required<QueueLimits>;

  constructor(limits: QueueLimits = {}, private readonly sizeOf: (value: T) => number = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength) {
    this.limits = { maxEvents: limits.maxEvents ?? 2048, maxBytes: limits.maxBytes ?? 16 * 1024 * 1024, maxFrameBytes: limits.maxFrameBytes ?? 8 * 1024 * 1024, maxWaitingWriters: limits.maxWaitingWriters ?? 32, maxControlEvents: limits.maxControlEvents ?? 33 };
    if (Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new HarnessSdkError("INVALID_PARAMS", "Queue limits must be positive integers");
  }

  get bufferedEvents(): number { return this.entries.length + this.controls.length; }
  get bufferedBytes(): number { return this.bytes; }
  private wakeWriters(): void { for (const wake of this.writers) wake(); this.writers.clear(); }
  private assertOpen(): void { if (this.ended) throw this.failure ?? new HarnessSdkError("STREAM_CLOSED"); }
  private checkedSize(value: T): number {
    const bytes = this.sizeOf(value);
    if (bytes > this.limits.maxFrameBytes || bytes > this.limits.maxBytes) throw new HarnessSdkError("FRAME_TOO_LARGE");
    return bytes;
  }

  /** For producers that cannot pause. Overflow is an explicit error, never an eviction. */
  assertWritable(value: T): void {
    this.assertOpen();
    const bytes = this.checkedSize(value);
    if (!this.waiting && (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes)) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
  }
  push(value: T): void {
    this.assertWritable(value);
    const bytes = this.checkedSize(value);
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve({ done: false, value }); return; }
    this.entries.push({ value, bytes }); this.bytes += bytes;
  }

  /** For producers which await the sink. The number of suspended writers is bounded too. */
  async write(value: T, accepted?: () => void): Promise<void> {
    const bytes = this.checkedSize(value);
    while (!this.waiting && (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes)) {
      this.assertOpen();
      if (this.writers.size >= this.limits.maxWaitingWriters) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      await new Promise<void>((resolve) => this.writers.add(resolve));
    }
    this.push(value); accepted?.();
  }

  /** Reserved for a final failure event, even if the regular queue is full. */
  pushControl(value: T): void {
    this.assertOpen(); this.checkedSize(value);
    if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve({ done: false, value }); }
    else {
      if (this.controls.length >= this.limits.maxControlEvents) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Control event limit exceeded");
      this.controls.push(value);
    }
  }
  endWithControl(value: T): void {
    if (this.ended) return;
    this.pushControl(value); this.end();
  }
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true; this.failure = cause; this.wakeWriters();
    if (this.waiting) { const waiter = this.waiting; this.waiting = undefined; cause ? waiter.reject(cause) : waiter.resolve({ done: true, value: undefined }); }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.reader) throw new HarnessSdkError("EVENT_STREAM_ALREADY_OWNED");
    const reader = Symbol("reader"); this.reader = reader;
    let detached = false;
    const detach = (): IteratorResult<T> => {
      detached = true;
      if (this.reader === reader) this.reader = undefined;
      if (this.waiting?.reader === reader) { const waiter = this.waiting; this.waiting = undefined; waiter.resolve({ done: true, value: undefined }); }
      return { done: true, value: undefined };
    };
    return {
      next: () => {
        if (detached) return Promise.resolve({ done: true, value: undefined });
        const entry = this.entries.shift();
        if (entry) { this.bytes -= entry.bytes; this.wakeWriters(); return Promise.resolve({ done: false, value: entry.value }); }
        if (this.controls.length) return Promise.resolve({ done: false, value: this.controls.shift()! });
        if (this.ended) { detach(); return this.failure ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined }); }
        if (this.waiting) return Promise.reject(new HarnessSdkError("CONCURRENT_EVENT_READ"));
        return new Promise<IteratorResult<T>>((resolve, reject) => { this.waiting = { reader, resolve, reject }; this.wakeWriters(); });
      },
      return: async () => detach(),
      throw: async (cause) => { detach(); throw cause; },
    };
  }
}
