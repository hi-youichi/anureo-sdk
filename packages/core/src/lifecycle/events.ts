// Fans out isolated bounded event subscriptions; must not backpressure the native reader or validate lifecycle order.
import { BoundedEventQueue } from '../queue';
import type { EventSubscriptionOptions } from '../types';

/** Private observer state allocated by EventHub.subscribe; publish/end terminate only the affected queue and release its membership/listener. */
type Subscription<T> = {
  /** This subscriber’s private bounded storage; subscribe owns its reader. */
  queue: BoundedEventQueue<T>;
  /** Filter evaluated before cloning; a thrown filter failure ends this subscriber. */
  accepts: (value: T) => boolean;
  /** Detach membership/listener and end this queue; buffered events remain available before failure/completion. */
  end: (cause?: unknown) => void;
};

/**
 * Session owns a session hub and creates execution hubs in context; Session.publish/retainEvent feed
 * them while Session.events and Turn.events return subscriptions. A single producer with isolated,
 * bounded live subscriptions without replay. It never backpressures a wire reader. Session owns hub
 * termination and lifecycle ordering; consumers own subscription release and native cancellation.
 */
export class EventHub<T> {
  private readonly subscribers = new Set<Subscription<T>>();
  private ended = false;
  private failure?: unknown;

  /**
   * Session.events and Turn.events return this iterator to host consumers, who must exhaust it, return
   * it or abort its signal to release membership. Allocate a bounded reader, attach optional
   * cancellation/filtering, and return its iterator. Invalid budgets fail synchronously; overflow and
   * truthy publication failures reject reads after queued events drain. accepts is invoked by publish before
   * cloning; Session.events and Turn.events use the default filter. Cancellation completes only this
   * observer's blocked and future reads. A subscription created after hub termination observes that
   * termination, even if its supplied signal is already aborted.
   */
  subscribe(options: EventSubscriptionOptions = {}, accepts: (value: T) => boolean = () => true): AsyncIterableIterator<T> {
    const maxBytes = options.queue?.maxBytes ?? 16 * 1024 * 1024;
    const queue = new BoundedEventQueue<T>({ ...options.queue, maxBytes, maxFrameBytes: Math.min(maxBytes, 8 * 1024 * 1024) });
    const reader = queue[Symbol.asyncIterator]();
    let cancelled = false;
    /** next calls on completion, and endSubscription before queue closure; remove membership/listener without closing sibling queues or releasing this queue's reader. */
    const detach = () => {
      this.subscribers.delete(subscription);
      options.signal?.removeEventListener('abort', cancelSubscription);
    };
    /** publish/end invoke this through Subscription.end; next failures and cancellation call directly. Detach before ending the queue, preserving buffered drain before terminal settlement. */
    const endSubscription = (cause?: unknown) => {
      detach();
      queue.end(cause);
    };
    /** subscribe registers this abort listener and invokes it for pre-aborted signals; iterator return/throw also call it. End only this observer and return its reader so blocked/future reads complete without draining retained data. */
    const cancelSubscription = () => {
      cancelled = true;
      endSubscription();
      void reader.return?.();
    };
    const subscription: Subscription<T> = { queue, accepts, end: endSubscription };
    if (this.ended) queue.end(this.failure);
    else if (options.signal?.aborted) cancelSubscription();
    else {
      this.subscribers.add(subscription);
      options.signal?.addEventListener('abort', cancelSubscription, { once: true });
    }
    return {
      /** Host for-await requests reuse the reader already claimed by subscribe; no second queue ownership is acquired. */
      [Symbol.asyncIterator]() { return this; },
      /** Host reads await private queue delivery/terminal settlement; detach membership/listener on completion or failure and propagate the original read rejection. Cancellation skips retained data. */
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
      /** Host early exit cancels only this observer and completes blocked reads without stopping the shared producer. */
      async return() {
        cancelSubscription();
        return { done: true, value: undefined };
      },
      /** Host iterator failure cancels this observer before rejecting with the supplied cause. */
      async throw(cause) {
        cancelSubscription();
        throw cause;
      },
    };
  }

  /**
   * Session.publish sends session events here; Session.retainEvent sends execution events here before
   * ending terminal streams. Clone into each accepting subscription synchronously; isolate
   * filter/clone/overflow failures by ending only that subscriber; its buffered events drain before
   * reads reject with a truthy original cause (falsy causes complete the queue). Siblings continue receiving independent clones. Ignore
   * publication after hub end; Session still owns native execution and event ordering.
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
   * failure and remove their listeners; queued events drain before terminal read. Later subscribers
   * observe the stored termination without replay. Consumers still own returning/exhausting readers;
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
}
