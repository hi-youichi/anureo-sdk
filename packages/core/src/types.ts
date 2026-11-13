// Defines host input and observation values; must not normalize input, dispatch requests or own resources.
import type { HarnessError, InputBlock, Item, Usage } from '@anureo/protocol';
/**
 * Hosts supply text or protocol blocks to Session.submit and Turn.steer. Session.submit and the
 * steer callback installed by Session.context pass this to inputBlocks before request validation;
 * strings become one text block and arrays are detached by cloning. Invalid input fails before dispatch.
 */
export type Input = string | readonly InputBlock[];
/**
 * ResultAccumulator.finish builds this frozen terminal snapshot; Session.retainEvent resolves the
 * shared execution promise read by Turn.result. Native failed/interrupted terminals resolve values
 * with those statuses; observation closure or a caller timeout rejects Turn.result instead. This is
 * retained observation, so hosts needing authoritative history must request history/read separately.
 */
export type TurnResult = {
  /** Final agent-message text joined in retained item order, separated by newlines. */
  text: string;
  /** Privacy-projected snapshots retained for this execution, including non-message items. */
  items: readonly Item[];
  /** Terminal turn usage, or the latest observed turn-scoped usage when the terminal omits it. */
  usage?: Usage;
} & (
  { status: 'completed' }
  | {
    status: 'interrupted';
    /** Safe native interruption details when supplied by the terminal event. */
    error?: HarnessError;
  }
  | {
    status: 'failed';
    /** Safe terminal failure, with TURN_FAILED supplied when native details are absent. */
    error: HarnessError;
  }
);

/**
 * Hosts pass these options to Client/Session operations and Turn.result or controls; waitForRequest
 * rejects that caller on abort/deadline while continuing to observe dispatched work. A pre-aborted
 * wait prevents dispatch where checked; cancellation never implicitly interrupts native execution.
 */
export interface RequestOptions {
  /** Stops this caller waiting; does not interrupt accepted native execution. */
  signal?: AbortSignal;
  /** Positive finite observation deadline in milliseconds; omission uses the operation default. */
  timeoutMs?: number;
}

/**
 * Hosts pass these to Session.events or Turn.events; EventHub.subscribe allocates a private bounded
 * queue. Invalid budgets throw and overflow rejects that observer's reads without pausing the native
 * producer. Consumers must finish/return the iterator or abort to release subscription membership.
 */
export interface EventSubscriptionOptions {
  /** Aborts only this observer, releasing its pending read and membership. */
  signal?: AbortSignal;
  /** Independent observer budgets, each a positive safe integer; omission selects hub defaults. */
  queue?: {
    /** Maximum buffered regular events; direct delivery to a pending read needs no slot. */
    maxEvents?: number;
    /** Maximum serialized bytes buffered for this observer. */
    maxBytes?: number;
  };
}
