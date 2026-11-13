// Bounds one producer stream with exclusive reader ownership; must not route session events.
import { HarnessSdkError } from "./errors";

/** Budgets supplied by public queue producers or EventHub.subscribe; construction rejects values other than positive safe integers and defaults omissions. */
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

/**
 * EventHub.subscribe creates one queue per observer; EventHub.publish uses synchronous admission to
 * isolate overflow. Public producers may instead await write. One iterator owns reads at a time;
 * returning it releases ownership without ending the producer. Producers own closure and consumers
 * own iterator release. Buffered regular events drain before controls, then completion or failure.
 */
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

  /**
   * EventHub.subscribe and public producers allocate storage here; invalid budgets throw INVALID_PARAMS.
   * sizeOf defaults to UTF-8 JSON byte length and may throw during admission. Callers must supply a
   * consistent measurement because a value can be measured more than once; no reader is claimed here.
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
   * push preflights synchronous admission here; public producers can also check without reserving
   * capacity and must still handle later admission failure. Throw on closure, frame-size/measurement
   * failure or a full regular buffer. Existing events remain intact for the reader to drain.
   */
  assertWritable(value: T): void {
    this.assertOpen();
    const bytes = this.checkedSize(value);
    if (this.isRegularBufferFull(bytes)) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
  }
  /**
   * EventHub.publish admits each subscriber's clone here and isolates admission failure to that
   * observer; write also calls after capacity becomes available. Deliver to a waiting read or buffer
   * synchronously, throwing on closure, capacity or size/measurement failure without evicting data.
   * Direct public producers must handle these failures and retain responsibility for closure.
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
   * Public producers await admission here when they can pause; EventHub.publish uses push instead.
   * Resolve after delivery/buffering, not consumption. Reject on closure, size/measurement failure or
   * exhausted writer capacity. Waking writers recheck capacity without reserving slots or promising
   * writer fairness. accepted runs synchronously after admission; if it throws, the promise rejects
   * but the value remains admitted. Producers retain closure and cancellation responsibility.
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
   * endWithControl and public control-event producers use this lane even when the regular buffer is
   * full. Each event still obeys maxFrameBytes and maxBytes; buffered controls have a separate
   * maxControlEvents limit and do not contribute to bufferedBytes.
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
   * Public producers may synchronously append their final control via this convenience call;
   * EventHub instead closes queues through end. Admit the final control before closing so a waiting
   * read receives it before completion; already-ended queues ignore it. Admission failures propagate
   * without closing, leaving recovery or explicit closure to the producer.
   */
  endWithControl(value: T): void {
    if (this.ended) return;
    this.pushControl(value);
    this.end();
  }
  /**
   * EventHub.subscribe closes already-ended subscriptions here and supplies endSubscription for
   * cancellation, publication failure and hub termination. Public producers and endWithControl
   * also close here. Idempotently wake writers to reject admission and settle any
   * pending read, retaining reader ownership. Buffered values drain before a truthy cause rejects
   * reads (otherwise they complete); the reader must still exhaust or return its iterator. Ending
   * this queue never stops a shared native producer.
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

  /**
   * EventHub.subscribe claims this reader once per private queue; other queue consumers must return or
   * exhaust their iterator before claiming another or receive EVENT_STREAM_ALREADY_OWNED. next
   * drains regular values then controls before terminal settlement; overlapping blocked reads reject
   * CONCURRENT_EVENT_READ. return/throw release ownership and settle a blocked read without closing
   * the producer. A pending read settled by end still needs a subsequent next/return to release ownership.
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
      /** Consumers (including EventHub.subscribe's wrapper) invoke this to drain, observe closure or wait; only regular consumption/direct-read availability wakes writers. */
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
      /** Consumer early exit releases this reader; EventHub.subscribe calls it on observer cancellation. */
      return: async () => detach(),
      /** Consumer failure releases ownership before rejecting with the supplied cause; the producer remains open. */
      throw: async (cause) => { detach(); throw cause; },
    };
  }
}
