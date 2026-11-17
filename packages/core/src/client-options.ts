// Defines host client configuration and submission policy; must not dispatch requests or own session state.
import type { AhpRequestMap, InputBlock, InteractionRequested, InteractionResponse, JsonValue, SessionBinding } from '@anureo/protocol';
import type { HarnessAdapter, RuntimeOptions } from './ports';
import type { Input } from './types';

/** Host callbacks invoked for advertised native requests; resolve a matching response or reject to request cancellation. Observe the signal to release host work on expiry/teardown; native settlement remains runtime-owned. */
export type InteractionHandlers = { [K in InteractionRequested['kind']]?: (request: Extract<InteractionRequested, { kind: K }>, context: { signal: AbortSignal }) => Promise<Extract<InteractionResponse, { kind: K }>> };
/** Detached host input snapshot. Its identities, delivery and steer target are preserved across transformations. */
export type BeforeInputEvent = {
  readonly sessionId: string;
  readonly requestId: string;
  readonly submissionId: string;
  readonly input: readonly InputBlock[];
} & (
  | { readonly method: 'input/submit'; readonly delivery: AhpRequestMap['input/submit']['delivery'] }
  | { readonly method: 'turn/steer'; readonly expectedTurnId: string }
);

/** Replace the input blocks or return undefined to keep them. Runs before policy validation. */
export type InputTransformHook = (event: BeforeInputEvent, context: { signal: AbortSignal }) =>
  readonly InputBlock[] | undefined | Promise<readonly InputBlock[] | undefined>;
export type BeforeInputDecision = { action: 'deny' };
/** Return undefined to continue or deny the final transformed input. */
export type BeforeInputHook = (event: BeforeInputEvent, context: { signal: AbortSignal }) =>
  void | BeforeInputDecision | Promise<void | BeforeInputDecision>;

export interface BeforeToolEvent {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: JsonValue;
}
export type BeforeToolHook = (event: BeforeToolEvent, context: { signal: AbortSignal }) =>
  void | { action: 'deny' } | Promise<void | { action: 'deny' }>;
export interface BeforeToolPolicy {
  /** Exact native tool names. The adapter must support pre-tool callbacks for the entire list. */
  toolNames: readonly string[];
  handle: BeforeToolHook;
}
export interface BeforeStopEvent {
  readonly sessionId: string;
  readonly turnId: string;
  readonly lastAssistantMessage?: string;
}
export type BeforeStopHook = (event: BeforeStopEvent, context: { signal: AbortSignal }) =>
  void | { action: 'continue'; prompt: string } | Promise<void | { action: 'continue'; prompt: string }>;

export interface ClientHooks {
  /** Application-defined version of the configured hook policy, checked on workflow resume. */
  inputRevision: string;
  /** Input queue/chain budget and per-native-callback budget in milliseconds. Defaults to 5000. */
  timeoutMs?: number;
  transformInput?: readonly InputTransformHook[];
  beforeInput?: readonly BeforeInputHook[];
  /** Deny selected native tool calls before execution on an adapter that supports them. */
  beforeTool?: BeforeToolPolicy;
  /** Ask for one continuation of an eligible native text turn before it stops. */
  beforeStop?: BeforeStopHook;
}
/** Host configuration for Client/createClient; transfers adapter lifecycle ownership to the client while runtime callbacks retain host-owned side effects. Construction validates identity, handlers and retention limits. */
export interface ClientOptions {
  /** Client-owned native integration, initialized before opens and disposed after owned sessions. */
  adapter: HarnessAdapter;
  /** Stable adapter/configuration identity for binding validation and workflow cache keys. */
  identity: Pick<SessionBinding, 'adapterId' | 'runtimeConfigId'>;
  /** Host hooks and resource budgets used by this client and each opened session. */
  runtime?: RuntimeOptions;
  /** Ordered input transformations and validation shared by every session on this client. */
  hooks?: ClientHooks;
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
