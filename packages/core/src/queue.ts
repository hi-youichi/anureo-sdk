// Owns bounded admission, buffered drain and exclusive iterator ownership for one producer stream.
import { HarnessSdkError } from "./errors";

/** Queue budgets for producers and event subscriptions; each resolved budget must be a positive safe integer. */
export interface QueueLimits {
  /** Maximum buffered regular events; defaults to 2048. Direct delivery to a waiting reader consumes no slot. */
  maxEvents?: number;
  /** Maximum bytes buffered by regular events; defaults to 16 MiB. Controls have a separate count budget. */
  maxBytes?: number;
  /** Maximum bytes per regular or control event; defaults to 8 MiB. Each event must also fit maxBytes. */
  maxFrameBytes?: number;
  /** Maximum producers suspended awaiting capacity; defaults to 32. */
  maxWaitingWriters?: number;
  /** Maximum buffered controls; defaults to 33. They drain after regular events and use separate capacity. */
  maxControlEvents?: number;
}
/**
 * Buffer a producer stream within event and byte budgets, or await capacity with write.
 * One iterator owns reads at a time; returning it releases ownership without ending the producer.
 * Producers own closure and consumers own iterator release. Regular events drain before controls,
 * then completion or failure. Values are retained by reference; producers must not mutate buffered
 * values in ways that change their measured size. EventHub uses a private queue per observer to
 * isolate overflow, while adapter transports use queues for incoming frames or native input.
 */
export class BoundedEventQueue<T> implements AsyncIterable<T> {
  /** Resolved construction-time budgets exposed for producers; callers must treat this object as read-only. */
  readonly limits: Required<QueueLimits>;

  /**
   * Configure storage without claiming a reader; invalid resolved budgets throw INVALID_PARAMS.
   * Omitted or nullish budgets select the QueueLimits defaults. sizeOf defaults to UTF-8 JSON byte
   * length and may throw during admission. A custom measurement must return a consistent,
   * nonnegative byte count because a value can be measured more than once.
   */
  constructor(limits: QueueLimits = {}, private readonly sizeOf: (value: T) => number = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength) {
    this.limits = {
      maxEvents: limits.maxEvents ?? 2048,
      maxBytes: limits.maxBytes ?? 16 * 1024 * 1024,
      maxFrameBytes: limits.maxFrameBytes ?? 8 * 1024 * 1024,
      maxWaitingWriters: limits.maxWaitingWriters ?? 32,
      maxControlEvents: limits.maxControlEvents ?? 33,
    };
    if (Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new HarnessSdkError("INVALID_PARAMS", "Queue limits must be positive integers");
  }

  /** Public producers can inspect total buffered events; direct deliveries and suspended writers are excluded. */
  get bufferedEvents(): number { return this.entries.length + this.controls.length; }
  /** Public producers can inspect regular-buffer byte occupancy; controls consume only their separate count budget. */
  get bufferedBytes(): number { return this.bytes; }
  /**
   * Check regular-event admission without reserving capacity; a later push can still fail.
   * Throw the stored closure cause (or STREAM_CLOSED), FRAME_TOO_LARGE, measurement failures or
   * BACKPRESSURE_EXCEEDED for a full regular buffer. Buffered events remain available to drain.
   */
  assertWritable(value: T): void {
    this.assertOpen();
    const bytes = this.checkedSize(value);
    if (this.isRegularBufferFull(bytes)) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
  }
  /**
   * Deliver to a waiting read or buffer synchronously, throwing on closure, capacity or
   * size/measurement failure without evicting data. Producers handle failures and own closure.
   * EventHub.publish catches admission failure to end only the affected observer; transport
   * producers decide whether an admission failure should also close their native connection.
   */
  push(value: T): void {
    this.assertWritable(value);
    const bytes = this.checkedSize(value);
    const waiter = this.takeWaitingReader();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.entries.push({ value, bytes });
    this.bytes += bytes;
  }

  /**
   * Await capacity and resolve once delivered or buffered, without waiting for consumption.
   * Reject on closure, size/measurement failure or exhausted writer capacity.
   * Waking writers recheck capacity without reserving slots or promising
   * writer fairness. accepted runs synchronously after admission; if it throws, the promise rejects
   * but the value remains admitted. There is no per-write cancellation; producers can end the queue
   * to wake blocked writers and reject admission. EventHub.publish uses push to avoid waiting.
   */
  async write(value: T, accepted?: () => void): Promise<void> {
    const bytes = this.checkedSize(value);
    // Resuming notifies all waiting writers to recheck capacity; it reserves no slot.
    while (this.isRegularBufferFull(bytes)) {
      this.assertOpen();
      if (this.waitingWriterResumes.size >= this.limits.maxWaitingWriters) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
      await new Promise<void>((resolve) => this.waitingWriterResumes.add(resolve));
    }
    this.push(value);
    accepted?.();
  }

  /**
   * Admit a control event even when the regular buffer is full. Each event still obeys
   * maxFrameBytes and maxBytes; buffered controls have a separate maxControlEvents limit
   * and do not contribute to bufferedBytes.
   * Buffered regular events are delivered before buffered control events. Throws on closure,
   * measurement/size failure or exhausted control capacity; callers still own producer closure.
   */
  pushControl(value: T): void {
    this.assertOpen();
    this.checkedSize(value);
    const waiter = this.takeWaitingReader();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.controls.length >= this.limits.maxControlEvents) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Control event limit exceeded");
    this.controls.push(value);
  }
  /**
   * Admit a final control before closing so a waiting read receives it before completion;
   * already-ended queues ignore it. Admission failures propagate without closing, leaving
   * recovery or explicit closure to the producer.
   */
  endWithControl(value: T): void {
    if (this.ended) return;
    this.pushControl(value);
    this.end();
  }
  /**
   * Idempotently close admission, wake blocked writers to reject, and settle any pending read.
   * Buffered values drain before a truthy cause rejects reads; falsy causes complete reads normally.
   * Closure checks throw a non-nullish stored cause, otherwise STREAM_CLOSED.
   * Reader ownership remains until next observes drained closure or the iterator is returned/thrown.
   * EventHub ends queues for cancellation, publication failure and hub termination; ending a queue
   * alone never stops its native producer.
   */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = cause;
    this.resumeWaitingWriters();
    const waiter = this.takeWaitingReader();
    if (waiter) {
      if (cause) waiter.reject(cause);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  /**
   * Claim exclusive reader ownership, throwing EVENT_STREAM_ALREADY_OWNED until the prior reader
   * releases it. next drains regular values then controls before terminal completion or rejection;
   * overlapping blocked reads reject CONCURRENT_EVENT_READ. return/throw release ownership and
   * complete a blocked read without closing the producer. A pending read settled by end still needs
   * a subsequent next/return/throw to release ownership. EventHub claims one reader per subscription.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.activeReaderToken) throw new HarnessSdkError("EVENT_STREAM_ALREADY_OWNED");
    const readerToken = Symbol("reader");
    this.activeReaderToken = readerToken;
    let detached = false;
    /** next at terminal drain and return/throw call this; complete only this reader's pending read so a replacement reader keeps its ownership. Buffers and producer stay intact. */
    const detach = (): IteratorResult<T> => {
      detached = true;
      if (this.activeReaderToken === readerToken) this.activeReaderToken = undefined;
      const waiter = this.waiting;
      if (waiter?.readerToken === readerToken) {
        this.takeWaitingReader();
        waiter.resolve({ done: true, value: undefined });
      }
      return { done: true, value: undefined };
    };
    return {
      /** Consumers, including the subscription iterator, drain or wait here; regular consumption/direct-read availability wakes writers. */
      next: () => {
        if (detached) return Promise.resolve({ done: true, value: undefined });
        const buffered = this.readBuffered();
        if (buffered) return Promise.resolve(buffered);
        // After end, next releases ownership only once both buffers are drained.
        if (this.ended) {
          detach();
          return this.failure ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined });
        }
        if (this.waiting) return Promise.reject(new HarnessSdkError("CONCURRENT_EVENT_READ"));
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting = { readerToken, resolve, reject };
          this.resumeWaitingWriters();
        });
      },
      /** Consumer early exit releases this reader; createSubscription also invokes it when an observer cancels. */
      return: async () => detach(),
      /** Consumer failure releases ownership before rejecting with the supplied cause; the producer remains open. */
      throw: async (cause) => { detach(); throw cause; },
    };
  }

  private readonly entries: Entry<T>[] = [];
  private bytes = 0;
  private activeReaderToken?: symbol;
  private waiting?: Waiter<T>;
  private controls: T[] = [];
  private ended = false;
  private failure?: unknown;
  private waitingWriterResumes = new Set<() => void>();

  /**
   * end, readBuffered and the iterator next callback invoke this when closure or capacity may unblock a write.
   * Wake all blocked producers to recheck capacity; notifications reserve no slots and are cleared
   * after delivery.
   */
  private resumeWaitingWriters(): void {
    for (const resume of this.waitingWriterResumes) resume();
    this.waitingWriterResumes.clear();
  }
  /**
   * assertWritable and write share this admission rule. A pending read permits direct delivery even
   * at the buffer budget; checking capacity neither reserves a slot nor wakes a producer.
   */
  private isRegularBufferFull(bytes: number): boolean {
    return !this.waiting && (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes);
  }
  /**
   * push, pushControl, end and the iterator's detach callback take the pending read before settling it so later
   * producer work cannot deliver to the same promise. The caller chooses delivery, completion or failure.
   */
  private takeWaitingReader(): Waiter<T> | undefined {
    const waiter = this.waiting;
    this.waiting = undefined;
    return waiter;
  }
  /**
   * assertWritable, pushControl and suspended write admission use this before accepting more values. Reject
   * producer work after end using the stored failure or STREAM_CLOSED; does not detach the reader.
   */
  private assertOpen(): void { if (this.ended) throw this.failure ?? new HarnessSdkError("STREAM_CLOSED"); }
  /**
   * assertWritable, push, write and pushControl call before admission. Measure without reserving
   * capacity; throw FRAME_TOO_LARGE above either single-frame or regular-byte limits, including for
   * controls. Propagate sizeOf failures unchanged so the producer can handle admission failure.
   */
  private checkedSize(value: T): number {
    const bytes = this.sizeOf(value);
    if (bytes > this.limits.maxFrameBytes || bytes > this.limits.maxBytes) throw new HarnessSdkError("FRAME_TOO_LARGE");
    return bytes;
  }

  /**
   * The iterator's next callback drains regular values before controls, even if a control arrived
   * earlier. Release regular byte capacity before waking writers; controls do not consume it.
   * Return undefined only when neither buffer has data, leaving terminal settlement to next.
   */
  private readBuffered(): IteratorResult<T> | undefined {
    const entry = this.entries.shift();
    if (entry) {
      this.bytes -= entry.bytes;
      this.resumeWaitingWriters();
      return { done: false, value: entry.value };
    }
    if (this.controls.length) return { done: false, value: this.controls.shift()! };
    return undefined;
  }
}

/** A buffered regular event and the byte count reserved until its reader consumes it. */
type Entry<T> = { value: T; bytes: number };
/** One pending read tied to its owner so detachment cannot settle a replacement reader. */
type Waiter<T> = { readerToken: symbol; resolve: (value: IteratorResult<T>) => void; reject: (cause: unknown) => void };
