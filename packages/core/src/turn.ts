// Provides independent observation handles for Session-owned executions.
import type { AhpEvent } from '@anureo/protocol';
import { HarnessSdkError } from './errors';
import type { ExecutionObservation } from './lifecycle/execution-observation';
import { waitForRequest } from './request';
import type { EventSubscriptionOptions, Input, RequestOptions, TurnResult } from './types';

/** Internal Session-to-Turn port exposed here for constructor typing. */
export type { ExecutionObservation } from './lifecycle/execution-observation';

/**
 * Observe one execution's live events and retained terminal result, and explicitly steer or interrupt it.
 * Get a handle from Session.submit or Session.review once the input or review is associated with
 * an execution. Use observe to create an independently disposable sibling.
 */
export class Turn {
  /**
   * Internal construction from the shared execution port. Session.submitExecution calls this when
   * association resolves, and Turn.observe calls it to create a sibling with its own cancellation.
   * The shared execution may already be terminal.
   */
  constructor(private readonly execution: ExecutionObservation) {}
  /** The stable execution ID shared by sibling handles, available after disposal. */
  get id(): string { return this.execution.id; }
  /**
   * Subscribe immediately to future events for this execution without replay. Invalid queue limits
   * throw INVALID_PARAMS synchronously. Buffered events drain before overflow or stream failure
   * rejects reads. Exhaust or return the iterator to release it. While the subscription is live,
   * abort or disposal completes pending reads and skips buffered events. An already ended stream's
   * completion or failure is still observable, including when subscribing through a disposed handle.
   */
  events(options: EventSubscriptionOptions = {}): AsyncIterable<AhpEvent> {
    return this.execution.events.subscribe({ ...options, signal: this.observationSignal(options.signal) });
  }
  /**
   * Await the shared frozen terminal snapshot, including failed or interrupted status values.
   * Reject with TURN_DISPOSED when called after disposal, or propagate observation closure and wait
   * failures. Caller abort and the deadline (30 seconds by default) affect only this wait.
   * Disposing the handle rejects its pending result waits with REQUEST_ABORTED.
   */
  result(wait: RequestOptions = {}): Promise<TurnResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('TURN_DISPOSED'));
    return waitForRequest(() => this.execution.result, { ...wait, signal: this.observationSignal(wait.signal) });
  }
  /**
   * Append text or input blocks to this exact execution. Requires atomic turn matching support.
   * Resolve after the native control receipt is validated. Use result to await execution completion.
   * Normalization, admission, dispatch and wait failures reject. Omit the timeout to use the
   * session's request deadline (30 seconds by default). A disposed handle throws TURN_DISPOSED
   * synchronously. Wait cancellation leaves admitted work alive. Disposal leaves an already invoked
   * control wait active.
   */
  steer(options: { input: Input }, wait?: RequestOptions): Promise<void> {
    this.assertOpen();
    return this.execution.steer(options.input, wait);
  }
  /**
   * Request interruption of this execution. Requires adapter support for turn interruption.
   * Resolve after the native control receipt is validated. Use result to await terminal status.
   * Admission, dispatch and wait failures reject. Omit the timeout to use the session's request
   * deadline (30 seconds by default). A disposed handle throws TURN_DISPOSED synchronously. Wait
   * cancellation leaves admitted work alive. Disposal leaves an already invoked control wait active.
   */
  interrupt(wait?: RequestOptions): Promise<void> {
    this.assertOpen();
    return this.execution.interrupt(wait);
  }
  /**
   * Create an independently disposable handle for the same execution, including a retained terminal
   * result when available. Throws TURN_DISPOSED synchronously if this handle is closed.
   */
  observe(): Turn {
    this.assertOpen();
    return new Turn(this.execution);
  }
  /**
   * Idempotently cancel this handle's live subscriptions and pending result waits before resolving.
   * Sibling handles and explicit control waits retain their own lifetimes. Call interrupt to request
   * native interruption while the handle is open.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.observationController.abort();
  }

  private disposed = false;
  private readonly observationController = new AbortController();
  /**
   * events and result combine caller cancellation with this handle's disposal signal, so either can
   * end a local observation without affecting siblings. Explicit control methods do not use it.
   */
  private observationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.observationController.signal]) : this.observationController.signal;
  }
  /** steer, interrupt and observe throw TURN_DISPOSED here before invoking a port or creating a sibling. */
  private assertOpen(): void {
    if (this.disposed) throw new HarnessSdkError('TURN_DISPOSED');
  }
}
