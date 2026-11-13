// Defines native adapter ports and host runtime hooks; must not implement transport, dispatch or lifecycle behavior.
import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap, Capabilities, HarnessError, InitializeParams, InitializeResult, InteractionRequested, InteractionResponse, JsonSchema, SessionBinding, SessionOpenParams } from '@anureo/protocol';
import type { QueueLimits } from './queue';
/**
 * Adapter callback invoked by the runtime to deliver a response to the native peer.
 * null requests cancellation (for example, on expiry or teardown); reason explains why.
 * Resolve after native response/cancellation work completes; reject its failure so the runtime
 * can report an unknown outcome rather than retrying a potentially accepted response.
 */
export type NativeInteractionResponder = (response: InteractionResponse | null, reason?: string) => Promise<void>;
/** Requests routed through an already opened backend; initialize/open are owned by the client adapter lifecycle. */
export type SessionMethod = Exclude<AhpMethod, 'initialize' | 'session/open'>;
/** Execution/item context attached by an adapter; conflicting payload identities are protocol failures. */
export interface EventScope {
  /** Native execution identity when the event payload omits it. */
  turnId?: string;
  /** Envelope item identity; must agree with any identity carried by an item payload. */
  itemId?: string;
}
/** Runtime callback port supplied during native open; adapters await emit for publication ordering and report irreversible observation failures through fail. */
export interface SessionEventSink {
  /** Return privacy-projected text before structured final validation; called by output adapters without changing the candidate. */
  projectOutput?(text: string): string;
  /** Associate an accepted submission with its native execution through ordered publication; reject invalid/conflicting association. */
  bindSubmission(submissionId: string, turnId: string): Promise<void>;
  /** Admit and publish a detached native event in order; reject protocol, lifecycle or capacity failures. */
  emit(event: AhpEventPayload, scope?: EventScope): Promise<void>;
  /** Attempt event admission for producers that cannot await; false signals failure and accepted asynchronous errors still fail observation. */
  tryEmit(event: AhpEventPayload, scope?: EventScope): boolean;
  /**
   * Registers and publishes an adapter's native request; the runtime calls responder.
   * On success, resolves with the response after responder completes and the result is published.
   * Cancellation, expiry and response failures use rejection, never a null response.
   */
  requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse>;
  /**
   * Adapter reports a result already settled by the native peer; responder is not called.
   * For an unresolved request, publishes the result, then rejects its requestInteraction Promise
   * even when outcome is responded, since no response value is available. Unknown or resolved IDs are ignored.
   */
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void>;
  /** Report an adapter failure, end runtime observation and await attempted session cleanup; native execution stop remains unconfirmed. */
  fail(cause: unknown): Promise<void>;
}
/** Resolved candidate decision for native tool callbacks; accepted:false carries safe retry/terminal policy. Infrastructure failures may still reject execute's Promise. */
export type StructuredOutputToolResult = { accepted: true } | { accepted: false; error: HarnessError };
/** Output tool supplied by the runtime to a native adapter for one submission; execute remains bound to that submission after replacement, preventing late calls from satisfying a newer input. */
export interface StructuredOutputToolDefinition {
  name: string;
  description: string;
  /** Candidate schema; native tool presentation must preserve its validation constraints. */
  schema: JsonSchema;
  /** Validate/retain one JSON candidate for this submission; resolve acceptance or safe rejection, with infrastructure failures allowed to reject. */
  execute(value: unknown): Promise<StructuredOutputToolResult>;
}
/** Optional native tool registration owned by the session; configure completion gates admission of the next input. */
export interface StructuredOutputToolPort {
  /** Runtime replaces the session's output tool, or disables it with undefined; resolve after registration completes, reject setup failure before admitting the next input. */
  configure(tool?: StructuredOutputToolDefinition): Promise<void>;
}
/** Native session resources owned by Session; execute settles native requests while events may arrive independently of receipts. */
export interface BackendSession {
  /** Present only when the native execution location can expose a session-scoped output tool. */
  readonly structuredOutputTool?: StructuredOutputToolPort;
  /** Authoritative native snapshot available at attachment, including resumed active executions. */
  readonly state?: import('@anureo/protocol').SessionState;
  /** Must match the requested session/client identity; attachment adopts any authoritative nativeRef. */
  readonly binding: SessionBinding;
  /** Authoritative session capabilities, which may differ from initialization capabilities. */
  readonly capabilities: Capabilities;
  /** Execute one already validated native request without SDK retries; resolve its native result or reject a safe failure indicating unknown outcomes when appropriate. */
  execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]>;
  /** Release this session’s native handles idempotently; reject cleanup failure without claiming execution stopped. */
  dispose(): Promise<void>;
}
/** Client-owned adapter lifecycle; initialize before opening sessions and release session resources before adapter disposal. */
export interface HarnessAdapter {
  /** Synchronously select a reachable bridge for these open params, or return undefined to disable fallback; opt in only when session-scoped MCP configuration is supported. */
  outputBridgeTransport?(params: SessionOpenParams): 'http' | 'stdio' | undefined;
  /** Negotiate native capabilities/protocol before opens; reject unsupported contracts or native setup failure. */
  initialize(params: InitializeParams): Promise<InitializeResult>;
  /** Open a native session bound to params and callbacks; events may precede the returned backend. Reject setup failure and release partially owned resources. */
  openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession>;
  /** Release client-wide adapter resources after owned session cleanup; reject release failure. */
  dispose(): Promise<void>;
}

/** Host runtime hooks and per-resource budgets; hooks may have host-owned side effects but never transfer native execution ownership. */
export interface RuntimeOptions {
  /** Allocate stable nonempty request/submission/stream identities; host must avoid collisions. */
  createId?: () => string;
  /** ISO timestamp source for public event publication; validation uses wall-clock time separately. */
  now?: () => string;
  /** Default caller/native-response observation deadline in milliseconds. */
  requestTimeoutMs?: number;
  /** Caller wait for native open/attachment in milliseconds; late backends are still cleaned up. */
  openTimeoutMs?: number;
  /** Maximum actionable interaction lifetime in milliseconds, further bounded by native expiry. */
  interactionTimeoutMs?: number;
  /** Capacity for unresolved requests and concurrently running automatic handlers. */
  maxPendingInteractions?: number;
  /** Retained idempotency outcomes; unsettled requests are never evicted for capacity. */
  requestCacheSize?: number;
  /** Session event admission and structured-output buffering budgets. */
  queue?: QueueLimits;
  /** Runs synchronously before sending a marked interaction answer; persist only irreversible privacy metadata, and throw to prevent sending if persistence fails. */
  onMarkedSecret?: (binding: Readonly<SessionBinding>, value: string) => void;
  /** Return cross-process privacy projection after SDK history redaction; may perform host I/O and reject the history request if projection fails. */
  redactHistory?: (binding: Readonly<SessionBinding>, page: AhpResultMap["history/read"]) => AhpResultMap["history/read"] | Promise<AhpResultMap["history/read"]>;
}
