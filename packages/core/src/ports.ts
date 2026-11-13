// Defines adapter callbacks and host runtime hooks; must not implement transport, dispatch or resource lifecycles.
import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap, Capabilities, HarnessError, InitializeParams, InitializeResult, InteractionRequested, InteractionResponse, JsonSchema, SessionBinding, SessionOpenParams } from '@anureo/protocol';
import type { QueueLimits } from './queue';
/**
 * Native adapters supply this callback to the sink's requestInteraction. InteractionRegistry.respond
 * invokes it with an answer; cancel invokes it with null and a reason on expiry/cancellation/teardown.
 * Session.requestInteraction also calls it directly when rejecting closed, unsupported or handler
 * capacity admission. Resolve after native delivery/cancellation; reject delivery failures so registry
 * settlement can report an unknown outcome. The SDK does not retry potentially accepted responses.
 */
export type NativeInteractionResponder = (response: InteractionResponse | null, reason?: string) => Promise<void>;
/** Session.request and BackendSession.execute use these methods; Client handles initialize/session-open separately through HarnessAdapter. */
export type SessionMethod = Exclude<AhpMethod, 'initialize' | 'session/open'>;
/** Adapters pass this envelope to sink emit/tryEmit; Session.validateEvent rejects conflicts with payload turn/item IDs before publication. */
export interface EventScope {
  /** Execution identity needed for item/usage events whose payload carries no turn ID. */
  turnId?: string;
  /** Optional item identity; must agree with an item payload's own ID. */
  itemId?: string;
}
/**
 * Session implements this callback port and Client.attachSession supplies it to the output wrapper.
 * OutputSession.open registers forwarding callbacks with the native adapter, routing events through
 * output policy before Session publication. Adapters await publication methods for ordering and use
 * fail for observation failures; ownership of the Session and adapter stays with Client.
 */
export interface SessionEventSink {
  /**
   * OutputSession.publishOutput invokes this optional synchronous hook before final schema
   * revalidation. Session returns privacy-projected text without mutating retained candidates;
   * projection/validation failure becomes a failed terminal instead of publishing accepted JSON.
   */
  projectOutput?(text: string): string;
  /** Adapters await ordered submission/bound publication; Session.onRequestSucceeded also uses this for receipt-based association. Reject invalid/conflicting binding. */
  bindSubmission(submissionId: string, turnId: string): Promise<void>;
  /** Adapters await detached event publication; protocol/lifecycle/capacity failures reject and processing failures end Session observation. */
  emit(event: AhpEventPayload, scope?: EventScope): Promise<void>;
  /** Adapters unable to await attempt admission here; false reports immediate failure, while true still permits later publication failure to end observation. */
  tryEmit(event: AhpEventPayload, scope?: EventScope): boolean;
  /**
   * Adapters register a native request and responder here. Session publishes interaction/requested
   * before scheduling a configured host handler; manual answers enter Session.request instead.
   * Resolve the answer after responder delivery and result publication; cancellation, expiry and
   * settlement failures reject. Adapters retain their own native callback resources until settled.
   */
  requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse>;
  /**
   * Adapters report settlement already completed by the native peer. Session.resolveInteraction
   * delegates to InteractionRegistry.resolveExternally without calling responder; publish the result
   * then reject the pending requestInteraction even for responded, because no answer value is supplied.
   * Unknown/resolved IDs are ignored; result-publication failure rejects this call too.
   */
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void>;
  /** Adapters report observation loss here; Session.fail ends observers and attempts interaction/backend cleanup, suppressing backend release failure. Native stop remains unconfirmed. */
  fail(cause: unknown): Promise<void>;
}
/**
 * StructuredOutputToolDefinition.execute returns this decision to native tool adapters after
 * OutputSession.submitCandidate checks a candidate and retains it on acceptance. Acceptance is provisional: final
 * privacy/schema validation occurs at terminal publication. Rejection carries safe retry/terminal
 * policy; infrastructure failure can reject the callback promise instead.
 */
export type StructuredOutputToolResult = { accepted: true } | { accepted: false; error: HarnessError };
/**
 * OutputSession.prepareOutput passes this definition to a native StructuredOutputToolPort before
 * input dispatch. The adapter presents it to native tools and invokes execute for candidate calls,
 * consuming acceptance or safe failure. Each callback captures its submission, so a late call cannot
 * satisfy a replacement input. Native tool registration/cleanup remains the adapter's responsibility.
 */
export interface StructuredOutputToolDefinition {
  name: string;
  description: string;
  /** Candidate schema whose constraints the native tool presentation must preserve. */
  schema: JsonSchema;
  /** Native tool calls await candidate validation/retention; resolve a decision, or reject an infrastructure failure. Acceptance does not settle Turn.result. */
  execute(value: unknown): Promise<StructuredOutputToolResult>;
}
/**
 * Native backends optionally implement session-scoped tool registration. OutputSession.prepareOutput
 * awaits configure before input dispatch; completeTurn, reject and release call it without a tool to
 * disable registration. The adapter owns native registration effects and must finish them before
 * resolving so input dispatch cannot race setup.
 */
export interface StructuredOutputToolPort {
  /**
   * OutputSession replaces the tool or disables it with undefined. Resolve when native registration
   * changes complete; setup rejection prevents input dispatch, while teardown rejection reports cleanup failure.
   */
  configure(tool?: StructuredOutputToolDefinition): Promise<void>;
}
/**
 * Native HarnessAdapter.openSession returns this owned resource to OutputSession.open; Client then
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
 * Adapter implementers supply this resource in ClientOptions. Client installs withStructuredOutput,
 * then delegates negotiation, opening and disposal through that wrapper. Hosts initialize before
 * opening sessions and await Client.dispose; its session cleanup attempts precede adapter release.
 * Implementers own native setup effects and partially acquired resources on failure.
 */
export interface HarnessAdapter {
  /**
   * OutputSession.open synchronously queries this when initialization lacks native outputSchema
   * support. Select a reachable bridge transport, or undefined to disable MCP fallback; opt in only
   * when native open can consume session-scoped MCP configuration. Throws reject session setup.
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
  /** Client session helpers and Session request/stream allocation invoke this synchronously; return nonempty collision-free IDs or let allocation failure propagate. */
  createId?: () => string;
  /** Session.publish calls this for public ISO timestamps; invalid timestamps/throws fail publication, while expiry checks use wall-clock time. */
  now?: () => string;
  /** Default Client.initialize/Session request wait and interaction responder deadline in milliseconds; Turn.result has its own wait default. */
  requestTimeoutMs?: number;
  /** Client.open's default attachment wait in milliseconds; abort/expiry does not abandon late backend cleanup. */
  openTimeoutMs?: number;
  /** InteractionRegistry.begin bounds actionable lifetime in milliseconds, also respecting the native request's earlier expiry. */
  interactionTimeoutMs?: number;
  /** Separate caps for pending/settling interactions and live automatic handlers; aborted host work retains its slot until settled. */
  maxPendingInteractions?: number;
  /** Session.dispatchOperation's retained idempotency-outcome count; capacity never evicts unsettled requests. */
  requestCacheSize?: number;
  /** Shared policy for Session event admission and output buffering; observer subscriptions use EventSubscriptionOptions instead. */
  queue?: QueueLimits;
  /**
   * Session registers a forwarding callback with SecretRedactor; remember invokes it before retaining
   * a new marked value during InteractionRegistry.respond's pre-delivery check. Persist irreversible
   * privacy metadata synchronously; throws prevent native response delivery. Host persistence effects
   * already completed for earlier values are not rolled back.
   */
  onMarkedSecret?: (binding: Readonly<SessionBinding>, value: string) => void;
  /**
   * Session.executeRequest invokes/awaits this after local history redaction, then validates/freezes
   * the returned history/read page for its caller. Apply host privacy metadata (including cross-process
   * secrets); host I/O is allowed, and throws/rejection fail the history request without SDK retries.
   */
  redactHistory?: (binding: Readonly<SessionBinding>, page: AhpResultMap["history/read"]) => AhpResultMap["history/read"] | Promise<AhpResultMap["history/read"]>;
}
