/** Negotiates a remote AHP peer and routes its validated streams into SDK session sinks. */
import {
  HarnessSdkError,
  type BackendSession,
  type HarnessAdapter,
  type SessionEventSink,
  type SessionMethod,
} from "@anureo/sdk";
import {
  assertDefinition,
  assertEvent,
  assertRequest,
  assertResult,
  negotiateVersion,
  publicValue,
  supportsExtension,
  type AhpEvent,
  type AhpRequestMap,
  type AhpResultMap,
  type InitializeParams,
  type InitializeResult,
  type InteractionRequested,
  type InteractionResponse,
  type InteractionResult,
  type JsonValue,
  type SessionMetadata,
  type SessionOpenParams,
} from "@anureo/protocol";
import { AhpWire, createStdioTransport, type AhpTransport, type WireOptions } from "./wire";

export { AhpWire, createStdioTransport, type AhpTransport } from "./wire";
export { createWebSocketTransport } from "./websocket";

/**
 * Configure one adapter-owned connection. A supplied transport takes precedence over a URL, which
 * takes precedence over a command. Wire limits and timeouts apply to the selected connection.
 * The adapter owns closing the selected transport.
 */
export interface AhpAdapterOptions extends WireOptions {
  /** Supply a connection or a factory invoked once on the first valid initialize call. */
  transport?: AhpTransport | (() => Promise<AhpTransport>);
  /** Executable used when neither transport nor URL is supplied. */
  command?: string;
  /** Arguments passed to the stdio executable. Omission supplies no arguments. */
  args?: string[];
  /** Environment passed to the stdio process factory. The default factory inherits when omitted. */
  env?: Record<string, string | undefined>;
  /** Working directory for the stdio process. Omission uses the host working directory. */
  cwd?: string;
  /** A URL requires an explicit connect factory. */
  url?: string;
  /** Open the URL connection. The adapter owns closing the returned transport. */
  connect?: (url: string) => Promise<AhpTransport>;
  /** Override stdio process creation. Transport cleanup calls the returned process's dispose method. */
  processFactory?: Parameters<typeof createStdioTransport>[0]["processFactory"];
}

/** Create an adapter without I/O. Pass it to createClient and dispose the resulting client. */
export function createAhpAdapter(options: AhpAdapterOptions): HarnessAdapter {
  return new AhpAdapter(options);
}

/**
 * Connect SDK sessions to one AHP peer. Direct users await initialize before opening sessions,
 * release their backend handles, and then await adapter disposal.
 */
export class AhpAdapter implements HarnessAdapter {
  /** Configure the connection without opening it. */
  constructor(private readonly options: AhpAdapterOptions) {}

  /**
   * Negotiate once and send initialized before resolving. Valid calls share the first attempt,
   * including rejection. Invalid params or unsupported offered versions throw synchronously.
   * Disposal, transport and handshake failures reject. The SDK's output wrapper awaits this result
   * and uses the negotiated output capability before Client stores the capabilities.
   */
  initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.disposed) return Promise.reject(new HarnessSdkError("RUNTIME_DISPOSED"));
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    return this.initialized ??= this.initializeConnection(params);
  }

  /**
   * Open a remote session. OutputSession.open supplies the sink, which may receive notifications
   * before the open reply. Resolve with the validated backend handle after any fallback metadata
   * publication. Duplicate IDs, RPC/schema failures, invalid bindings, retired streams and sink
   * failures reject. Failed setup removes local routing. The SDK wrapper owns backend disposal.
   */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (!this.wire || this.disposed) throw new HarnessSdkError("NOT_INITIALIZED");
    if (this.sessions.has(params.binding.sessionId)) throw new HarnessSdkError("SESSION_ALREADY_OPEN");
    const wire = this.wire;
    const record: SessionRecord = { sink, lastByStream: new Map(), pendingInteractionIds: new Set() };
    // The peer may send source events before replying to session/open.
    this.sessions.set(params.binding.sessionId, record);

    try {
      const opened = await wire.request("session/open", params);
      assertResult("session/open", opened);
      this.bindOpenedStream(record, params.binding, opened);
      if (!record.metadataObserved && opened.state?.metadata) {
        await sink.emit({ type: "session/metadata", payload: opened.state.metadata });
      }
      return this.createBackendSession({ wire, params, record, opened });
    } catch (cause) {
      this.sessions.delete(params.binding.sessionId);
      throw cause;
    }
  }

  /**
   * Close the owned connection and clear routing after successful close. The SDK wrapper attempts
   * session cleanup first. The first disposal awaits wire cleanup and can reject. Later calls return
   * immediately. If acquisition is pending, initialize closes the arriving transport before rejecting.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.wire?.close();
    this.sessions.clear();
  }

  private wire?: AhpWire;
  private initialized?: Promise<InitializeResult>;
  private result?: InitializeResult;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly retiredStreams = new Set<string>();
  // Registered while the SDK's responder runs. Its finally block or wire close clears the entry.
  private readonly inFlightInteractionResponses = new Map<string, InFlightInteractionResponse>();
  private disposed = false;

  /**
   * initialize shares this attempt. Attach wire callbacks before sending the handshake, then store
   * capabilities for notification handling before notifying the peer of readiness. Acquisition,
   * validation and write failures reject the shared attempt. Adapter disposal owns wire cleanup.
   */
  private async initializeConnection(params: InitializeParams): Promise<InitializeResult> {
    const selection = this.selectTransport();
    const transport = "ready" in selection ? selection.ready : await selection.pending;
    if (this.disposed) {
      await transport.close();
      throw new HarnessSdkError("RUNTIME_DISPOSED");
    }
    const wire = this.wire = new AhpWire(transport, this.options);
    wire.onNotification = (method, event) => this.notification(wire, method, event);
    wire.onClose = cause => this.failConnection(cause);
    const result = await wire.request("initialize", withMetadataCapability(params));
    assertResult("initialize", result);
    negotiateVersion([result.protocolVersion]);
    this.result = result;
    await wire.notify("initialized");
    return result;
  }

  /**
   * Select one transport for initializeConnection. Keep a supplied instance synchronous so the
   * wire starts immediately. Factory promises and selection errors flow to the initialization attempt.
   */
  private selectTransport(): { ready: AhpTransport } | { pending: Promise<AhpTransport> } {
    if (this.options.transport) {
      return typeof this.options.transport === "function"
        ? { pending: this.options.transport() }
        : { ready: this.options.transport };
    }
    if (this.options.url) {
      if (!this.options.connect) throw new HarnessSdkError("WEBSOCKET_FACTORY_REQUIRED");
      return { pending: this.options.connect(this.options.url) };
    }
    if (!this.options.command) throw new HarnessSdkError("HARNESS_UNAVAILABLE");
    return { pending: createStdioTransport({ ...this.options, command: this.options.command }) };
  }

  /** Commit the open reply's stream after checking its identity. A throw leaves openSession to remove routing. */
  private bindOpenedStream(
    record: SessionRecord,
    requested: SessionOpenParams["binding"],
    opened: AhpResultMap["session/open"],
  ): void {
    const { binding } = opened;
    if (binding.sessionId !== requested.sessionId
      || binding.adapterId !== requested.adapterId
      || binding.runtimeConfigId !== requested.runtimeConfigId) {
      throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    }
    const streamId = opened.streamId;
    if (this.retiredStreams.has(streamKey(requested.sessionId, streamId))) {
      throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");
    }
    record.streamId = streamId;
  }

  /** Build the backend that openSession transfers to OutputSession after setup and metadata publication. */
  private createBackendSession({ wire, params, record, opened }: OpenedSession): BackendSession {
    const adapter = this;
    return {
      binding: opened.binding,
      capabilities: opened.capabilities,
      state: opened.state,
      /** OutputSession.execute supplies validated input and receives the peer result or RPC/schema rejection. */
      async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
        const result = await wire.request(method, params);
        assertResult(method, result);
        return result;
      },
      /** OutputSession.dispose releases local routing here. The SDK sends session/close separately. */
      async dispose() {
        adapter.retire(params.binding.sessionId, record);
      },
    };
  }

  /** AhpWire awaits this on close. Fail sinks in registration order before rejecting response waiters. */
  private async failConnection(cause: unknown): Promise<void> {
    for (const session of this.sessions.values()) await session.sink.fail(cause);
    for (const response of this.inFlightInteractionResponses.values()) response.reject(cause);
    this.inFlightInteractionResponses.clear();
  }

  /**
   * AhpWire serializes this callback while continuing to read RPC replies. Ignore duplicate
   * sequences and retired streams, repair gaps before delivery, and forward unknown methods as
   * notices. Rejection starts wire cleanup, which invokes failConnection.
   */
  private async notification(wire: AhpWire, method: string, value: unknown): Promise<void> {
    if (!KNOWN_NOTIFICATIONS.includes(method)) {
      const raw = publicValue(JSON.parse(JSON.stringify(value ?? null)) as JsonValue);
      for (const session of this.sessions.values()) {
        await session.sink.emit({
          type: "notice",
          payload: { severity: "info", code: "UNKNOWN_NOTIFICATION", message: "Unknown AHP notification", raw },
        });
      }
      return;
    }
    assertEvent(value);
    if (value.type !== method) throw new HarnessSdkError("PROTOCOL_ERROR");
    if (this.retiredStreams.has(streamKey(value.sessionId, value.streamId))) return;

    const session = this.sessions.get(value.sessionId);
    if (!session) throw new HarnessSdkError("SOURCE_SESSION_MISMATCH");
    const last = session.lastByStream.get(value.streamId) ?? 0;
    if (value.seq <= last) return;

    if (session.streamId && session.streamId !== value.streamId) {
      throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");
    }
    session.streamId = value.streamId;
    if (value.seq !== last + 1) await this.replayMissingEvents({ wire, session, next: value, last });
    await this.deliver(wire, session, value);
  }

  /**
   * Fill the prefix immediately before the live event. notification awaits each repaired event before
   * delivering the live one. Replayed events can already have reached the sink when a later entry
   * proves the range invalid or incomplete and rejects the callback.
   */
  private async replayMissingEvents({ wire, session, next, last }: ReplayGap): Promise<void> {
    if (!this.result || !supportsExtension(this.result.capabilities, "x-anureo/event-replay", "1")) {
      throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
    }
    const raw = await wire.request("x-anureo/events/read", {
      sessionId: next.sessionId,
      streamId: next.streamId,
      afterSeq: last,
      throughSeq: next.seq - 1,
    });
    if (!raw || typeof raw !== "object" || !("events" in raw) || !Array.isArray(raw.events)) {
      throw new HarnessSdkError("SOURCE_STREAM_UNAVAILABLE");
    }
    for (const event of raw.events) {
      assertEvent(event);
      if (event.sessionId !== next.sessionId || event.streamId !== next.streamId) {
        throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
      }
      const nextExpectedSeq = (session.lastByStream.get(next.streamId) ?? 0) + 1;
      if (event.seq !== nextExpectedSeq || event.seq >= next.seq) {
        throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
      }
      await this.deliver(wire, session, event);
    }
    if ((session.lastByStream.get(next.streamId) ?? 0) + 1 !== next.seq) {
      throw new HarnessSdkError("SOURCE_SEQUENCE_GAP");
    }
  }

  /**
   * Admit one source event from notification or replayMissingEvents. Advance its sequence before
   * awaiting publication, so replay checks the admitted sequence. Await sink operations except the
   * interaction answer, whose confirmation can itself arrive on this notification queue.
   */
  private async deliver(wire: AhpWire, session: SessionRecord, event: AhpEvent): Promise<void> {
    session.lastByStream.set(event.streamId, event.seq);
    const scope = { turnId: event.turnId, itemId: event.itemId };
    if (event.type === "session/metadata" || (event.type === "extension" && event.payload.name === METADATA_EXTENSION.name)) {
      const metadata = this.readMetadata(event);
      if (Object.hasOwn(metadata, "title")) session.metadataObserved = true;
      await session.sink.emit({ type: "session/metadata", payload: metadata });
      return;
    }
    if (event.type === "interaction/requested") {
      this.registerInteraction(wire, session, event);
      return;
    }
    if (event.type === "interaction/resolved") {
      const key = interactionKey(event.sessionId, event.payload.interactionId);
      const inFlightResponse = this.inFlightInteractionResponses.get(key);
      if (inFlightResponse) {
        inFlightResponse.resolve(event.payload);
        return;
      }
      // Only unresolved requests can still be settled by the peer.
      if (session.pendingInteractionIds.delete(event.payload.interactionId)) {
        await session.sink.resolveInteraction(event.payload);
      }
      return;
    }
    if (event.type === "session/state" && event.payload.metadata && Object.hasOwn(event.payload.metadata, "title")) {
      session.metadataObserved = true;
    }
    await session.sink.emit({ type: event.type, payload: event.payload } as Parameters<SessionEventSink["emit"]>[0], scope);
  }

  /** Decode either metadata channel for deliver. Reject unnegotiated versions or invalid payloads before publication. */
  private readMetadata(event: Extract<AhpEvent, { type: "session/metadata" | "extension" }>): SessionMetadata {
    if (!this.result || !supportsExtension(this.result.capabilities, METADATA_EXTENSION.name, METADATA_EXTENSION.version)) {
      throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    }
    if (event.type === "extension" && event.payload.version !== METADATA_EXTENSION.version) {
      throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    }
    const metadata = event.type === "session/metadata" ? event.payload : event.payload.data;
    assertDefinition<SessionMetadata>("SessionMetadata", metadata);
    return metadata;
  }

  /**
   * Register the sink's responder when deliver receives a native interaction. The sink owns local
   * publication and settlement. Observe rejection without blocking the notification queue.
   */
  private registerInteraction(wire: AhpWire, session: SessionRecord, event: Extract<AhpEvent, { type: "interaction/requested" }>): void {
    const request = event.payload;
    const key = interactionKey(event.sessionId, request.interactionId);
    session.pendingInteractionIds.add(request.interactionId);
    void session.sink.requestInteraction(request, (response, reason) =>
      this.respondToInteraction({ wire, session, event, request, key, response, reason })
    ).catch(() => {});
  }

  /**
   * The SDK invokes the responder on answer or cancellation, including rejection at admission.
   * Await the first RPC reply or matching resolution, validate it, and reject unknown outcomes.
   * The SDK publishes local settlement. Release both registrations on exit and leave any outstanding
   * RPC under the wire's own deadline and close handling.
   */
  private async respondToInteraction({ wire, session, event, request, key, response, reason }: InteractionResponseInput): Promise<void> {
    let resolve!: (result: InteractionResult) => void;
    let reject!: (cause: unknown) => void;
    const confirmation = new Promise<InteractionResult>((yes, no) => { resolve = yes; reject = no; });
    this.inFlightInteractionResponses.set(key, { resolve, reject });
    try {
      const method = response ? "interaction/respond" : "interaction/cancel";
      const call = wire.request(method, {
        requestId: `ahp:${event.streamId}:${event.seq}`,
        sessionId: event.sessionId,
        interactionId: request.interactionId,
        ...(response ? { response } : { reason }),
      });
      const result = await Promise.race([call, confirmation]);
      assertResult(method, result);
      if (result.outcome === "unknown") throw new HarnessSdkError("RESULT_UNKNOWN", "RESULT_UNKNOWN", false, true);
    } finally {
      this.inFlightInteractionResponses.delete(key);
      session.pendingInteractionIds.delete(request.interactionId);
    }
  }

  /** Backend disposal removes its own registration and remembers up to 128 streams to ignore late events. */
  private retire(sessionId: string, record: SessionRecord): void {
    if (this.sessions.get(sessionId) !== record) return;
    this.sessions.delete(sessionId);
    if (!record.streamId) return;

    this.retiredStreams.add(streamKey(sessionId, record.streamId));
    if (this.retiredStreams.size > 128) {
      const oldest = this.retiredStreams.values().next();
      if (!oldest.done) this.retiredStreams.delete(oldest.value);
    }
  }
}

interface OpenedSession {
  wire: AhpWire;
  params: SessionOpenParams;
  record: SessionRecord;
  opened: AhpResultMap["session/open"];
}

interface ReplayGap {
  wire: AhpWire;
  session: SessionRecord;
  /** Live event that must follow the replayed prefix. */
  next: AhpEvent;
  /** Last admitted sequence, or zero before the first event. */
  last: number;
}

interface InteractionResponseInput {
  wire: AhpWire;
  session: SessionRecord;
  event: Extract<AhpEvent, { type: "interaction/requested" }>;
  request: InteractionRequested;
  /** Correlation key captured when the sink registers the request. */
  key: string;
  response: InteractionResponse | null;
  reason?: string;
}

interface SessionRecord {
  sink: SessionEventSink;
  /** Source sequences already admitted for delivery, including a publication still being awaited. */
  lastByStream: Map<string, number>;
  /** Expected source, learned from an early notification or the open reply. */
  streamId?: string;
  /** An explicit title, including null, suppresses fallback metadata from the open reply. */
  metadataObserved?: boolean;
  // Registered on receipt and removed by remote resolution or the responder's finally block.
  pendingInteractionIds: Set<string>;
}

interface InFlightInteractionResponse {
  resolve: (result: InteractionResult) => void;
  reject: (cause: unknown) => void;
}

const METADATA_EXTENSION = { name: "x-anureo/session-metadata", version: "1" };
const KNOWN_NOTIFICATIONS = [
  "submission/bound", "submission/status", "session/metadata", "session/state", "turn/started",
  "turn/completed", "item/started", "item/delta", "item/completed", "usage/updated",
  "interaction/requested", "interaction/resolved", "notice", "extension",
];

/** Replace offers for this extension so initializeConnection always advertises the version it can decode. */
function withMetadataCapability(params: InitializeParams): InitializeParams {
  const clientCapabilities = {
    ...params.clientCapabilities,
    extensions: [
      ...(params.clientCapabilities?.extensions ?? []).filter(e => e.name !== METADATA_EXTENSION.name),
      METADATA_EXTENSION,
    ],
  };
  return { ...params, clientCapabilities };
}

/** Preserve tuple boundaries even when either peer-supplied identifier contains a separator. */
function streamKey(sessionId: string, streamId: string): string {
  return JSON.stringify([sessionId, streamId]);
}

/** Correlate the response callback and remote resolution using the same session/interaction key. */
function interactionKey(sessionId: string, interactionId: string): string {
  return `${sessionId}:${interactionId}`;
}
