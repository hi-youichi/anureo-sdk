import { acpFileChanges } from './file-changes';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import {
  spawnHarnessProcess, HarnessSdkError, sdkError, waitForRequest,
  type HarnessAdapter, type BackendSession, type SessionEventSink, type SessionMethod, type HarnessProcess,
} from '@anureo/sdk';
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, assertResult, assertDefinition,
  type Capabilities, type SessionBinding, type SessionOpenParams, type SessionState, type InitializeParams,
  type InitializeResult, type AhpRequestMap, type AhpResultMap, type JsonObject, type InteractionRequested,
  type InteractionResponse, type AhpEventPayload,
} from '@anureo/protocol';
import { AcpUpdateMapper, record, safe, input, mcp, configuration, resolveConfigValue } from './mapping';
import { StderrTail } from './diagnostics';
import { stopOutcome } from './stop';

/** Host-supplied ACP filesystem callbacks, registered only for provided operations.
 * The peer invokes them after session validation; hosts enforce path/access policy and return native responses.
 * Rejections become native request failures; filesystem effects remain host-owned. */
export interface AcpFileSystemPort {
  /** Read the requested native range as text; the host applies path policy. */
  readTextFile?: (params: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
  /** Resolve after the requested write completes; undefined is normalized by the ACP SDK. */
  writeTextFile?: (params: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse | void>;
}
/** Host-supplied terminal lifecycle invoked by the ACP peer after session/terminal ownership checks.
 * Successful creation transfers a terminal ID to the session; explicit release or session disposal calls
 * releaseTerminal. Hosts own process/access policy and must finish each operation before resolving. */
export interface AcpTerminalPort {
  /** Resolve with a session-local terminal ID after creation; subsequent operations use that ID. */
  createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  /** Return retained terminal output and truncation/exit metadata without releasing the terminal. */
  terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  /** Release terminal resources; successful resolution removes the ID from adapter ownership. */
  releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse | void>;
  /** Wait for terminal completion and return exit information; the terminal still requires release. */
  waitForTerminalExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  /** Request terminal termination; the terminal remains owned until release. */
  killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void>;
}
/** An owned ACP message transport returned by connect. The adapter locks its streams and calls dispose
 * during adapter teardown, including teardown racing connection setup; hosts implement resource release. */
export interface AcpChannel {
  /** Official ACP message stream; the adapter owns its reader/writer locks. */
  stream: acp.Stream;
  /** Release transport resources; rejection contributes to adapter release failure. */
  dispose(): Promise<void>;
  /** Optional redacted diagnostics captured so far; injected transports may also supply this hook. */
  diagnostics?(): string;
}
/** One-shot permission policy choices; selection is limited to an option actually offered by the peer. */
export type AcpPermissionDecision = 'allow-once' | 'reject-once';
/** Native permission request supplied to a host policy before interactive fallback.
 * IDs belong to the ACP peer; rawInput is unprojected provider data and must be handled accordingly. */
export interface AcpPermissionContext {
  sessionId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  /** Options actually offered by the agent; a policy never fabricates an optionId. */
  options: readonly acp.PermissionOption[];
  /** Native request cancellation signal; policies own cancellation of any host work they start. */
  signal: AbortSignal;
}
/** Answer a native permission request directly, or return undefined to ask through the session sink.
 * Policy throws/rejections fail the native request; the adapter does not retry the policy. */
export type AcpPermissionPolicy =
  | AcpPermissionDecision
  | ((context: AcpPermissionContext) => AcpPermissionDecision | undefined | Promise<AcpPermissionDecision | undefined>);
/** Configure a spawned ACP agent or an injected message transport and optional host resource policies. */
export interface AcpAdapterOptions {
  /** Executable for stdio; required when connect is omitted. */
  command?: string;
  /** Arguments passed to the executable; omitted arguments use the process helper's empty list. */
  args?: readonly string[];
  /** Working directory for the child process, independent of each session's cwd. */
  cwd?: string;
  /** Complete child environment; omission inherits the host environment. */
  env?: Record<string, string | undefined>;
  /** Advertise only supplied read/write operations; the host retains access-policy responsibility. */
  fs?: AcpFileSystemPort;
  /** Advertise terminal support; the host implements all lifecycle operations. */
  terminal?: AcpTerminalPort;
  /** Inject an official v1 message stream for remote transports or deterministic wire tests. */
  connect?: () => Promise<AcpChannel>;
  /** Native request wait in milliseconds, except session/prompt; defaults to 30,000. No native cancellation on expiry. */
  requestTimeoutMs?: number;
  /** Incoming/outgoing stdio line limit in bytes, excluding newline; defaults to 8 MiB. Not applied to connect streams. */
  maxFrameBytes?: number;
  /** Retained stderr lines for failure diagnostics; 0 disables capture. Defaults to 200. */
  stderrTailLines?: number;
  /** Receives redacted lines/chunks while capture is enabled; callback throws are ignored so draining continues. */
  onStderr?: (line: string) => void;
  /**
   * Answer `session/request_permission` without surfacing an AHP interaction.
   * Returning undefined (or a kind the agent did not offer) falls back to the
   * interactive path. Auto decisions are reported as `ACP_PERMISSION_AUTO_ANSWERED`
   * notices so they remain auditable.
   */
  autoRespondPermission?: AcpPermissionPolicy;
  /**
   * Receive nonempty resume/load snapshots after identity/configuration capture and before initial overrides.
   * Historical updates have no turn boundaries; title updates instead enter session metadata.
   * This synchronous callback is not awaited; a throw rejects open and removes its local indexes.
   */
  onLoadSnapshot?: (binding: SessionBinding, updates: readonly JsonObject[]) => void;
}

/** Connect an ACP agent to the SDK adapter port. Hosts normally pass a factory result to createClient,
 * which orders initialization, session acquisition and disposal through its output wrapper.
 * Direct adapter users must initialize before opening and await disposal even after setup failure. */
export class AcpAdapter implements HarnessAdapter {
  /** Construct the adapter without I/O; initialize acquires the transport and negotiates capabilities. */
  constructor(readonly options: AcpAdapterOptions) {}
  /** OutputSession.open queries this after negotiation to select a locally reachable MCP output bridge.
   * Injected transports cannot attest reachability and return undefined. */
  outputBridgeTransport(): 'http' | 'stdio' | undefined {
    if (!this.options.command || this.options.connect) return undefined
    return this.capabilities.mcp?.http ? 'http' : 'stdio'
  }
  /** Native capabilities from the initialize response when available, or an empty descriptor before negotiation. */
  get nativeCapabilities(): acp.AgentCapabilities { return this.info?.agentCapabilities ?? {}; }
  /** Access the connected native request context; throws ACP_CONNECTION_CLOSED before connection setup. */
  get agent(): acp.ClientContext { if (!this.connection) throw new HarnessSdkError('ACP_CONNECTION_CLOSED'); return this.connection.agent; }
  /** Whether a connection has been installed without an observed transport loss; not a native execution guarantee. */
  get connected(): boolean { return !!this.connection && !this.connectionLost; }
  /** Negotiate ACP and return detached AHP capabilities; repeated successful calls reuse negotiation.
   * Client.initialize awaits this through withStructuredOutput. Setup/version failures reject, with a
   * redacted stderr tail when available; direct callers retain disposal responsibility after failure. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    if (this.info) return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: this.runtime(), capabilities: structuredClone(this.capabilities) };
    const channel = this.options.connect ? await this.options.connect() : await processStream(this.options);
    if (this.closing) { await channel.dispose(); throw new HarnessSdkError('RUNTIME_DISPOSED'); }
    this.channel = channel;
    const wrapped = this.wrapStream(channel);
    const { app, terminal } = this.createClientApplication();
    this.connection = app.connect(wrapped);
    void this.connection.closed.then(async () => {
      this.connectionLost = true;
      const error = this.withDiagnostics(this.sourceFailure ?? new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP source connection closed', false, true));
      for (const delivery of this.deliveries.values()) delivery.reject(error); this.deliveries.clear();
      if (!this.closing) await Promise.all([...this.sessions.values()].map((session) => session.sink.fail(error).catch(() => {})));
    });
    try {
      this.info = await this.call('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: 'anureo-harness-sdk', version: '0.1.0' }, clientCapabilities: {
        fs: { readTextFile: !!this.options.fs?.readTextFile, writeTextFile: !!this.options.fs?.writeTextFile }, terminal: !!terminal,
        session: { configOptions: { boolean: {} }, compaction: {} }, plan: {},
        elicitation: params.clientCapabilities?.interactions?.includes('elicitation') ? { form: {}, url: {} } : undefined,
        _meta: { ahp: { version: 1, clientRequests: ['_ahp/user_input', '_ahp/dynamic_tool'] } },
      } });
    } catch (error) {
      throw this.withDiagnostics(error instanceof HarnessSdkError ? error : sdkError(error, 'ACP_HANDSHAKE_FAILED', true));
    }
    if (this.info.protocolVersion !== acp.PROTOCOL_VERSION) { await this.dispose(); throw new HarnessSdkError('PROTOCOL_VERSION_UNSUPPORTED'); }
    this.configureCapabilities();
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: this.runtime(), capabilities: structuredClone(this.capabilities) };
  }
  /** Issue a native request with requestTimeoutMs (30 seconds by default), preserving typed SDK failures.
   * Session/configuration and extension operations use this path; prompts bypass the deadline because
   * their native response may be terminal. A timeout stops waiting and does not cancel native work. */
  async call<M extends acp.AgentRequestMethod>(method: M, params: acp.AgentRequestParamsByMethod[M]): Promise<acp.AgentRequestResponsesByMethod[M]>;
  async call(method: string, params: unknown): Promise<unknown>;
  async call(method: string, params: unknown): Promise<unknown> {
    try { return await waitForRequest(() => this.agent.request(method, params), {}, this.options.requestTimeoutMs ?? 30_000); }
    catch (error) { throw errorFromNative(error); }
  }
  /** Open, resume/load or fork one native session, serializing opens to route early updates safely.
   * OutputSession.open supplies the sink and awaits configured state/metadata before attachment.
   * Failures remove local indexes and release the open slot; acquired transport remains adapter-owned.
   * Successful backends remain adapter-tracked and must be disposed by their owner. */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    // Serialize opens so openingSession can associate session/update notifications
    // received before the native open response with the current opening session.
    const previousOpenCompleted = this.sessionOpenQueueTail;
    let releaseOpenSlot!: () => void;
    this.sessionOpenQueueTail = new Promise((resolve) => { releaseOpenSlot = resolve; });
    await previousOpenCompleted;
    const session = new AcpBackendSession(this, params, sink);
    this.openingSession = session;
    try {
      if (params.instructions && !this.extension.instructions) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'ACP peer did not negotiate instructions');
      const common = { cwd: params.cwd, mcpServers: mcp(params.mcpServers), ...(params.instructions ? { _meta: { ahp: { version: 1, instructions: params.instructions } } } : {}) };
      let response: Record<string, unknown>;
      if (params.mode === 'new') response = record(await this.call('session/new', common));
      else if (params.mode === 'resume') {
        if (!params.binding.nativeRef || params.binding.nativeRef.provider !== 'acp') throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
        session.nativeId = params.binding.nativeRef.value;
        // Register the known native ID before resume/load can send notifications.
        this.nativeSessions.set(session.nativeId, session);
        session.hydrating = true;
        response = record(await this.call(this.nativeCapabilities.sessionCapabilities?.resume != null ? 'session/resume' : 'session/load', { ...common, sessionId: session.nativeId }));
      } else {
        const nativeRef = params.fork?.nativeRef ?? this.sessions.get(params.fork!.sourceSessionId)?.binding.nativeRef;
        if (!nativeRef || !this.extension.methods.fork) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
        response = record(await this.call(this.extension.methods.fork, { ...common, sessionId: nativeRef.value, boundary: params.fork!.boundary }));
      }
      if (typeof response.sessionId === 'string') {
        if (session.nativeId && response.sessionId !== session.nativeId) throw new HarnessSdkError('ACP_PROTOCOL_ERROR', 'ACP session identity changed while opening');
        session.nativeId = response.sessionId;
      }
      if (!session.nativeId) throw new HarnessSdkError('ACP_PROTOCOL_ERROR', 'ACP session response lacked an identity');
      // Keep the same session indexed by native ID and by AHP binding session ID.
      this.nativeSessions.set(session.nativeId, session);
      this.sessions.set(params.binding.sessionId, session);
      session.configure(response); session.hydrating = false;
      if (session.loadedSnapshot.length) this.options.onLoadSnapshot?.(session.binding, session.loadedSnapshot);
      const patch = { ...params.config, ...(params.model ? { model: resolveConfigValue(session.capabilities, 'model', params.model) } : {}), ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}) };
      if (Object.keys(patch).length) await session.setConfiguration(patch);
      if (session.snapshot().metadata) await sink.emit({ type: 'session/metadata', payload: session.snapshot().metadata! });
      return session;
    } catch (error) { for (const [id, value] of this.nativeSessions) if (value === session) this.nativeSessions.delete(id); this.sessions.delete(params.binding.sessionId); throw error; }
    finally {
      this.openingSession = undefined;
      releaseOpenSlot();
    }
  }
  /** Attempt all tracked session releases, then close the native connection and channel, and clear indexes.
   * Reject RESOURCE_RELEASE_FAILED after all attempts if any fail. Repeated calls after closing begins
   * return immediately; disposal does not prove native executions stopped. */
  async dispose(): Promise<void> {
    if (this.closing) return; this.closing = true;
    const results = await Promise.allSettled([...this.sessions.values()].map(session => session.dispose()));
    const transport = await Promise.allSettled([Promise.resolve().then(() => this.connection?.close()), Promise.resolve().then(() => this.channel?.dispose())]);
    this.sessions.clear(); this.nativeSessions.clear();
    const failures = [...results, ...transport].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'ACP resources were not fully released', false, true, { errors: failures.map(() => ({ code: 'ACP_RELEASE_FAILED' })) });
  }
  private connection: acp.ClientConnection | undefined;
  private channel: AcpChannel | undefined;
  private info: acp.InitializeResponse | undefined;
  /** Adapter-owned AHP session index, retained through session disposal until adapter teardown. */
  readonly sessions = new Map<string, AcpBackendSession>();
  private nativeSessions = new Map<string, AcpBackendSession>();
  private openingSession: AcpBackendSession | undefined;
  private sessionOpenQueueTail = Promise.resolve();
  private readonly deliveries = new Map<acp.JsonRpcId, Deferred>();
  private closing = false;
  private connectionLost = false;
  private sourceFailure?: HarnessSdkError;
  /** Negotiated extension state shared with backends; method-not-found may withdraw methods. */
  extension: Extensions = { methods: {}, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  /** Negotiated baseline; each backend clones it before applying session configuration. */
  capabilities: Capabilities = {};
  /** Attach the redacted stderr tail so a silent startup crash stays diagnosable. */
  private withDiagnostics(error: HarnessSdkError): HarnessSdkError {
    const tail = this.channel?.diagnostics?.();
    if (!tail) return error;
    return new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown, {
      ...error.details,
      diagnostics: { stderrTail: tail },
    });
  }
  /** Resolve a native session for registered callbacks. Update notifications may identify the serialized
   * opening session before its open response; other requests must refer to an already indexed session. */
  private backend(nativeId: string, source: 'request' | 'update' = 'request'): AcpBackendSession {
    const existing = this.nativeSessions.get(nativeId);
    if (existing) return existing;
    if (source === 'update' && this.openingSession && (!this.openingSession.nativeId || this.openingSession.nativeId === nativeId)) {
      this.openingSession.nativeId = nativeId;
      // Index by native ID as soon as a session/update identifies the opening session.
      this.nativeSessions.set(nativeId, this.openingSession);
      return this.openingSession;
    }
    throw new acp.RequestError(-32602, 'Unknown ACP session');
  }
  /** Register a native request with the session sink after establishing standard turn correlation.
   * The sink invokes the responder with an answer or cancellation. Resolve the native response first,
   * but keep the responder pending until wrapStream confirms its write, so settlement cannot claim early delivery. */
  private async interaction<T>(session: AcpBackendSession, requestId: acp.JsonRpcId, request: InteractionRequested, transform: (response: InteractionResponse | null) => T): Promise<T> {
    await session.ensureStandardStarted();
    const delivery = deferred(); this.deliveries.set(requestId, delivery);
    return new Promise<T>((resolve, reject) => {
      let answered = false;
      void session.sink.requestInteraction(request, async (response) => {
        answered = true; resolve(transform(response));
        await delivery.promise;
      }).catch(() => { if (!answered) reject(new acp.RequestError(-32603, 'Interaction could not be completed')); });
    });
  }
  /** Consume session updates and negotiated lifecycle events before the official SDK handles remaining frames.
   * Await sink publication to preserve source order; routing failures end stream observation in wrapStream. */
  private async routeNotification(frame: acp.AnyMessage): Promise<'consumed' | 'forward-to-sdk'> {
    // Preserve unknown notifications without requiring a patched SDK union of update variants.
    if ('method' in frame && !('id' in frame) && frame.method === 'session/update') {
      const value = record(frame.params);
      const session = this.backend(String(value.sessionId), 'update');
      await session.update(record(value.update));
      return 'consumed';
    }
    if ('method' in frame && !('id' in frame) && frame.method === '_ahp/event' && (Object.keys(this.extension.methods).length || this.extension.nativeLifecycle)) {
      const value = record(frame.params);
      const session = this.backend(String(value.sessionId));
      const event = value.event;
      if (this.extension.nativeLifecycle) {
        await session.nativeEvent(event, value);
        return 'consumed';
      }
      await session.extensionEvent(event, value);
      return 'consumed';
    }
    if ('method' in frame && !('id' in frame) && frame.method !== 'elicitation/complete') {
      const scope = record(frame.params).sessionId;
      const recipients = typeof scope === 'string' ? [this.backend(scope)] : [...this.sessions.values()];
      for (const session of recipients) await session.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_UNKNOWN_NOTIFICATION', message: 'Unknown ACP notification retained', raw: safe({ method: frame.method, params: frame.params }) } });
      return 'consumed';
    }
    return 'forward-to-sdk';
  }
  /** Wrap initialize's channel so routed notifications and response delivery precede SDK settlement. */
  private wrapStream(channel: AcpChannel): acp.Stream {
    const rawReader = channel.stream.readable.getReader(); const rawWriter = channel.stream.writable.getWriter();
    return {
      writable: new WritableStream({ write: async (frame) => {
        try {
          await rawWriter.write(frame);
          if ('id' in frame && !('method' in frame)) { this.deliveries.get(frame.id)?.resolve(); this.deliveries.delete(frame.id); }
        } catch (error) {
          this.connectionLost = true;
          const failure = this.sourceFailure = sdkError(error, 'ACP_CONNECTION_CLOSED', true);
          for (const delivery of this.deliveries.values()) delivery.reject(failure);
          void Promise.all([...this.sessions.values()].map(session => session.sink.fail(failure).catch(() => {})));
          throw error;
        }
      }, close: () => rawWriter.close(), abort: (reason) => rawWriter.abort(reason) }),
      readable: new ReadableStream({ pull: async (controller) => {
        try {
          for (;;) {
            const next = await rawReader.read(); if (next.done) { controller.close(); return; }
            const frame = next.value;
            if (await this.routeNotification(frame) === 'consumed') continue;
            controller.enqueue(frame); return;
          }
        } catch (error) {
          this.connectionLost = true;
          const failure = this.sourceFailure = sdkError(error, 'ACP_CONNECTION_CLOSED', true);
          controller.error(error);
          void Promise.all([...this.sessions.values()].map(session => session.sink.fail(failure).catch(() => {})));
        }
      }, cancel: (reason) => rawReader.cancel(reason) }),
    };
  }
  /** Register native request callbacks before initialize advertises their capabilities. */
  private createClientApplication(): { app: acp.ClientApp; terminal: AcpTerminalPort | undefined } {
    const app = acp.client({ name: 'anureo-harness-sdk-acp' })
      .onRequest('session/request_permission', (context) => this.requestPermission(context))
      .onRequest('elicitation/create', (context) => {
        const native = record(context.params);
        if (typeof native.sessionId !== 'string' || !['form', 'url'].includes(String(native.mode))) return { action: 'cancel' as const };
        const session = this.backend(native.sessionId);
        const request: InteractionRequested = { kind: 'elicitation', interactionId: `acp-elicitation:${String(context.requestId)}`, turnId: session.activeTurn, mode: native.mode as 'form' | 'url', message: String(native.message ?? ''), ...(native.mode === 'form' ? { schema: safe(native.requestedSchema) as JsonObject } : { privatePayload: { url: String(native.url ?? ''), elicitationId: String(native.elicitationId ?? '') } }) };
        return this.interaction<acp.CreateElicitationResponse>(session, context.requestId, request, (response) => response?.kind === 'elicitation' ? { action: response.action, ...(response.content ? { content: response.content as Record<string, string | number | boolean | string[]> } : {}) } : { action: 'cancel' });
      })
      .onNotification('elicitation/complete', async (context) => {
        for (const session of this.sessions.values()) await session.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_ELICITATION_COMPLETE', message: 'External authorization completed', raw: safe(context.params) } });
      })
      .onRequest('_ahp/user_input', (value: unknown) => record(value), (context) => this.extensionInteraction('userInput', context.requestId, context.params))
      .onRequest('_ahp/dynamic_tool', (value: unknown) => record(value), (context) => this.extensionInteraction('dynamicTool', context.requestId, context.params));
    const terminal = this.registerPorts(app);
    return { app, terminal };
  }
  /** The SDK invokes this registered permission handler; undecided policies retain the interactive path. */
  private async requestPermission(context: acp.ClientRequestContext<acp.RequestPermissionRequest>): Promise<acp.RequestPermissionResponse> {
    const session = this.backend(context.params.sessionId);
    const policy = this.options.autoRespondPermission;
    if (policy !== undefined) {
      const decision = typeof policy === 'function'
        ? await policy({
            sessionId: context.params.sessionId,
            toolCallId: context.params.toolCall.toolCallId,
            title: context.params.toolCall.title ?? undefined,
            kind: context.params.toolCall.kind ?? undefined,
            rawInput: context.params.toolCall.rawInput,
            options: context.params.options,
            signal: context.signal,
          })
        : policy;
      const optionId = decision ? selectPermissionOption(context.params.options, decision) : undefined;
      if (optionId !== undefined) {
        await session.sink.emit({ type: 'notice', payload: {
          severity: 'info', code: 'ACP_PERMISSION_AUTO_ANSWERED', message: 'Permission request answered by adapter policy',
          raw: safe({ toolCallId: context.params.toolCall.toolCallId, optionId, decision }),
        } }, { ...(session.activeTurn ? { turnId: session.activeTurn } : {}) });
        return { outcome: { outcome: 'selected', optionId } };
      }
    }
    return this.interaction<acp.RequestPermissionResponse>(session, context.requestId, {
      kind: 'approval', interactionId: `acp-permission:${String(context.requestId)}`, turnId: session.activeTurn,
      itemId: context.params.toolCall.toolCallId,
      options: context.params.options.map((option) => ({ id: option.optionId, label: option.name, semantic: option.kind === 'allow_once' ? 'allowOnce' : option.kind === 'allow_always' ? 'allowSession' : 'deny' })),
      ...(context.params.toolCall.rawInput !== undefined ? { input: safe(context.params.toolCall.rawInput) } : {}),
    }, (response) => response?.kind === 'approval' ? { outcome: { outcome: 'selected', optionId: response.optionId } } : { outcome: { outcome: 'cancelled' } });
  }
  /** Validate session/terminal ownership before invoking host-supplied resource operations. */
  private registerPorts(app: acp.ClientApp): AcpTerminalPort | undefined {
    if (this.options.fs?.readTextFile) app.onRequest('fs/read_text_file', (ctx) => { this.backend(ctx.params.sessionId); return this.options.fs!.readTextFile!(ctx.params); });
    if (this.options.fs?.writeTextFile) app.onRequest('fs/write_text_file', (ctx) => { this.backend(ctx.params.sessionId); return this.options.fs!.writeTextFile!(ctx.params); });
    const terminal = this.options.terminal;
    if (terminal) {
      app.onRequest('terminal/create', async (ctx) => { const session = this.backend(ctx.params.sessionId); const result = await terminal.createTerminal(ctx.params); session.terminals.add(result.terminalId); return result; });
      app.onRequest('terminal/output', (ctx) => { this.backend(ctx.params.sessionId).requireTerminal(ctx.params.terminalId); return terminal.terminalOutput(ctx.params); });
      app.onRequest('terminal/wait_for_exit', (ctx) => { this.backend(ctx.params.sessionId).requireTerminal(ctx.params.terminalId); return terminal.waitForTerminalExit(ctx.params); });
      app.onRequest('terminal/kill', (ctx) => { this.backend(ctx.params.sessionId).requireTerminal(ctx.params.terminalId); return terminal.killTerminal(ctx.params); });
      app.onRequest('terminal/release', async (ctx) => { const session = this.backend(ctx.params.sessionId); session.requireTerminal(ctx.params.terminalId); const result = await terminal.releaseTerminal(ctx.params); session.terminals.delete(ctx.params.terminalId); return result; });
    }
    return terminal;
  }
  /** Publish only capabilities backed by initialize's native response and negotiated extensions. */
  private configureCapabilities(): void {
    this.extension = extensions(this.info);
    const native = this.nativeCapabilities;
    this.capabilities = {
      session: { resume: native.loadSession === true || native.sessionCapabilities?.resume != null, fork: this.extension.fork, revert: this.extension.revert, history: !!this.extension.methods.history },
      input: { delivery: ['native'], interrupt: { targets: ['session'], reportsPendingInputs: false } },
      turn: { inputModalities: ['text', ...(native.promptCapabilities?.image ? ['image' as const] : []), ...(native.promptCapabilities?.embeddedContext ? ['file' as const] : [])] },
      interactions: ['approval', 'elicitation', ...(this.extension.userInput ? ['userInput' as const] : []), ...(this.extension.dynamicTool ? ['dynamicTool' as const] : [])],
      goal: { actions: [...(this.extension.methods.goalSet ? ['set' as const] : []), ...(this.extension.methods.goalClear ? ['clear' as const] : [])] },
      compact: !!this.extension.methods.compact, review: !!this.extension.methods.review, subagents: { events: this.extension.subagents ? 'nested' : 'none' },
      mcp: { stdio: true, http: native.mcpCapabilities?.http === true, elicitation: ['form', 'url'] }, config: { options: [] },
      extensions: Object.keys(this.extension.methods).length || this.extension.subagents || this.extension.userInput || this.extension.dynamicTool ? [{ name: 'x-acp/ahp', version: '1' }] : [],
    };
  }
  private runtime() { return { name: this.info?.agentInfo?.name ?? 'acp', version: this.info?.agentInfo?.version ?? 'unknown', adapter: 'acp/0.1.0' }; }
  /** Handle registered _ahp user-input/tool requests only after negotiation; validate before sink registration.
   * Native callers receive a response or cancellation; unavailable extensions reject as method-not-found. */
  private async extensionInteraction(kind: 'userInput' | 'dynamicTool', id: acp.JsonRpcId, params: Record<string, unknown>): Promise<unknown> {
    if (!this.extension[kind]) throw new acp.RequestError(-32601, 'Extension was not negotiated');
    const session = this.backend(String(params.sessionId));
    const request = { ...record(params.request), kind, interactionId: `acp-${kind}:${String(id)}`, turnId: session.activeTurn };
    assertDefinition<InteractionRequested>('InteractionRequested', request);
    return this.interaction(session, id, request, (response) => response ?? { cancelled: true });
  }
}

/** Native session implementation returned by AcpAdapter.openSession and adopted by OutputSession.open.
 * Execution receipts and sink lifecycle events are separate observations; disposal releases handles
 * without asserting that native execution stopped. Routing/state methods support adapter collaboration. */
export class AcpBackendSession implements BackendSession {
  /** Create session-local projection/configuration state without native I/O; AcpAdapter.openSession assigns identity. */
  constructor(readonly adapter: AcpAdapter, private readonly params: SessionOpenParams, readonly sink: SessionEventSink) {
    this.capabilities = structuredClone(adapter.capabilities);
    this.mapper = new AcpUpdateMapper(sink, () => this.activeTurn, () => this.snapshot(), (data) => this.configure(data), adapter.extension.subagents);
  }
  /** Attach the native ACP identity to the requested AHP binding; identity is established before openSession returns. */
  get binding(): SessionBinding { return { ...this.params.binding, nativeRef: { provider: 'acp', value: this.nativeId } }; }
  /** Expose the current attachment snapshot to OutputSession.open; collection fields are session-owned. */
  get state(): SessionState { return this.snapshot(); }
  /** Build state for attachment and sink publication without cloning session-owned configuration/capabilities. */
  snapshot(): SessionState { return { ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}), binding: this.binding, config: this.config, capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, status: this.activeTurn ? 'running' : 'ready', activeTurnIds: [...this.nativeStartedTurnIds, ...(this.standardTurnStarted && this.activeTurn ? [this.activeTurn] : [])] }; }
  /** AcpAdapter.routeNotification forwards negotiated v2 events here. Bind submissions through the sink,
   * flush a turn's mapper before its terminal event, and reject invalid payloads instead of publishing them. */
  async nativeEvent(raw: unknown, scope: Record<string, unknown>): Promise<void> {
    const event = record(raw), payload = record(event.payload);
    if (event.type === 'submission/bound') { assertDefinition<import('@anureo/protocol').SubmissionBound>('SubmissionBound', payload); await this.sink.bindSubmission(payload.submissionId, payload.turnId); return; }
    assertDefinition<AhpEventPayload>('AhpEventPayload', raw);
    if (raw.type === 'turn/started') this.nativeStartedTurnIds.add(raw.payload.turnId);
    if (raw.type === 'turn/completed') {
      await this.nativeMappers.get(raw.payload.turnId)?.complete();
      this.nativeMappers.delete(raw.payload.turnId); this.nativeStartedTurnIds.delete(raw.payload.turnId);
    }
    await this.sink.emit(raw, { ...(typeof scope.turnId === 'string' ? { turnId: scope.turnId } : {}) });
  }
  /** Publish legacy _ahp events from AcpAdapter.routeNotification, binding review/input on native start.
   * Release matching terminal admission before publication; conflicting execution identities reject routing. */
  async extensionEvent(raw: unknown, scope: Record<string, unknown>): Promise<void> {
    assertDefinition<AhpEventPayload>('AhpEventPayload', raw);
    if (raw.type === 'turn/started') {
      if (this.standardTurnStarted && this.activeTurn !== raw.payload.turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'ACP execution identity changed');
      this.activeTurn = raw.payload.turnId;
      await this.sink.emit(raw);
      if (this.standardSubmissionId && !this.standardTurnStarted) {
        this.standardTurnStarted = true;
        await this.sink.bindSubmission(this.standardSubmissionId, raw.payload.turnId);
      }
      return;
    }
    if (raw.type === 'turn/completed' && this.activeTurn === raw.payload.turnId) {
      this.activeTurn = undefined; this.standardSubmissionId = undefined; this.standardTurnStarted = false;
    }
    await this.sink.emit(raw, { ...(typeof scope.turnId === 'string' ? { turnId: scope.turnId } : this.activeTurn ? { turnId: this.activeTurn } : {}) });
  }
  /** Establish a standard ACP turn before its first update/interaction or terminal prompt response.
   * Publish start before binding the submission; set the guard first to prevent duplicate starts during awaits. */
  async ensureStandardStarted(): Promise<void> {
    if (!this.standardSubmissionId || !this.activeTurn || this.standardTurnStarted) return;
    this.standardTurnStarted = true;
    await this.sink.emit({ type: 'turn/started', payload: { turnId: this.activeTurn } });
    await this.sink.bindSubmission(this.standardSubmissionId, this.activeTurn);
  }
  /** Merge native configuration or a session-title patch from open responses and AcpUpdateMapper callbacks.
   * Configuration changes refresh descriptors and revision; title-only changes leave the revision unchanged. */
  configure(data: Record<string, unknown>): void {
    if (Object.hasOwn(data, 'sessionTitle')) { this.sessionTitle = data.sessionTitle as string | null; return; }
    this.configurationData = { ...this.configurationData, ...data };
    if (typeof data.currentModeId === 'string') this.configurationData.modes = { ...record(this.configurationData.modes), currentModeId: data.currentModeId };
    const descriptor = configuration(this.configurationData); this.configKeys = descriptor.keys;
    this.capabilities.config = { options: descriptor.options }; this.config = { ...this.config, ...descriptor.values };
    if (typeof data.currentModeId === 'string') this.config.mode = data.currentModeId;
    this.capabilityRevision++;
  }
  /** AcpAdapter routes session/update here: retain bounded load snapshots without replay, or await live projection.
   * Correlated updates require an observed start; unsupported uncorrelated execution updates reject routing. */
  async update(data: Record<string, unknown>): Promise<void> {
    if (this.hydrating && data.sessionUpdate === 'session_info_update') {
      if (typeof data.title === 'string' || data.title === null) this.sessionTitle = data.title;
      return;
    }
    if (this.hydrating) {
      this.snapshotBytes += JSON.stringify(data).length * 3;
      if (this.loadedSnapshot.length >= 2048 || this.snapshotBytes > 16 * 1024 * 1024) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'ACP load snapshot exceeds its limit');
      this.loadedSnapshot.push(safe(data) as JsonObject); return;
    }
    if (this.adapter.extension.nativeLifecycle) {
      const native = record(record(data._meta).ahp), turnId = typeof native.turnId === 'string' ? native.turnId : undefined;
      if (turnId) {
        if (!this.nativeStartedTurnIds.has(turnId)) throw new HarnessSdkError('PROTOCOL_ERROR', 'ACP update arrived without its execution start');
        let mapper = this.nativeMappers.get(turnId);
        if (!mapper) { mapper = new AcpUpdateMapper(this.sink, () => turnId, () => this.snapshot(), value => this.configure(value), this.adapter.extension.subagents); this.nativeMappers.set(turnId, mapper); }
        await mapper.update(data); return;
      }
      if (!['session_info_update', 'config_option_update', 'current_mode_update', 'usage_update', 'available_commands_update'].includes(String(data.sessionUpdate))) throw new HarnessSdkError('NATIVE_CORRELATION_UNSUPPORTED');
    }
    if (!['session_info_update', 'config_option_update', 'current_mode_update', 'available_commands_update'].includes(String(data.sessionUpdate))) await this.ensureStandardStarted();
    await this.mapper.update(data);
  }
  /** Reject peer operations on terminal IDs not successfully created for this session or already released. */
  requireTerminal(id: string): void { if (!this.terminals.has(id)) throw new acp.RequestError(-32602, 'Terminal does not belong to this session'); }
  /** Validate all keys, then apply native changes sequentially and publish each confirmed state.
   * Called by openSession for initial overrides and execute for host patches. Later native failure
   * rejects CONFIG_PARTIAL with confirmed keys; prior effects remain applied and are not rolled back. */
  async setConfiguration(patch: JsonObject): Promise<SessionState> {
    for (const key of Object.keys(patch)) if (!this.configKeys.has(key)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const appliedKeys: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      try {
        const option = this.configKeys.get(key)!;
        if (option.type === 'mode') await this.adapter.call('session/set_mode', { sessionId: this.nativeId, modeId: String(value) });
        else {
          const response = await this.adapter.call('session/set_config_option', { sessionId: this.nativeId, configId: String(option.id), type: option.type === 'boolean' ? 'boolean' : 'select', value });
          this.configure(record(response));
        }
      } catch (cause) {
        const error = errorFromNative(cause);
        if (!appliedKeys.length) throw error;
        throw new HarnessSdkError('CONFIG_PARTIAL', 'Some configuration changes were applied', error.retryable, error.outcomeUnknown,
          { appliedKeys, failedKey: key, cause: { code: error.code } });
      }
      this.config[key] = value;
      appliedKeys.push(key);
      // Native config methods commit independently; publish each confirmed state.
      await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
    }
    return this.snapshot();
  }
  /** OutputSession.execute dispatches validated session operations here and consumes the native result/failure.
   * Session cancellation only acknowledges notification delivery; completion comes from the prompt/event.
   * Close reports executionStopped=unconfirmed, and unsupported exact-turn operations reject. */
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case 'input/submit': return await this.submitInput(params as AhpRequestMap['input/submit']) as AhpResultMap[M];
      case 'turn/interrupt': case 'turn/steer': throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
      case 'session/interrupt': await this.adapter.agent.notify('session/cancel', { sessionId: this.nativeId }); result = { accepted: true }; break;
      case 'session/config/set': result = await this.setConfiguration((params as AhpRequestMap['session/config/set']).patch); break;
      case 'session/close': {
        if (this.adapter.nativeCapabilities.sessionCapabilities?.close != null) await this.adapter.call('session/close', { sessionId: this.nativeId });
        this.nativeClosed = true;
        result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' }; break;
      }
      case 'session/revert': return this.extension('revert', method, params);
      case 'history/read': return this.extension('history', method, params);
      case 'goal/set': return this.extension('goalSet', method, params);
      case 'goal/clear': return this.extension('goalClear', method, params);
      case 'compact/start': return this.extension('compact', method, params);
      case 'review/start': return this.submitReview(params as AhpRequestMap['review/start']) as Promise<AhpResultMap[M]>;
      case 'interaction/respond': case 'interaction/cancel': throw new HarnessSdkError('INTERACTION_EXPIRED');
    }
    return result as AhpResultMap[M];
  }
  /**
   * Share one cleanup promise across calls. Mark closed before attempting every retained terminal
   * release and optional native close; clear local handles and reject aggregated release failures.
   * OutputSession.dispose awaits this for normal teardown and late attachment cleanup.
   */
  async dispose(): Promise<void> {
    return this.releasing ??= (async () => {
      this.closed = true;
      const operations: Promise<unknown>[] = [...this.terminals].map(terminalId => Promise.resolve().then(() => this.adapter.options.terminal?.releaseTerminal({ sessionId: this.nativeId, terminalId })));
      if (!this.nativeClosed && this.adapter.connected && this.adapter.nativeCapabilities.sessionCapabilities?.close != null) operations.push(this.adapter.call('session/close', { sessionId: this.nativeId }));
      const results = await Promise.allSettled(operations); this.terminals.clear(); this.nativeMappers.clear();
      const failures = results.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
      if (failures.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'ACP resources were not fully released', false, true, { errors: failures.map(() => ({ code: 'ACP_RELEASE_FAILED' })) });
    })();
  }
  // Native lifecycle tracks turn IDs and a separate mapper per turn.
  private readonly nativeMappers = new Map<string, AcpUpdateMapper>();
  private readonly nativeStartedTurnIds = new Set<string>();

  // Standard ACP and legacy extensions share one turn. activeTurn can exist
  // before a start notification; standardTurnStarted marks start handling,
  // not completed submission binding.
  private standardTurnStarted = false;
  private standardSubmissionId?: string;
  /** Standard/legacy lane identity; v2 executions are tracked independently. */
  activeTurn: string | undefined;
  private readonly mapper: AcpUpdateMapper;

  private releasing?: Promise<void>;
  private nativeClosed = false;
  /** Native identity assigned by openSession, including early update correlation. */
  nativeId = '';
  /** While resume/load is pending, historical updates are captured instead of published. */
  hydrating = false;
  /** Bounded historical updates delivered to onLoadSnapshot after opening. */
  readonly loadedSnapshot: JsonObject[] = [];
  /** Successfully created terminal IDs awaiting explicit or disposal release. */
  readonly terminals = new Set<string>();
  /** Session-local negotiated capabilities, refreshed by native configuration and extension failures. */
  readonly capabilities: Capabilities;
  private config: JsonObject = {};
  private configKeys = new Map<string, Record<string, unknown>>();
  private configurationData: Record<string, unknown> = {};
  private capabilityRevision = 1;
  private sessionTitle?: string | null;
  private closed = false;
  private snapshotBytes = 0;
  /** Dispatch a legacy review while reserving the single execution lane; return dispatch, not completion.
   * Native start notifications establish binding. Definite pre-start rejection releases admission;
   * unknown outcome retains it, and method-not-found withdraws review capability before rejecting. */
  private async submitReview(params: AhpRequestMap['review/start']): Promise<AhpResultMap['review/start']> {
    const method = this.adapter.extension.methods.review; if (!method) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    this.beginStandardSubmission(params.submissionId);
    try {
      await this.adapter.call(method, { ...params, sessionId: this.nativeId, turnId: this.activeTurn });
      // The legacy extension has no revised input receipt. Only its native
      // lifecycle notification can associate the review with an execution.
      return { submissionId: params.submissionId, disposition: 'dispatched' };
    } catch (cause) {
      const error = errorFromNative(cause, 'ACP_REVIEW_REJECTED');
      if (!this.standardTurnStarted && !error.outcomeUnknown) { this.activeTurn = undefined; this.standardSubmissionId = undefined; }
      if (error.code === 'CAPABILITY_UNSUPPORTED') {
        delete this.adapter.extension.methods.review; this.capabilities.review = false;
        await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
      }
      throw error;
    }
  }
  /** Reserve the uncorrelated ACP lane before review or prompt dispatch; reject overlapping submissions. */
  private beginStandardSubmission(submissionId: string): string {
    if (this.activeTurn) throw new HarnessSdkError('NATIVE_CORRELATION_UNSUPPORTED');
    this.activeTurn = randomUUID();
    this.standardSubmissionId = submissionId;
    this.standardTurnStarted = false;
    this.mapper.reset();
    return this.activeTurn;
  }
  /** Release only this prompt's lane: terminal observers may already have admitted its successor. */
  private releaseStandardTurn(turnId: string): void {
    if (this.activeTurn !== turnId) return;
    this.activeTurn = undefined;
    this.standardSubmissionId = undefined;
    this.standardTurnStarted = false;
  }
  /** Reject closed/unsupported delivery before choosing negotiated native correlation or the single standard ACP lane. */
  private async submitInput(start: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    if (start.delivery !== 'native') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    return this.adapter.extension.nativeLifecycle ? this.submitCorrelatedInput(start) : this.submitStandardInput(start);
  }
  /** Return the peer's validated acceptance; v2 lifecycle notifications independently bind and complete turns. */
  private async submitCorrelatedInput(start: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    try {
      const result = record(await this.adapter.agent.request('session/prompt', { sessionId: this.nativeId, prompt: input(start.input), _meta: { ahp: { version: 2, submissionId: start.submissionId } } }));
      const value = record(record(result._meta).ahp).acceptance;
      assertDefinition<import('@anureo/protocol').SubmissionAcceptance>('SubmissionAcceptance', value);
      return value;
    } catch (cause) { throw errorFromNative(cause, 'ACP_INPUT_REJECTED'); }
  }
  /** Await the uncorrelated prompt's terminal response and publish mapped completion before returning acceptance. */
  private async submitStandardInput(start: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    // Standard ACP has no per-execution correlation. It can safely expose only
    // one outstanding prompt; this is a backend-specific evidence limitation.
    const turnId = this.beginStandardSubmission(start.submissionId);
    try {
      const completed = await this.adapter.agent.request('session/prompt', { sessionId: this.nativeId, prompt: input(start.input),
        ...(Object.keys(this.adapter.extension.methods).length ? { _meta: { ahp: { version: 1, turnId } } } : {}) });
      await this.ensureStandardStarted(); await this.mapper.complete();
      const outcome = stopOutcome(completed.stopReason);
      if (outcome.notice) await this.sink.emit({ type: 'notice', payload: { severity: 'warning', code: outcome.notice.code, message: outcome.notice.message } }, { turnId });
      // A result observer can immediately submit again after terminal publication.
      // Release native admission first, and never let this prompt's finally clear its successor.
      this.releaseStandardTurn(turnId);
      await this.sink.emit({ type: 'turn/completed', payload: { turnId, status: outcome.status } });
      return { submissionId: start.submissionId, accepted: true, disposition: 'started', turnId };
    } catch (cause) {
      const error = errorFromNative(cause, 'ACP_INPUT_REJECTED');
      if (this.standardTurnStarted) {
        if (error.outcomeUnknown) await this.sink.fail(error);
        else await this.sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: { code: error.code, message: error.code, retryable: false, outcomeUnknown: false } } });
      }
      throw error;
    } finally { this.releaseStandardTurn(turnId); }
  }
  /** Dispatch a negotiated extension, enrich history tool file changes, and validate the native result.
   * Method-not-found withdraws the affected live capability and publishes state before rejecting. */
  private async extension<M extends SessionMethod>(key: ExtensionKey, method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    const nativeMethod = this.adapter.extension.methods[key]; if (!nativeMethod) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    try {
      let result = await this.adapter.call(nativeMethod, { ...params, sessionId: this.nativeId });
      if (key === 'history' && result && typeof result === 'object' && Array.isArray(record(result).items)) {
        const page = record(result)
        result = { ...page, items: (page.items as unknown[]).map(entry => {
          const row = record(entry), item = record(row.item)
          return item.type === 'toolCall' && item.fileChanges === undefined && Array.isArray(item.output) ? { ...row, item: { ...item, fileChanges: acpFileChanges(item.output) } } : entry
        }) }
      }
      assertResult(method, result); return result;
    } catch (error) {
      if (error instanceof HarnessSdkError && error.code === 'CAPABILITY_UNSUPPORTED') {
        delete this.adapter.extension.methods[key];
        if (key === 'steer') delete this.capabilities.input!.steer;
        if (key === 'history') this.capabilities.session!.history = false;
        if (key === 'revert') this.capabilities.session!.revert = [];
        if (key === 'compact') this.capabilities.compact = false;
        if (key === 'review') this.capabilities.review = false;
        if (key === 'goalSet' || key === 'goalClear') this.capabilities.goal!.actions = this.capabilities.goal!.actions?.filter((action) => action !== (key === 'goalSet' ? 'set' : 'clear'));
        await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
      }
      throw error;
    }
  }
}
/** Create an ACP adapter without starting I/O. Pass it to createClient for negotiation and owned cleanup,
 * or initialize/open/dispose it directly in that order; connect takes precedence over command. */
export function createAcpAdapter(options: AcpAdapterOptions): AcpAdapter { return new AcpAdapter(options); }

/** DSH process preset options plus the same injected ports, transport and policy hooks as AcpAdapterOptions. */
export interface DshAcpOptions extends Omit<AcpAdapterOptions, 'command' | 'args'> {
  /** `dsh` executable; defaults to `dsh` on PATH. */
  command?: string;
  /** Profile under `$DSH_HOME/profiles`; defaults to `acp`. */
  profile?: string;
  /** Overrides `$DSH_HOME`; defaults to the env var, then `~/.dsh`. */
  dshHome?: string;
  /** When true, overrides autoRespondPermission with allow-once; defaults to false. Intended for unattended hosts. */
  autoApprove?: boolean;
}

/**
 * Preset for `dsh --profile acp`: pure standard ACP v1, persistent sessions,
 * stdio + Streamable HTTP MCP, `session/resume` and `session/close`.
 *
 * DSH needs Node.js >= 24.9 and a `$DSH_HOME` with provider credentials; a wrong
 * runtime exits before `initialize`, so the retained stderr tail carries startup diagnostics.
 * Defaults to a 120-second native request wait and 200 stderr lines; options can override them.
 * Explicit env.DSH_HOME overrides dshHome; true autoApprove overrides autoRespondPermission.
 * Construction performs no I/O; the resulting adapter has the same cleanup requirements as createAcpAdapter.
 */
export function createDshAcpAdapter(options: DshAcpOptions = {}): AcpAdapter {
  const { dshHome, profile = 'acp', autoApprove = false, ...rest } = options;
  return createAcpAdapter({
    stderrTailLines: 200,
    requestTimeoutMs: 120_000,
    ...rest,
    command: rest.command ?? 'dsh',
    args: ['--profile', profile],
    env: { ...process.env, DSH_HOME: dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), ...rest.env },
    ...(autoApprove ? { autoRespondPermission: 'allow-once' as const } : {}),
  });
}
type Deferred = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
/** Track native interaction-response delivery separately from the response value; interaction awaits write acknowledgment. */
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
/** Normalize native failures for adapter requests without exposing provider messages/data.
 * Preserve SDK errors, map known JSON-RPC codes, and treat other failures as a lost connection with unknown outcome. */
function errorFromNative(error: unknown, fallback = 'ACP_REQUEST_FAILED'): HarnessSdkError {
  if (error instanceof HarnessSdkError) return error;
  if (error instanceof acp.RequestError) {
    let code: string;
    if (error.code === -32601) {
      code = 'CAPABILITY_UNSUPPORTED';
    } else if (error.code === -32602) {
      code = 'INVALID_PARAMS';
    } else if (error.code === -32000) {
      code = 'AUTH_REQUIRED';
    } else if (error.code === -32002) {
      code = 'RESOURCE_NOT_FOUND';
    } else {
      code = fallback;
    }
    return new HarnessSdkError(code, code, false, false, { nativeCode: error.code });
  }
  return new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP connection closed', false, true);
}
type ExtensionKey = 'fork' | 'revert' | 'steer' | 'history' | 'goalSet' | 'goalClear' | 'compact' | 'review';
interface Extensions { methods: Partial<Record<ExtensionKey, string>>; fork: Array<'before' | 'through'>; revert: Array<'conversation' | 'files' | 'both'>; subagents: boolean; instructions: boolean; userInput: boolean; dynamicTool: boolean; nativeLifecycle?: boolean }
/** Accept only compatible AHP extension metadata and private method names before advertising optional capabilities. */
function extensions(response: unknown): Extensions {
  const extension = record(record(record(response)._meta).ahp);
  const methods: Extensions['methods'] = {};
  const result: Extensions = { methods, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  if (extension.version !== 1 && !(extension.version === 2 && extension.turnCorrelation === true)) return result;
  result.nativeLifecycle = extension.version === 2 && extension.turnCorrelation === true;
  const names = record(extension.methods);
  for (const key of ['fork', 'revert', 'steer', 'history', 'goalSet', 'goalClear', 'compact', 'review'] as ExtensionKey[]) {
    const name = names[key]; if (typeof name === 'string' && /^_[a-zA-Z0-9/_.-]+$/.test(name)) methods[key] = name;
  }
  if (methods.fork && Array.isArray(extension.fork)) result.fork = extension.fork.filter((value): value is 'before' | 'through' => value === 'before' || value === 'through');
  if (methods.revert && Array.isArray(extension.revert)) result.revert = extension.revert.filter((value): value is 'conversation' | 'files' | 'both' => ['conversation', 'files', 'both'].includes(String(value)));
  result.subagents = extension.subagents === true; result.instructions = extension.instructions === true;
  const requests = record(extension.clientRequests);
  result.userInput = requests.userInput === '_ahp/user_input'; result.dynamicTool = requests.dynamicTool === '_ahp/dynamic_tool';
  return result;
}
/** Spawn a stdio ACP channel with independent incoming/outgoing frame limits and redacted stderr capture.
 * The adapter owns the returned channel and must dispose it; stderr draining continues independently of protocol reads. */
async function processStream(options: AcpAdapterOptions): Promise<AcpChannel> {
  if (!options.command) throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'An ACP executable or stream factory is required');
  const child: HarnessProcess = await spawnHarnessProcess({ command: options.command, args: options.args, cwd: options.cwd, env: options.env });
  const iterator = child.stdout[Symbol.asyncIterator]();
  const checkIncoming = frameGuard(options, 'ACP frame exceeds its limit');
  const checkOutgoing = frameGuard(options, 'ACP outgoing frame exceeds its limit');
  const incoming = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await iterator.next();
        if (value.done) { controller.close(); return; }
        checkIncoming(value.value);
        controller.enqueue(value.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  });
  const outgoing = new WritableStream<Uint8Array>({ write: (chunk) => {
    checkOutgoing(chunk);
    return child.write(chunk);
  }, close: () => child.closeInput() });
  const tail = captureStderr(child, options);
  return { stream: acp.ndJsonStream(outgoing, incoming), dispose: () => child.dispose(), diagnostics: () => tail.text() };
}

/** Count one direction's newline-delimited frames across chunks; fail before forwarding oversized data. */
function frameGuard(options: AcpAdapterOptions, message: string): (chunk: Uint8Array) => void {
  let lineBytes = 0;
  return (chunk) => {
    for (const byte of chunk) {
      if (byte === 10) lineBytes = 0;
      else if (++lineBytes > (options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', message);
    }
  };
}

/** Drain independently of ACP reads so startup failures retain diagnostics; a closed stderr pipe is harmless. */
function captureStderr(child: HarnessProcess, options: AcpAdapterOptions): StderrTail {
  const tail = new StderrTail(options.stderrTailLines ?? 200, options.onStderr);
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of child.stderr) tail.write(decoder.decode(chunk, { stream: true }));
    } catch { /* a closed stderr pipe is not a protocol failure */ }
    finally { tail.flush(); }
  })();
  return tail;
}

/** Prefer the offered option kind, then a matching legacy option ID; never synthesize an unoffered ID. */
function selectPermissionOption(options: readonly acp.PermissionOption[], decision: AcpPermissionDecision): string | undefined {
  const kind = decision === 'allow-once' ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === kind)?.optionId
    ?? options.find((option) => option.optionId === decision)?.optionId;
}
