// Defines adapter callbacks and host runtime hooks; must not implement transport, dispatch or resource lifecycles.
import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap, Capabilities, HarnessError, InitializeParams, InitializeResult, InteractionRequested, InteractionResponse, JsonSchema, SessionBinding, SessionOpenParams } from '@anureo/protocol';
import type { QueueLimits } from './queue';
/**
 * Deliver an interaction answer or cancellation to the native peer. Adapters supply this callback to
 * the sink's requestInteraction. InteractionRegistry.deliverResponse invokes it with an answer;
 * cancelPending invokes it with null and a reason on expiry/cancellation/teardown.
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
 * Publish native events and settle interactions through the sink supplied to HarnessAdapter.openSession.
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
  /** Await ordered submission/bound publication; invalid/conflicting bindings may throw or reject. Session.onRequestSucceeded also uses this for receipt-based association. */
  bindSubmission(submissionId: string, turnId: string): Promise<void>;
  /** Await detached event publication; admission may throw synchronously or reject. Processing failures reject and end Session observation. */
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
 * Implement session-scoped native tool registration on an optional BackendSession port. OutputSession.prepareOutput
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
 * Client installs withStructuredOutput, then delegates negotiation, opening and disposal through
 * that wrapper. Hosts initialize before
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
  /**
   * Generate nonempty, collision-free IDs synchronously; defaults to randomUUID. Client session helpers
   * and Session request/stream allocation invoke this; allocation failures propagate to their callers.
   */
  createId?: () => string;
  /**
   * Supply public ISO timestamps for Session.publish; defaults to new Date().toISOString().
   * Invalid timestamps/throws fail publication, while expiry checks use wall-clock time.
   */
  now?: () => string;
  /**
   * Default Client.initialize/Session request wait and interaction responder deadline in milliseconds;
   * defaults to 30_000. Per-call waits override request waits; Turn.result has its own default.
   */
  requestTimeoutMs?: number;
  /**
   * Default session attachment wait in milliseconds; defaults to 120_000. Per-call waits override it;
   * abort/expiry does not abandon late backend cleanup.
   */
  openTimeoutMs?: number;
  /**
   * Bound actionable interaction lifetime in milliseconds; defaults to 600_000.
   * InteractionRegistry.begin also respects the native request's earlier expiry.
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
   * Policy applied independently to Session event admission and output buffering; defaults to 2048
   * events, 16 MiB buffered and 8 MiB per frame. Observer subscriptions use EventSubscriptionOptions.
   */
  queue?: QueueLimits;
  /**
   * Persist irreversible privacy metadata synchronously before accepting a new marked secret.
   * Session registers a forwarding callback with SecretRedactor; remember invokes it before retaining
   * a new marked value during InteractionRegistry.respond's pre-delivery check. Throws prevent native
   * response delivery. Host persistence effects already completed for earlier values are not rolled back.
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
