// Owns bounded admission, buffered drain and exclusive iterator ownership for one producer stream.
import { HarnessSdkError } from "./errors";

/** Queue budgets for producers and event subscriptions. Each resolved budget must be a positive safe integer. */
export interface QueueLimits {
  /** Maximum buffered regular events; defaults to 2048. Direct delivery to a waiting reader consumes no slot. */
  maxEvents?: number;
  /** Maximum bytes buffered by regular events; defaults to 16 MiB. Controls have a separate count budget. */
  maxBytes?: number;
  /** Maximum bytes per regular or control event; defaults to 8 MiB. Each event must also fit maxBytes. */
  maxFrameBytes?: number;
  /** Maximum suspended write calls. Defaults to 32. */
  maxWaitingWriters?: number;
  /** Maximum buffered controls; defaults to 33. They drain after regular events and use separate capacity. */
  maxControlEvents?: number;
}
/**
 * Buffer a producer stream within event and byte budgets, or await capacity with write.
 * One iterator owns reads at a time. Returning it releases ownership while the producer stays open.
 * Producers own closure and consumers own iterator release. Buffered regular events drain before
 * buffered controls, then readers observe completion or failure. Values are retained by reference;
 * keep their measured size stable while queued. EventHub uses a private queue per observer to
 * isolate overflow, while adapter transports use queues for incoming frames or native input.
 */
export class BoundedEventQueue<T> implements AsyncIterable<T> {
  /**
   * Configure storage without claiming a reader. Invalid resolved budgets throw INVALID_PARAMS.
   * Omitted or nullish budget fields select the QueueLimits defaults. The queue calls sizeOf during
   * admission and propagates measurement failures. It defaults to measuring the UTF-8 byte length
   * of the JSON serialization. A custom measurement must return a consistent, nonnegative byte
   * count because a value can be measured more than once.
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

  /** Resolved construction-time budgets exposed for producers; callers must treat this object as read-only. */
  readonly limits: Required<QueueLimits>;

  /** Count regular events and controls currently in the buffer. */
  get bufferedEvents(): number { return this.entries.length + this.controls.length; }
  /** Count bytes reserved by buffered regular events. Controls consume their own event budget. */
  get bufferedBytes(): number { return this.bytes; }
  /**
   * Check regular-event admission without reserving capacity. A later push can still fail.
   * Throw the stored non-nullish closure cause (or STREAM_CLOSED), FRAME_TOO_LARGE, a measurement
   * failure, or BACKPRESSURE_EXCEEDED for a full regular buffer.
   */
  assertWritable(value: T): void {
    this.assertOpen();
    const bytes = this.checkedSize(value);
    if (this.isRegularBufferFull(bytes)) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED");
  }
  /**
   * Deliver to a waiting read or buffer synchronously, throwing on closure, capacity or
   * size/measurement failure without evicting data. Producers handle failures and own closure.
   * EventHub.publish ends only the affected observer on failure. The message listener in
   * createSocketTransport also closes the native socket.
   */
  push(value: T): void {
    // Run the overridable admission probe before measuring the value for storage.
    this.assertWritable(value);
    const bytes = this.checkedSize(value);
    if (this.deliverToWaitingReader(value)) return;
    this.entries.push({ value, bytes });
    this.bytes += bytes;
  }

  /**
   * Await capacity and resolve once delivered or buffered, without waiting for consumption.
   * Reject on closure, size/measurement failure or exhausted writer capacity.
   * Waking writers compete for capacity and recheck it before admitting a value. Pass accepted
   * to run a synchronous callback after admission. If it throws, the promise rejects and the value
   * remains admitted. Producers can end the queue to wake all blocked writers and reject admission.
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
    if (this.deliverToWaitingReader(value)) return;
    if (this.controls.length >= this.limits.maxControlEvents) throw new HarnessSdkError("BACKPRESSURE_EXCEEDED", "Control event limit exceeded");
    this.controls.push(value);
  }
  /**
   * Admit a final control under the usual control budget, then close admission. Readers can
   * receive the control before completion. Already-ended queues ignore the value. If admission
   * throws, the producer still owns recovery or closure.
   */
  endWithControl(value: T): void {
    if (this.ended) return;
    this.pushControl(value);
    this.end();
  }
  /**
   * Idempotently close admission, wake blocked writers so they can reject, and settle any pending read.
   * Buffered values drain before a truthy cause rejects reads; falsy causes complete reads normally.
   * Closure checks throw a non-nullish stored cause, otherwise STREAM_CLOSED.
   * Reader ownership remains until next observes drained closure or the consumer calls return or
   * throw on the iterator. The caller still owns stopping any native producer.
   */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = cause;
    this.resumeWaitingWriters();
    const waiter = this.takePendingRead();
    if (!waiter) return;
    if (cause) waiter.reject(cause);
    else waiter.resolve(completedRead());
  }

  /**
   * Claim exclusive reader ownership, throwing EVENT_STREAM_ALREADY_OWNED until the prior reader
   * releases it. next drains regular values then controls before terminal completion or rejection.
   * A second next while a read is blocked rejects with CONCURRENT_EVENT_READ. return and throw
   * release ownership and complete a blocked read while leaving the producer open. throw also
   * rejects its own promise with the supplied cause. A pending read settled by end still needs
   * a subsequent next, return or throw to release ownership.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.activeReaderToken) throw new HarnessSdkError("EVENT_STREAM_ALREADY_OWNED");
    const readerToken = Symbol("reader");
    this.activeReaderToken = readerToken;
    return {
      next: () => this.readNext(readerToken),
      return: async () => {
        this.detachReader(readerToken);
        return completedRead();
      },
      throw: async (cause) => {
        this.detachReader(readerToken);
        throw cause;
      },
    };
  }

  private readonly entries: Entry<T>[] = [];
  private bytes = 0;
  private activeReaderToken?: symbol;
  private pendingRead?: PendingRead<T>;
  private controls: T[] = [];
  private ended = false;
  private failure?: unknown;
  private waitingWriterResumes = new Set<() => void>();

  /**
   * end, readBuffered and readNext wake blocked writers when they close the queue, free capacity
   * or register a reader for direct delivery. Writers recheck admission on resumption.
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
    return !this.pendingRead && (this.entries.length >= this.limits.maxEvents || this.bytes + bytes > this.limits.maxBytes);
  }
  /**
   * push and pushControl try direct delivery after checking size. Report whether this settled
   * a pending read so the caller can skip buffering.
   */
  private deliverToWaitingReader(value: T): boolean {
    const waiter = this.takePendingRead();
    if (!waiter) return false;
    waiter.resolve({ done: false, value });
    return true;
  }

  /** Remove the pending read before its caller delivers a value, completes it or rejects it. */
  private takePendingRead(): PendingRead<T> | undefined {
    const read = this.pendingRead;
    this.pendingRead = undefined;
    return read;
  }
  /**
   * Producer admission uses this to check for closure. A closed queue throws the stored
   * non-nullish cause or STREAM_CLOSED and keeps the reader attached.
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
   * Settle the iterator's next call from buffered data or drained closure. Otherwise register a
   * pending read and wake writers because they can now deliver directly. A detached reader
   * completes immediately, and an overlapping blocked read rejects without replacing the first.
   */
  private readNext(readerToken: symbol): Promise<IteratorResult<T>> {
    if (this.activeReaderToken !== readerToken) return Promise.resolve(completedRead());
    const buffered = this.readBuffered();
    if (buffered) return Promise.resolve(buffered);
    if (this.ended) {
      this.detachReader(readerToken);
      return this.failure ? Promise.reject(this.failure) : Promise.resolve(completedRead());
    }
    if (this.pendingRead) return Promise.reject(new HarnessSdkError("CONCURRENT_EVENT_READ"));
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pendingRead = { resolve, reject };
      this.resumeWaitingWriters();
    });
  }

  /**
   * readNext on drained closure and the iterator's return and throw release ownership here.
   * createSubscription also calls return when cancelled. Only the active reader can have a pending
   * read, so checking its token protects a replacement reader from stale calls.
   */
  private detachReader(readerToken: symbol): void {
    if (this.activeReaderToken !== readerToken) return;
    this.activeReaderToken = undefined;
    this.takePendingRead()?.resolve(completedRead());
  }

  /**
   * Give readNext regular values before controls and release regular bytes before waking writers.
   * Return undefined only when neither buffer has data, leaving terminal settlement to readNext.
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
/** The pending next call belongs to the active reader until delivery, closure or detachment. */
type PendingRead<T> = { resolve: (value: IteratorResult<T>) => void; reject: (cause: unknown) => void };

/** Give each completed read its own result object. */
function completedRead(): IteratorReturnResult<undefined> {
  return { done: true, value: undefined };
}
