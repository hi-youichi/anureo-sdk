import type { HarnessError, InputBlock, Item, Usage } from '@anureo/protocol';
/**
 * Send text or protocol blocks through Session.submit or Turn.steer. Text becomes one text block
 * and block arrays are cloned. Invalid input rejects before native dispatch.
 */
export type Input = string | readonly InputBlock[];
/**
 * Read the frozen terminal snapshot returned by Turn.result. Failed and interrupted executions
 * resolve with those statuses. Closing observation before the terminal or ending the caller's wait
 * rejects the promise. Request history/read separately for native history when supported.
 */
export type TurnResult = {
  /** Text of final-phase agent messages in retained item order, separated by newlines. */
  text: string;
  /** Privacy-projected snapshots retained for this execution, including non-message items. */
  items: readonly Item[];
  /** Terminal turn-scoped usage, or the latest observed turn-scoped usage when the terminal has none. */
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
 * Bound one caller's wait for a Client, Session or Turn operation. Abort or timeout after dispatch
 * rejects the waiter with outcomeUnknown while native work can continue. Use an explicit interrupt
 * operation to request that execution stop.
 */
export interface RequestOptions {
  /** Stops this caller waiting; does not interrupt accepted native execution. */
  signal?: AbortSignal;
  /**
   * Positive finite observation deadline in milliseconds; omission uses the operation default.
   * Client/Session admission also rejects values above 2_147_483_647; standalone waits use host timers.
   */
  timeoutMs?: number;
}

/**
 * Configure an independent queue for Session.events or Turn.events. Invalid budgets throw at
 * subscription. Overflow rejects that observer's reads after buffered events drain, without
 * pausing the native producer. Exhaust or return the iterator, or abort this subscription.
 */
export interface EventSubscriptionOptions {
  /** Aborts only this observer, releasing its pending read and membership. */
  signal?: AbortSignal;
  /** Independent observer budgets, each a positive safe integer; omission selects hub defaults. */
  queue?: {
    /** Maximum buffered regular events; defaults to 2048. Direct delivery to a pending read needs no slot. */
    maxEvents?: number;
    /**
     * Maximum serialized bytes buffered for this observer; defaults to 16 MiB.
     * Single events are also limited to the smaller of this budget and 8 MiB.
     */
    maxBytes?: number;
  };
}
