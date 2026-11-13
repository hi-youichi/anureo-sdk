// Defines host client configuration and submission policy; must not dispatch requests or own session state.
import type { AhpRequestMap, InteractionRequested, InteractionResponse, SessionBinding } from '@anureo/protocol';
import type { HarnessAdapter, RuntimeOptions } from './ports';
import type { Input } from './lifecycle/types';

/** Host callbacks invoked for advertised native requests; resolve a matching response or reject to request cancellation. Observe the signal to release host work on expiry/teardown; native settlement remains runtime-owned. */
export type InteractionHandlers = { [K in InteractionRequested['kind']]?: (request: Extract<InteractionRequested, { kind: K }>, context: { signal: AbortSignal }) => Promise<Extract<InteractionResponse, { kind: K }>> };
/** Host configuration for Client/createClient; transfers adapter lifecycle ownership to the client while runtime callbacks retain host-owned side effects. Construction validates identity, handlers and retention limits. */
export interface ClientOptions {
  /** Client-owned native integration, initialized before opens and disposed after owned sessions. */
  adapter: HarnessAdapter;
  /** Stable adapter/configuration identity for binding validation and workflow cache keys. */
  identity: Pick<SessionBinding, 'adapterId' | 'runtimeConfigId'>;
  /** Host hooks and resource budgets used by this client and each opened session. */
  runtime?: RuntimeOptions;
  /** An own key with undefined advertises native interactions without an automatic host handler. */
  interactions?: InteractionHandlers;
  /** Positive safe-integer session retention budgets; unresolved work is never evicted to admit more. */
  limits?: {
    /** Maximum retained execution snapshots, including pinned terminal executions. */
    maxExecutions?: number;
    /** Maximum retained submission/association records. */
    maxSubmissions?: number;
    /** Shared retained execution-result budget in serialized UTF-8 bytes. */
    maxResultBytes?: number;
    /** Maximum distinct retained items per execution. */
    maxItems?: number;
  };
}
/** Host policy passed to Session.submit; input is cloned and advertised delivery/schema capabilities are checked before dispatch. Submission rejects invalid/unsupported policy and native or wait failures. */
export interface SubmitOptions {
  input: Input;
  /** Native delivery policy; omitted uses native delivery rather than SDK queueing. */
  delivery?: AhpRequestMap['input/submit']['delivery'];
  /** Per-turn overrides checked against advertised capability keys. */
  overrides?: AhpRequestMap['input/submit']['overrides'];
  /** When supplied, requires a final JSON contract; native or adapter fallback validates after privacy projection. */
  outputSchema?: AhpRequestMap['input/submit']['outputSchema'];
}
