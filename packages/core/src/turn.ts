// Provides independent turn observation handles; must not own or implicitly stop native execution.
import type { AhpEvent } from '@anureo/protocol';
import { HarnessSdkError } from './errors';
import { waitForRequest } from './request';
import type { ExecutionObservation } from './lifecycle/execution-observation';

import type { EventSubscriptionOptions, Input, RequestOptions, TurnResult } from './types';

/** Internal Session-to-Turn port; exported here for constructor typing, not as a native execution owner. */
export type { ExecutionObservation } from './lifecycle/execution-observation';

/**
 * Observe one execution's live events and retained terminal result, and explicitly steer or interrupt it.
 * Session.submit and Session.review return a handle when execution association resolves; observe creates
 * independent sibling handles. Disposing a handle releases its observations; Session owns execution.
 */
export class Turn {
  /**
   * Session.submitExecution and Turn.observe supply the shared port for an existing execution, which
   * may already be terminal. Create only local observation state; starting work remains Session's job.
   */
  constructor(private readonly execution: ExecutionObservation) {}
  /** Hosts read the stable execution identity shared by sibling handles, even after local disposal. */
  get id(): string { return this.execution.id; }
  /**
   * Hosts receive a live, isolated subscription without replay. Invalid queue limits throw; overflow
   * or producer failure rejects reads. Caller abort ends this subscription; disposal ends every
   * observation on this handle. Exhaust, return or abort the iterator to release it; sibling handles
   * and native execution remain active.
   */
  events(options: EventSubscriptionOptions = {}): AsyncIterable<AhpEvent> {
    return this.execution.events.subscribe({ ...options, signal: this.observationSignal(options.signal) });
  }
  /**
   * Await the shared frozen terminal snapshot, including failed/interrupted result values. Reject
   * TURN_DISPOSED on a disposed handle, or propagate observation/wait failures. Caller abort and the
   * deadline (30 seconds by default) affect only this wait; disposal ends all this handle's observations.
   * Explicit interrupt remains the caller's responsibility when native execution should stop.
   */
  result(wait: RequestOptions = {}): Promise<TurnResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('TURN_DISPOSED'));
    return waitForRequest(() => this.execution.result, { ...wait, signal: this.observationSignal(wait.signal) });
  }
  /**
   * Hosts explicitly submit input to this execution through Session.context's steer callback. Await
   * the control receipt, not execution completion; admission/dispatch/wait failures reject. Throw
   * TURN_DISPOSED synchronously after local disposal. Wait cancellation leaves admitted work alive,
   * and disposing this handle does not cancel a control already invoked.
   */
  steer(options: { input: Input }, wait?: RequestOptions): Promise<void> {
    this.assertOpen();
    return this.execution.steer(options.input, wait);
  }
  /**
   * Hosts explicitly request interruption through Session.context's callback. Await the native control
   * receipt; Turn.result still waits for a terminal event. Throw TURN_DISPOSED synchronously after
   * disposal, otherwise propagate control/wait rejection. Local disposal never invokes this control
   * or cancels an already-invoked control wait.
   */
  interrupt(wait?: RequestOptions): Promise<void> {
    this.assertOpen();
    return this.execution.interrupt(wait);
  }
  /**
   * Hosts create another independently disposable handle over the shared result and live event hub.
   * Throw TURN_DISPOSED if this handle is closed; creating a sibling neither starts nor replays work.
   */
  observe(): Turn {
    this.assertOpen();
    return new Turn(this.execution);
  }
  /**
   * Hosts await this idempotent local release: abort subscriptions and result waits before resolving.
   * Leave sibling handles, explicit control waits and Session-owned execution state untouched.
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
