import type { AhpEvent } from '@anureo/protocol';
import { HarnessSdkError, waitForRequest, type RequestOptions } from '../errors';
import { EventHub, type EventSubscriptionOptions } from './events';
import type { Input, TurnResult } from './types';

export interface ExecutionObservation {
  readonly id: string;
  readonly events: EventHub<AhpEvent>;
  readonly result: Promise<TurnResult>;
  readonly terminal: boolean;
  steer(input: Input, wait?: RequestOptions): Promise<void>;
  interrupt(wait?: RequestOptions): Promise<void>;
}
/** One observer of a stable native execution. Disposal never interrupts execution. */
export class Turn {
  private disposed = false;
  private readonly controller = new AbortController();
  constructor(private readonly execution: ExecutionObservation) {}
  get id(): string { return this.execution.id; }
  events(options: EventSubscriptionOptions = {}): AsyncIterable<AhpEvent> {
    return this.execution.events.subscribe({ ...options, signal: options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal });
  }
  result(wait: RequestOptions = {}): Promise<TurnResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError('TURN_DISPOSED'));
    return waitForRequest(() => this.execution.result, { ...wait, signal: wait.signal ? AbortSignal.any([wait.signal, this.controller.signal]) : this.controller.signal });
  }
  steer(options: { input: Input }, wait?: RequestOptions): Promise<void> { this.assertOpen(); return this.execution.steer(options.input, wait); }
  interrupt(wait?: RequestOptions): Promise<void> { this.assertOpen(); return this.execution.interrupt(wait); }
  private assertOpen(): void { if (this.disposed) throw new HarnessSdkError('TURN_DISPOSED'); }
  observe(): Turn { this.assertOpen(); return new Turn(this.execution); }
  async dispose(): Promise<void> { this.disposed = true; this.controller.abort(); }
}

