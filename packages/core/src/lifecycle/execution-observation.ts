// Defines the Session-to-Turn observation port; must not dispatch requests or own execution resources.
import type { AhpEvent } from '@anureo/protocol';
import type { EventHub } from './events';
import type { Input, RequestOptions, TurnResult } from '../types';

/**
 * Internal contract supplied by Session.context and passed to Turn by Session.submitExecution.
 * Session.retainEvent publishes events and resolves completion; Session.endObservation rejects
 * unfinished observations on closure. Turn reads the shared port while owning only local cancellation.
 * Implementations retain native execution, ordering and resource-release responsibilities.
 */
export interface ExecutionObservation {
  /** Stable native execution identity, shared across submissions that associate with the same turn. */
  readonly id: string;
  /** Session-owned live producer hub; Turn.events creates an isolated subscription without replay. */
  readonly events: EventHub<AhpEvent>;
  /** Terminal snapshot or observation failure shared by all handles; local waits cannot settle it. */
  readonly result: Promise<TurnResult>;
  /** Native completion marker maintained by Session.retainEvent; observation closure alone leaves it false. */
  readonly terminal: boolean;
  /**
   * Turn.steer explicitly invokes the callback installed by Session.context. It normalizes input and
   * awaits Session.request('turn/steer') for this execution, discarding the receipt on success and
   * propagating admission/dispatch/wait rejection. Caller cancellation does not cancel admitted work.
   */
  steer(input: Input, wait?: RequestOptions): Promise<void>;
  /**
   * Turn.interrupt explicitly invokes the callback installed by Session.context. It awaits
   * Session.request('turn/interrupt'), discarding the receipt or propagating rejection; terminal events
   * still settle result. Observation cleanup never invokes this control implicitly.
   */
  interrupt(wait?: RequestOptions): Promise<void>;
}
