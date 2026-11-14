// Owns isolated live event fan-out and each observer's queue, reader and cancellation lifetime.
import { BoundedEventQueue } from '../queue';
import type { EventSubscriptionOptions } from '../types';

/**
 * Package-internal fan-out for bounded live subscriptions without replay or producer backpressure.
 * Session.publish feeds the session hub and Session.retainEvent feeds each execution hub.
 * Session orders and ends those streams. Consumers release their own subscriptions.
 */
export class EventHub<T> {
  /**
   * Subscribe to future events with an independent queue. Session.events and Turn.events return
   * this iterator to host consumers, who exhaust or return it, or abort the signal to release it.
   * Invalid budgets throw synchronously. The optional filter defaults to accepting all events. An
   * overlapping blocked read rejects with CONCURRENT_EVENT_READ and ends the subscription.
   * Cancelling a live subscription completes its blocked and future reads and skips any
   * buffered events. Once detached by termination or failure, abort no longer affects the reader.
   * Late subscribers observe the stored termination even if their signal is already aborted.
   */
  subscribe(options: EventSubscriptionOptions = {}, accepts: (value: T) => boolean = () => true): AsyncIterableIterator<T> {
    const subscription = createSubscription({ options, accepts, remove: observer => this.subscribers.delete(observer) });
    if (this.termination) {
      subscription.queue.end(this.termination.cause);
    } else if (options.signal?.aborted) {
      subscription.cancel();
    } else {
      this.subscribers.add(subscription);
      options.signal?.addEventListener('abort', subscription.cancel, { once: true });
    }
    return subscription.iterator;
  }

  /**
   * Session.publish sends session events here; Session.retainEvent sends execution events here before
   * ending terminal streams. Offer the event synchronously to each subscriber in registration
   * order. Each subscriber filters and clones it independently. A filter, clone or queue admission
   * failure closes that subscription and lets delivery continue. Ignore publication after hub end.
   */
  publish(value: T): void {
    if (this.termination) return;
    for (const subscriber of this.subscribers) deliverToSubscriber(subscriber, value);
  }

  /**
   * Session.retainEvent ends terminal execution streams; Session.endObservation ends remaining
   * execution and session streams with a failure. Idempotently end all observers with an optional read
   * failure and remove their abort listeners. Queued events drain before a truthy cause rejects reads
   * (otherwise reads complete). Later subscribers observe the first termination without replay.
   * Consumers still own returning or exhausting their readers.
   */
  end(cause?: unknown): void {
    if (this.termination) return;
    this.termination = { cause };
    for (const subscriber of this.subscribers) {
      subscriber.end(cause);
    }
  }

  private readonly subscribers = new Set<Subscription<T>>();
  private termination?: { cause: unknown };
}

/** One observer's resources; EventHub owns membership while createSubscription owns reader cleanup. */
type Subscription<T> = {
  /** subscribe closes this directly for late readers, before registering any membership or listener. */
  queue: BoundedEventQueue<T>;
  /** deliverToSubscriber invokes this before cloning. */
  accepts: (value: T) => boolean;
  /** Remove membership/listener and close admission, preserving buffered drain before termination. */
  end: (cause?: unknown) => void;
  /** Abort listener and iterator early-exit callback; skip retained data and release the reader. */
  cancel: () => void;
  iterator: AsyncIterableIterator<T>;
};

/**
 * EventHub.subscribe allocates an observer here before deciding whether to register it or close it.
 * Queue construction can throw before registration. Closure calls remove to release hub membership
 * and leaves the reader available to drain. Cancellation also returns the reader to release ownership.
 */
function createSubscription<T>({ options, accepts, remove }: {
  options: EventSubscriptionOptions;
  accepts: (value: T) => boolean;
  remove: (subscription: Subscription<T>) => void;
}): Subscription<T> {
  const queue = createSubscriptionQueue<T>(options);
  const reader = queue[Symbol.asyncIterator]();
  let cancelled = false;
  /** Remove hub membership and the listener registered by subscribe, leaving the reader available to drain. */
  const detach = () => {
    remove(subscription);
    options.signal?.removeEventListener('abort', cancelSubscription);
  };
  /** Hub termination and delivery/read failures detach before closing admission, preserving buffered drain. */
  const endSubscription = (cause?: unknown) => {
    detach();
    queue.end(cause);
  };
  /** subscribe registers this abort listener; early iterator exit also skips retained data and releases ownership. */
  const cancelSubscription = () => {
    cancelled = true;
    endSubscription();
    void reader.return?.();
  };
  const iterator: AsyncIterableIterator<T> = {
    /** Reuse the claimed reader for for-await, without acquiring a second queue reader. */
    [Symbol.asyncIterator]() { return this; },
    /** Await queue delivery/termination and propagate read failures after detaching; cancellation skips retained data. */
    async next() {
      if (cancelled) return { done: true, value: undefined };
      try {
        const result = await reader.next();
        if (result.done) detach();
        return result;
      } catch (cause) {
        endSubscription(cause);
        throw cause;
      }
    },
    /** Early exit completes this observer's blocked reads without stopping the shared producer. */
    async return() {
      cancelSubscription();
      return { done: true, value: undefined };
    },
    /** Release this observer before rejecting with the consumer's supplied cause. */
    async throw(cause) {
      cancelSubscription();
      throw cause;
    },
  };
  const subscription: Subscription<T> = { queue, accepts, end: endSubscription, cancel: cancelSubscription, iterator };
  return subscription;
}

/** Allocate an observer's queue, capping individual events at 8 MiB or the smaller total byte budget. Invalid limits throw before registration. */
function createSubscriptionQueue<T>(options: EventSubscriptionOptions): BoundedEventQueue<T> {
  const maxBytes = options.queue?.maxBytes ?? 16 * 1024 * 1024;
  return new BoundedEventQueue<T>({
    ...options.queue,
    maxBytes,
    maxFrameBytes: Math.min(maxBytes, 8 * 1024 * 1024),
  });
}

/**
 * EventHub.publish offers each event here. Filter before cloning so each accepting subscriber gets
 * its own copy. On failure, close only this subscriber and preserve its buffered events before a
 * truthy cause rejects reads or a falsy cause completes them.
 */
function deliverToSubscriber<T>(subscriber: Subscription<T>, value: T): void {
  try {
    if (subscriber.accepts(value)) subscriber.queue.push(structuredClone(value));
  } catch (cause) {
    subscriber.end(cause);
  }
}
