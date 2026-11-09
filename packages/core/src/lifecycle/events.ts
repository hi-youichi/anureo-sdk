import { BoundedEventQueue } from '../queue';

export interface EventSubscriptionOptions {
  signal?: AbortSignal;
  queue?: { maxEvents?: number; maxBytes?: number };
}

type Subscription<T> = {
  queue: BoundedEventQueue<T>;
  accepts: (value: T) => boolean;
  detach: () => void;
};

/** A single producer with isolated, bounded subscriptions. It never backpressures a wire reader. */
export class EventHub<T> {
  private readonly subscribers = new Set<Subscription<T>>();
  private ended = false;
  private failure?: unknown;

  subscribe(options: EventSubscriptionOptions = {}, accepts: (value: T) => boolean = () => true): AsyncIterableIterator<T> {
    const maxBytes = options.queue?.maxBytes ?? 16 * 1024 * 1024;
    const queue = new BoundedEventQueue<T>({ ...options.queue, maxBytes, maxFrameBytes: Math.min(maxBytes, 8 * 1024 * 1024) });
    const reader = queue[Symbol.asyncIterator]();
    let cancelled = false;
    const detach = () => {
      this.subscribers.delete(subscription);
      options.signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cancelled = true;
      detach();
      queue.end();
      void reader.return?.();
    };
    const subscription: Subscription<T> = { queue, accepts, detach };
    if (this.ended) queue.end(this.failure);
    else if (options.signal?.aborted) abort();
    else {
      this.subscribers.add(subscription);
      options.signal?.addEventListener('abort', abort, { once: true });
    }
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (cancelled) return { done: true, value: undefined };
        try {
          const result = await reader.next();
          if (result.done) detach();
          return result;
        } catch (cause) { detach(); queue.end(cause); throw cause; }
      },
      async return() { abort(); return { done: true, value: undefined }; },
      async throw(cause) { abort(); throw cause; },
    };
  }

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
