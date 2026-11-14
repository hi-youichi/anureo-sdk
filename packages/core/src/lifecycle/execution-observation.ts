import type { AhpEvent } from '@anureo/protocol';
import type { EventHub } from './events';
import type { Input, RequestOptions, TurnResult } from '../types';

/**
 * Internal port allocated by Session.context and passed to Turn by Session.submitExecution when
 * association resolves. Turn uses it for live subscriptions, terminal results and explicit controls.
 * Session owns event ordering, shared settlement and native resources. Each Turn owns its wait
 * and subscription cancellation.
 */
export interface ExecutionObservation {
  /** Stable execution ID reported by the adapter and shared by submissions bound to the same turn. */
  readonly id: string;
  /** Session-owned live producer hub; Turn.events creates an isolated subscription without replay. */
  readonly events: EventHub<AhpEvent>;
  /** Session.retainEvent resolves the frozen snapshot at native completion. Session.endObservation rejects unfinished results on closure. */
  readonly result: Promise<TurnResult>;
  /** Session.retainEvent sets this on turn/completed before publishing the terminal event and ending its stream. */
  readonly terminal: boolean;
  /**
   * Turn.steer explicitly invokes the callback installed by Session.context. It normalizes input and
   * awaits Session.request('turn/steer') with this execution as the atomic target. It discards the
   * validated receipt and propagates normalization, admission, dispatch and wait rejections. Native
   * work continues if the caller ends its wait after admission.
   */
  steer(input: Input, wait?: RequestOptions): Promise<void>;
  /**
   * Turn.interrupt explicitly invokes the callback installed by Session.context. It awaits
   * Session.request('turn/interrupt') for this execution, discarding the validated receipt or
   * propagating admission, dispatch and wait rejections. Session.retainEvent settles result
   * separately when the terminal event arrives.
   */
  interrupt(wait?: RequestOptions): Promise<void>;
}
