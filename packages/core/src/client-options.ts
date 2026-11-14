import type { AhpRequestMap, InteractionRequested, InteractionResponse, SessionBinding } from '@anureo/protocol';
import type { HarnessAdapter, RuntimeOptions } from './ports';
import type { Input } from './types';

/**
 * Register automatic interaction handlers in ClientOptions.interactions. An enumerable own key
 * with value undefined advertises manual handling through interaction/requested events and
 * Session.request('interaction/respond', ...). Omit a kind to leave it unsupported.
 *
 * Session.requestInteraction publishes interaction/requested before scheduling a handler with a
 * detached native request, including any private fields needed to answer it. Resolve an answer
 * matching the request kind for native delivery. Rejection triggers cancellation while actionable.
 * Stop host work when the signal aborts on settlement or teardown. The SDK ignores late answers
 * and holds the handler slot until the handler's promise settles.
 */
export type InteractionHandlers = {
  [K in InteractionRequested['kind']]?: (
    request: Extract<InteractionRequested, { kind: K }>,
    context: { signal: AbortSignal },
  ) => Promise<Extract<InteractionResponse, { kind: K }>>;
};
/**
 * Configure an SDK client and transfer adapter cleanup to it when construction succeeds.
 * Client validates identity, interaction registrations and retention limits before native setup.
 * Await Client.dispose to release owned resources. Host callbacks retain responsibility for their
 * own effects and cleanup.
 */
export interface ClientOptions {
  /** Client-owned native integration, initialized before opens and disposed after owned sessions. */
  adapter: HarnessAdapter;
  /** Nonblank adapter and runtime configuration IDs that every session binding must match. */
  identity: Pick<SessionBinding, 'adapterId' | 'runtimeConfigId'>;
  /** Host hooks and resource budgets used by this client and each opened session. */
  runtime?: RuntimeOptions;
  /** Interaction kinds and automatic handlers to advertise during initialization. */
  interactions?: InteractionHandlers;
  /** Positive safe-integer retention budgets; capacity checks reject rather than evict unresolved work. */
  limits?: {
    /** Maximum tracked executions per session, including active executions and pinned results. Defaults to 128. */
    maxExecutions?: number;
    /** Maximum retained submission/association records per session; defaults to 1024. */
    maxSubmissions?: number;
    /**
     * Budget for retained execution item snapshots in serialized UTF-8 bytes. Defaults to 16 MiB.
     * Applies within each execution and across the session. Structured output uses a separate
     * retention budget of the same size.
     */
    maxResultBytes?: number;
    /** Maximum distinct retained items per execution; defaults to 2048. */
    maxItems?: number;
  };
}
/**
 * Supply input and per-submission policy to Session.submit. It validates the request before dispatch
 * and resolves with a Turn when it observes the native execution association, which can precede
 * the receipt or follow completion. Invalid input, unsupported policy and wait failures reject.
 * Dispatch failure can reject an unresolved association. Use Turn.result for the terminal outcome,
 * including structured-output validation, and dispose the Turn to release its local observations.
 */
export interface SubmitOptions {
  /** Text or protocol blocks to detach and validate before native dispatch. */
  input: Input;
  /** Capability-gated delivery policy. Omission selects 'native', which can queue input or join an existing execution. */
  delivery?: AhpRequestMap['input/submit']['delivery'];
  /** Per-turn overrides checked against advertised capability keys. */
  overrides?: AhpRequestMap['input/submit']['overrides'];
  /** Require valid JSON matching this schema in the final result. Requires session.capabilities.turn.outputSchema. */
  outputSchema?: AhpRequestMap['input/submit']['outputSchema'];
}
