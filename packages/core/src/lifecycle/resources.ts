// Provides independent turn observation handles; must not own or implicitly stop native execution.
import type { AhpEvent } from '@anureo/protocol';
import { HarnessSdkError } from '../sdk-error';
import { waitForRequest, type RequestOptions } from '../request';
import { EventHub, type EventSubscriptionOptions } from './events';
import type { Input, TurnResult } from './types';

/** Runtime-owned execution port shared by independent Turn handles; result/terminal represent native execution while handles own only observation. */
export interface ExecutionObservation {
  readonly id: string;
  /** Shared producer hub; each Turn creates its own isolated subscription. */
  readonly events: EventHub<AhpEvent>;
  /** Shared native terminal result; local disposal/deadline affects only each observer. */
  readonly result: Promise<TurnResult>;
  /** True only once a native terminal event has been observed. */
  readonly terminal: boolean;
  /** Explicitly steer this execution; propagate native dispatch or caller wait failure. */
  steer(input: Input, wait?: RequestOptions): Promise<void>;
  /** Explicitly interrupt this execution; observation cleanup never calls it implicitly. */
  interrupt(wait?: RequestOptions): Promise<void>;
}
/** One observer of a stable native execution. Disposal never interrupts execution. */
export class Turn {
  private disposed = false;
  private readonly observationController = new AbortController();
  /** Create an independent local observer of an existing execution; no native work starts and the execution may already be terminal. */
  constructor(private readonly execution: ExecutionObservation) {}
  /** Return the stable native-execution observation identity shared by sibling handles. */
  get id(): string { return this.execution.id; }
  /** Create an isolated event observer cancelled by either the caller signal or this handle’s disposal; subscription errors propagate without stopping execution. */
  events(options: EventSubscriptionOptions = {}): AsyncIterable<AhpEvent> {
    return this.execution.events.subscribe({ ...options, signal: this.observationSignal(options.signal) });
  }
  /** Wait for the shared terminal snapshot with local abort/deadline; reject disposed handles or observation failures without cancelling native execution. */
  result(wait: RequestOptions = {}): Promise<TurnResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('TURN_DISPOSED'));
    return waitForRequest(() => this.execution.result, { ...wait, signal: this.observationSignal(wait.signal) });
  }
  /** Explicitly steer this execution; throw TURN_DISPOSED locally or propagate native dispatch/wait rejection. */
  steer(options: { input: Input }, wait?: RequestOptions): Promise<void> { this.assertOpen(); return this.execution.steer(options.input, wait); }
  /** Explicitly interrupt this execution; throw TURN_DISPOSED locally or propagate native/wait rejection. */
  interrupt(wait?: RequestOptions): Promise<void> { this.assertOpen(); return this.execution.interrupt(wait); }
  /** Combine caller cancellation with handle disposal so either ends local waits while sibling observers remain usable. */
  private observationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.observationController.signal]) : this.observationController.signal;
  }
  /** Reject handle operations after disposal before invoking native control ports. */
  private assertOpen(): void { if (this.disposed) throw new HarnessSdkError('TURN_DISPOSED'); }
  /** Create another independent observer or throw TURN_DISPOSED; disposing either handle does not dispose its sibling. */
  observe(): Turn { this.assertOpen(); return new Turn(this.execution); }
  /** Idempotently abort this handle’s subscriptions/waits; never call the native interrupt or dispose shared execution state. */
  async dispose(): Promise<void> { this.disposed = true; this.observationController.abort(); }
}

