// Defines host configuration and submission inputs; must not dispatch native work or retain session state.
import type { AhpRequestMap, InteractionRequested, InteractionResponse, SessionBinding } from '@anureo/protocol';
import type { HarnessAdapter, RuntimeOptions } from './ports';
import type { Input } from './types';

/**
 * Hosts register these callbacks in ClientOptions.interactions; Client.initialize advertises own
 * keys, including undefined values for manual responses. Session.requestInteraction schedules a
 * supplied handler through startInteractionHandler after publishing interaction/requested.
 * Resolve a matching answer for native delivery; rejection triggers cancellation while actionable.
 * Observe the signal to stop host-owned work after settlement/teardown: late answers are ignored,
 * but handler capacity stays occupied until the host promise settles. The SDK owns native settlement.
 */
export type InteractionHandlers = {
  [K in InteractionRequested['kind']]?: (
    request: Extract<InteractionRequested, { kind: K }>,
    context: { signal: AbortSignal },
  ) => Promise<Extract<InteractionResponse, { kind: K }>>;
};
/**
 * Hosts pass these options to Client/createClient, transferring adapter cleanup to the client.
 * Construction checks identity, interaction registrations and retention limits before native setup;
 * session/runtime consumers apply their own budgets later. Hosts still own callback side effects
 * and must await Client.dispose after successful construction/use.
 */
export interface ClientOptions {
  /** Client-owned native integration, initialized before opens and disposed after owned sessions. */
  adapter: HarnessAdapter;
  /** Nonblank adapter/configuration IDs checked by Client.validateOpen; excludes individual session identity. */
  identity: Pick<SessionBinding, 'adapterId' | 'runtimeConfigId'>;
  /** Host hooks and resource budgets used by this client and each opened session. */
  runtime?: RuntimeOptions;
  /** An own key with undefined advertises native interactions without an automatic host handler. */
  interactions?: InteractionHandlers;
  /** Positive safe-integer retention budgets; capacity checks reject rather than evict unresolved work. */
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
/**
 * Hosts pass input and per-submission policy to Session.submit, which normalizes/clones input and
 * validates advertised capabilities before dispatch. Its promise returns a Turn on native association,
 * independently of receipt or terminal timing. Invalid policy and wait failures reject; dispatch
 * failure rejects association only if it has not already resolved. OutputSession handles final-schema
 * validation; callers use Turn.result to observe that outcome.
 */
export interface SubmitOptions {
  input: Input;
  /** Native delivery policy; omitted uses native delivery rather than SDK queueing. */
  delivery?: AhpRequestMap['input/submit']['delivery'];
  /** Per-turn overrides checked against advertised capability keys. */
  overrides?: AhpRequestMap['input/submit']['overrides'];
  /** Final JSON contract enforced by OutputSession using native output or fallback, including revalidation after privacy projection. */
  outputSchema?: AhpRequestMap['input/submit']['outputSchema'];
}
