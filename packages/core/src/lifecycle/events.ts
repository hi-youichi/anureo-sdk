// Fans out isolated bounded event subscriptions; must not backpressure the native reader or validate lifecycle order.
import { BoundedEventQueue } from '../queue';

/** Per-observer cancellation and buffering; signal ends only this subscription and queue overflow never pauses the shared native producer. */
export interface EventSubscriptionOptions {
  /** Aborts only this observer, releasing its pending read and membership. */
  signal?: AbortSignal;
  /** Per-subscription regular-event capacity in count and serialized bytes. */
  queue?: { maxEvents?: number; maxBytes?: number };
}

type Subscription<T> = {
  /** This subscriber’s private bounded storage and reader. */
  queue: BoundedEventQueue<T>;
  /** Filter evaluated before cloning; a thrown filter failure ends this subscriber. */
  accepts: (value: T) => boolean;
  /** Remove this subscriber and its abort listener without ending the hub. */
  detach: () => void;
};

/** A single producer with isolated, bounded subscriptions. It never backpressures a wire reader. */
export class EventHub<T> {
  private readonly subscribers = new Set<Subscription<T>>();
  private ended = false;
  private failure?: unknown;

  /** Allocate a bounded reader, attach optional cancellation/filtering, and return its iterator. Invalid budgets and setup cloning fail synchronously; overflow and publication failures reject reads. Cancellation detaches only this observer. */
  subscribe(options: EventSubscriptionOptions = {}, accepts: (value: T) => boolean = () => true): AsyncIterableIterator<T> {
    const maxBytes = options.queue?.maxBytes ?? 16 * 1024 * 1024;
    const queue = new BoundedEventQueue<T>({ ...options.queue, maxBytes, maxFrameBytes: Math.min(maxBytes, 8 * 1024 * 1024) });
    const reader = queue[Symbol.asyncIterator]();
    let cancelled = false;
    /** Remove membership and abort listener without ending the producer; called on reader completion, cancellation and subscriber failure. */
    const detach = () => {
      this.subscribers.delete(subscription);
      options.signal?.removeEventListener('abort', cancelSubscription);
    };
    /** End only this observer and release its queue reader; returning/aborting must not retain a blocked next call. */
    const cancelSubscription = () => {
      cancelled = true;
      detach();
      queue.end();
      void reader.return?.();
    };
    const subscription: Subscription<T> = { queue, accepts, detach };
    if (this.ended) queue.end(this.failure);
    else if (options.signal?.aborted) cancelSubscription();
    else {
      this.subscribers.add(subscription);
      options.signal?.addEventListener('abort', cancelSubscription, { once: true });
    }
    return {
      /** This object is its own reader; ownership was already allocated by subscribe. */
      [Symbol.asyncIterator]() { return this; },
      /** Drain this observer and detach its listener/membership on completion or failure. */
      async next() {
        if (cancelled) return { done: true, value: undefined };
        try {
          const result = await reader.next();
          if (result.done) detach();
          return result;
        } catch (cause) { detach(); queue.end(cause); throw cause; }
      },
      /** Cancel only this observer and complete pending reads without stopping the shared producer. */
      async return() { cancelSubscription(); return { done: true, value: undefined }; },
      /** Release this observer before propagating the consumer-supplied failure. */
      async throw(cause) { cancelSubscription(); throw cause; },
    };
  }

  /** Clone into each accepting subscription synchronously; isolate filter/clone/overflow failures by ending only that subscriber. Ignore publication after hub end. */
  publish(value: T): void {
    if (this.ended) return;
    for (const subscriber of this.subscribers) {
      try {
        if (subscriber.accepts(value)) subscriber.queue.push(structuredClone(value));
      } catch (cause) {
        subscriber.detach();
        subscriber.queue.end(cause);
      }
    }
  }

  /** Idempotently end all observers with an optional read failure and remove their listeners; queued events drain before terminal read. */
  end(cause?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = cause;
    for (const subscriber of this.subscribers) {
      subscriber.detach();
      subscriber.queue.end(cause);
    }
  }
}
