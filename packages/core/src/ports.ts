import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap, Capabilities, HarnessError, InitializeParams, InitializeResult, InteractionRequested, InteractionResponse, JsonSchema, SessionBinding, SessionOpenParams } from '@anureo/protocol';
import type { QueueLimits } from './queue';
/**
 * Deliver an interaction answer or cancellation to the native peer. Adapters supply this callback to
 * the sink's requestInteraction. InteractionRegistry.deliverResponse invokes it with an answer;
 * cancelPending invokes it with null and a reason on expiry/cancellation/teardown.
 * Session.requestInteraction also calls it directly when rejecting closed, unsupported or handler
 * capacity admission. Resolve once native delivery or cancellation is confirmed by the adapter.
 * Reject delivery failures and mark uncertain outcomes so the SDK can report them without retrying
 * a response that might already have been accepted.
 */
export type NativeInteractionResponder = (response: InteractionResponse | null, reason?: string) => Promise<void>;
/** Session.request and BackendSession.execute use these methods; Client handles initialize/session-open separately through HarnessAdapter. */
export type SessionMethod = Exclude<AhpMethod, 'initialize' | 'session/open'>;
/** Supply the execution and item identities for a native event. IDs in scope and payload must agree. */
export interface EventScope {
  /** Execution identity needed for item/usage events whose payload carries no turn ID. */
  turnId?: string;
  /** Optional item identity; must agree with an item payload's own ID. */
  itemId?: string;
}
/**
 * Publish events and settle interactions through the sink received by HarnessAdapter.openSession.
 * OutputSession.open supplies adapter callbacks that route events through structured-output policy
 * before delivering them to Session. Await publication calls to preserve source order. Report
 * observation failures through fail and release native resources through the adapter's disposal.
 */
export interface SessionEventSink {
  /**
   * Project final JSON synchronously for privacy. Session supplies this hook to
   * OutputSession.publishOutput, which revalidates the returned text against the schema.
   * Projection or validation failure turns the native success into a failed terminal result.
   */
  projectOutput?(text: string): string;
  /**
   * Publish an association between a submission and its native execution. Successful publication
   * can resolve Session.submit before the native receipt. Invalid or conflicting bindings fail
   * publication. PiBackendSession.beginTurn awaits this before processing later turn events.
   */
  bindSubmission(submissionId: string, turnId: string): Promise<void>;
  /**
   * Admit a detached event for ordered processing. Await this call before sending a dependent event.
   * Structured-output policy can hold events until a binding arrives. Admission can throw or reject.
   * Queued processing failures reject and end observation.
   */
  emit(event: AhpEventPayload, scope?: EventScope): Promise<void>;
  /** Attempt event admission without waiting. False reports immediate failure. True allows later processing failure to end observation. */
  tryEmit(event: AhpEventPayload, scope?: EventScope): boolean;
  /**
   * Register a native request and the callback that delivers its answer or cancellation. Session
   * publishes interaction/requested before scheduling a configured host handler. Manual answers
   * arrive through Session.request. Resolve with the answer after delivery and settlement
   * publication. Admission failures, cancellation and expiry reject. If native delivery and
   * publication of its unknown outcome both fail, the pending answer can remain unresolved.
   * Keep native callback resources available through settlement or adapter teardown.
   */
  requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse>;
  /**
   * Report settlement already completed by the native peer. Session publishes the result without
   * invoking the responder and rejects the pending requestInteraction, including for a responded
   * outcome, because there is no answer value. Unknown or resolved IDs are ignored. A publication
   * failure rejects this call.
   */
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void>;
  /**
   * Report observation loss. The first call on an open Session ends observation, cancels pending
   * interactions and attempts backend cleanup. Session suppresses backend disposal rejection.
   * Native execution stop remains unconfirmed.
   */
  fail(cause: unknown): Promise<void>;
}
/**
 * Inspect the candidate decision returned by StructuredOutputToolDefinition.execute to native tool
 * adapters. OutputSession.submitCandidate checks and retains accepted candidates. Acceptance is
 * provisional: final privacy/schema validation occurs at terminal publication. Rejection carries
 * safe retry/terminal policy; infrastructure failure can reject the callback promise instead.
 */
export type StructuredOutputToolResult = { accepted: true } | { accepted: false; error: HarnessError };
/**
 * Present this tool to the native agent and invoke execute for candidate calls. OutputSession.prepareOutput
 * passes the definition to a native StructuredOutputToolPort before input dispatch. The adapter
 * consumes acceptance or safe failure. Each callback captures its submission, so a late call cannot
 * satisfy a replacement input. Native tool registration/cleanup remains the adapter's responsibility.
 */
export interface StructuredOutputToolDefinition {
  /** Native tool name supplied by the output wrapper; keep it stable when presenting the tool. */
  name: string;
  /** Model-facing instructions supplied by the output wrapper. */
  description: string;
  /** Candidate schema whose constraints the native tool presentation must preserve. */
  schema: JsonSchema;
  /** Native tool calls await candidate validation/retention; resolve a decision, or reject an infrastructure failure. Acceptance does not settle Turn.result. */
  execute(value: unknown): Promise<StructuredOutputToolResult>;
}
/**
 * Implement session-scoped native tool registration on a BackendSession. OutputSession.prepareOutput
 * awaits installation before dispatch. OutputSession.completeTurn, reject and release disable the
 * tool on completion, definite rejection or teardown. Finish changes before resolving.
 */
export interface StructuredOutputToolPort {
  /**
   * OutputSession replaces the tool or disables it with undefined. Resolve when native registration
   * changes complete; setup rejection prevents input dispatch, while teardown rejection reports cleanup failure.
   */
  configure(tool?: StructuredOutputToolDefinition): Promise<void>;
}
/**
 * Return an owned native session from HarnessAdapter.openSession. OutputSession.open adopts it; Client then
 * attaches the wrapper to Session. Session.executeRequest awaits wrapper execute and
 * Session.disposeBackend awaits wrapper disposal, which releases the native backend. Receipt promises
 * and sink events can settle independently; adapters must preserve that distinction.
 */
export interface BackendSession {
  /** Optional native tool registration used by OutputSession.prepareOutput when native outputSchema support is absent. */
  readonly structuredOutputTool?: StructuredOutputToolPort;
  /** Optional attachment snapshot; Session.attach restores its active execution observations after checking its binding. */
  readonly state?: import('@anureo/protocol').SessionState;
  /** Session.attach requires the requested session/adapter/configuration IDs, then adopts this binding's nativeRef. */
  readonly binding: SessionBinding;
  /** Session-specific capabilities adopted at attachment, after output projection; may differ from initialization capabilities. */
  readonly capabilities: Capabilities;
  /**
   * OutputSession.execute invokes the native backend after policy setup and request validation.
   * Resolve a native receipt/result or reject a safe failure with unknown-outcome metadata when
   * acceptance is uncertain; neither wrapper nor Session automatically retries native dispatch.
   */
  execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]>;
  /** OutputSession.dispose awaits native handle release; implementations must be idempotent and reject cleanup failure without claiming execution stopped. */
  dispose(): Promise<void>;
}
/**
 * Implement native negotiation, session acquisition and client-wide cleanup for ClientOptions.adapter.
 * Client invokes these operations through its structured-output wrapper. Release partially acquired
 * native resources if setup fails. Be prepared to dispose after failed negotiation or while
 * negotiation or a native open is still in flight, since a host can stop waiting first.
 */
export interface HarnessAdapter {
  /**
   * Select a bridge transport reachable by the native session, or return undefined to disable MCP
   * fallback. OutputSession.open calls this synchronously when initialization lacks native
   * outputSchema support. Opt in when native open can consume session-scoped MCP configuration.
   * A throw rejects session setup.
   */
  outputBridgeTransport?(params: SessionOpenParams): 'http' | 'stdio' | undefined;
  /** Client.initialize awaits negotiation through its wrapper, validates the result and stores capabilities; reject incompatible contracts/native setup failure. */
  initialize(params: InitializeParams): Promise<InitializeResult>;
  /**
   * OutputSession.open supplies detached params and forwarding sink callbacks. Resolve an owned
   * backend; callbacks may run before it resolves. Reject setup failure after releasing partially
   * acquired native resources; the wrapper/Session release backends that arrive after caller teardown.
   */
  openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession>;
  /** The output wrapper invokes this after session cleanup attempts; release client-wide native resources or reject release failure. */
  dispose(): Promise<void>;
}

/**
 * Hosts supply these hooks/budgets through ClientOptions.runtime. Client consumes ID/wait policy;
 * Session consumes publication, interaction and privacy policy. Hooks can perform host-owned effects,
 * but do not transfer native execution ownership. Callback failures propagate through their invoking
 * operation; hosts must arrange any cleanup needed by their callbacks.
 */
export interface RuntimeOptions {
  /**
   * Generate nonempty, collision-free IDs synchronously; defaults to randomUUID. Client session helpers
   * and Session request/stream allocation invoke this; allocation failures propagate to their callers.
   */
  createId?: () => string;
  /**
   * Supply public ISO timestamps for Session.publish. Defaults to new Date().toISOString().
   * An invalid timestamp or throw fails publication. Interaction expiry uses wall-clock time.
   */
  now?: () => string;
  /**
   * Default wait for initialization, session requests, submission association and native interaction
   * responders, in milliseconds. Defaults to 30_000. Per-call waits can override the operation
   * wait. Turn.result has a separate 30-second default.
   */
  requestTimeoutMs?: number;
  /**
   * Default session attachment wait in milliseconds; defaults to 120_000. Per-call waits override it;
   * abort/expiry does not abandon late backend cleanup.
   */
  openTimeoutMs?: number;
  /**
   * Bound actionable interaction lifetime in milliseconds. Defaults to 600_000.
   * An earlier native expiry takes precedence.
   */
  interactionTimeoutMs?: number;
  /**
   * Separate caps for pending/settling interactions and live automatic handlers; each defaults to 32.
   * Aborted host work retains its slot until settled.
   */
  maxPendingInteractions?: number;
  /**
   * Retained idempotency-outcome count per session; defaults to 1024.
   * Session.admitRequestCapacity never evicts unsettled requests.
   */
  requestCacheSize?: number;
  /**
   * Set maxEvents, maxBytes and maxFrameBytes for session and structured-output event buffering.
   * Their defaults are 2048 events, 16 MiB buffered and 8 MiB per frame. Observer queues use
   * EventSubscriptionOptions.
   */
  queue?: QueueLimits;
  /**
   * Persist irreversible privacy metadata synchronously before accepting a new marked secret.
   * Session registers this hook with SecretRedactor. SecretRedactor.rememberScalar invokes it before
   * retaining a new marked value during InteractionRegistry.respond's pre-delivery check.
   * A throw prevents native response delivery and leaves earlier persisted values in place.
   */
  onMarkedSecret?: (binding: Readonly<SessionBinding>, value: string) => void;
  /**
   * Apply host privacy metadata, including secrets retained across processes, to a native history page.
   * Session.executeRequest invokes/awaits this after local history redaction, then validates/freezes
   * the returned history/read page for its caller. Host I/O is allowed; throws/rejection fail the
   * history request without SDK retries.
   */
  redactHistory?: (binding: Readonly<SessionBinding>, page: AhpResultMap["history/read"]) => AhpResultMap["history/read"] | Promise<AhpResultMap["history/read"]>;
}
