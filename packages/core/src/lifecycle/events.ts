// Owns isolated live event fan-out and each observer's queue, reader and cancellation lifetime.
import { BoundedEventQueue } from '../queue';
import type { EventSubscriptionOptions } from '../types';

/**
 * Package-internal fan-out for bounded live subscriptions without replay or producer backpressure.
 * Session owns a session hub and creates execution hubs in context; Session.publish/retainEvent feed
 * them while Session.events and Turn.events return subscriptions. Session owns hub termination and
 * lifecycle ordering; consumers own subscription release and explicit native cancellation.
 */
export class EventHub<T> {
  /**
   * Subscribe to future events with an independent queue; exhaust, return or abort the iterator to
   * release membership. Session.events and Turn.events return it to host consumers. Invalid budgets
   * throw synchronously; overflow and truthy publication failures reject reads after buffered drain.
   * publish invokes accepts before cloning; the default accepts every event, as used by both callers.
   * Cancellation completes only this observer's blocked and future reads. A subscription created
   * after hub termination observes that termination, even if its signal is already aborted.
   */
  subscribe(options: EventSubscriptionOptions = {}, accepts: (value: T) => boolean = () => true): AsyncIterableIterator<T> {
    const subscription = createSubscription({ options, accepts, remove: observer => this.subscribers.delete(observer) });
    if (this.ended) subscription.queue.end(this.failure);
    else if (options.signal?.aborted) subscription.cancel();
    else {
      this.subscribers.add(subscription);
      options.signal?.addEventListener('abort', subscription.cancel, { once: true });
    }
    return subscription.iterator;
  }

  /**
   * Session.publish sends session events here; Session.retainEvent sends execution events here before
   * ending terminal streams. Clone into each accepting subscription synchronously; isolate
   * filter/clone/overflow failures by ending only that subscriber; its buffered events drain before
   * reads reject with a truthy original cause (falsy causes complete the queue). Siblings continue
   * receiving independent clones. Ignore publication after hub end; Session still owns native
   * execution and event ordering.
   */
  publish(value: T): void {
    if (this.ended) return;
    for (const subscriber of this.subscribers) {
      try {
        if (subscriber.accepts(value)) subscriber.queue.push(structuredClone(value));
      } catch (cause) {
        subscriber.end(cause);
      }
    }
  }

  /**
   * Session.retainEvent ends terminal execution streams; Session.endObservation ends remaining
   * execution and session streams with a failure. Idempotently end all observers with an optional read
   * failure and remove their listeners; queued events drain before a truthy cause rejects reads
   * (otherwise reads complete). Later subscribers observe the stored termination without replay.
   * Consumers still own returning/exhausting readers;
   * this method neither interrupts native execution nor cancels host operations.
   */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = cause;
    for (const subscriber of this.subscribers) {
      subscriber.end(cause);
    }
  }

  private readonly subscribers = new Set<Subscription<T>>();
  private ended = false;
  private failure?: unknown;
}

/** One observer's resources; EventHub owns membership while createSubscription owns reader cleanup. */
type Subscription<T> = {
  queue: BoundedEventQueue<T>;
  /** publish invokes this before cloning; a throw ends only this subscriber. */
  accepts: (value: T) => boolean;
  /** Remove membership/listener and close admission, preserving buffered drain before termination. */
  end: (cause?: unknown) => void;
  /** Abort listener and iterator early-exit callback; skip retained data and release the reader. */
  cancel: () => void;
  iterator: AsyncIterableIterator<T>;
};

/**
 * EventHub.subscribe allocates an observer here before deciding whether to register it or close it.
 * Own the private queue, reader and cancellation state together; remove releases hub membership but
 * must not end sibling subscriptions. Queue construction can throw before any listener is registered.
 * Ending preserves buffered drain, while cancellation also returns the reader to complete blocked reads.
 */
function createSubscription<T>({ options, accepts, remove }: {
  options: EventSubscriptionOptions;
  accepts: (value: T) => boolean;
  remove: (subscription: Subscription<T>) => void;
}): Subscription<T> {
  const maxBytes = options.queue?.maxBytes ?? 16 * 1024 * 1024;
  const queue = new BoundedEventQueue<T>({ ...options.queue, maxBytes, maxFrameBytes: Math.min(maxBytes, 8 * 1024 * 1024) });
  const reader = queue[Symbol.asyncIterator]();
  let cancelled = false;
  /** Completion and closure remove membership/listener without releasing the reader or affecting siblings. */
  const detach = () => {
    remove(subscription);
    options.signal?.removeEventListener('abort', cancelSubscription);
  };
  /** publish/end and read failures close admission after detaching, leaving admitted data available to drain. */
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
