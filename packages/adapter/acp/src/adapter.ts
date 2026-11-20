// Negotiates ACP and coordinates native requests, notifications and session lifecycles.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import {
  HarnessSdkError, sdkError, waitForRequest,
  type HarnessAdapter, type BackendSession, type SessionEventSink, type SessionMethod,
} from '@anureo/sdk';
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, assertResult, assertDefinition,
  type Capabilities, type SessionBinding, type SessionOpenParams, type SessionState, type InitializeParams,
  type InitializeResult, type AhpRequestMap, type AhpResultMap, type JsonObject, type InteractionRequested,
  type InteractionResponse, type AhpEventPayload, type GoalState,
} from '@anureo/protocol';
import { AcpUpdateMapper, record, safe, input, mcp, configuration, resolveConfigValue } from './mapping';
import { acpFileChanges } from './file-changes';
import { errorFromNative } from './request-error';
import { extensions, type ExtensionKey, type Extensions } from './extensions';
import type { AcpAdapterOptions, AcpChannel, AcpPermissionDecision, AcpTerminalPort } from './options';
import { processStream } from './stdio';
import { stopOutcome } from './stop';

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
  /** Whether the adapter has installed a connection and has yet to observe transport loss. */
  get connected(): boolean { return !!this.connection && !this.connectionLost; }
  /** Negotiate ACP and return detached AHP capabilities. Calls after a successful handshake reuse its result.
   * Client.initialize awaits this through withStructuredOutput and retains the capabilities for later opens.
   * Overlapping calls share the handshake. Failures release the transport and include a redacted
   * stderr tail when available. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    if (this.info) return this.initializedResult();
    this.initializing ??= Promise.resolve().then(() => this.initializeConnection(params)).finally(() => {
      this.initializing = undefined;
    });
    await this.initializing;
    return this.initializedResult();
  }

  private async initializeConnection(params: InitializeParams): Promise<void> {
    if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
    const channel = this.options.connect ? await this.options.connect() : await processStream(this.options);
    if (this.closing) { await channel.dispose(); throw new HarnessSdkError('RUNTIME_DISPOSED'); }
    try {
      const terminal = this.installConnection(channel);
      const info = await this.call('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: 'anureo-harness-sdk', version: '0.1.0' }, clientCapabilities: {
        fs: { readTextFile: !!this.options.fs?.readTextFile, writeTextFile: !!this.options.fs?.writeTextFile }, terminal: !!terminal,
        session: { configOptions: { boolean: {} }, compaction: {} }, plan: {},
        elicitation: params.clientCapabilities?.interactions?.includes('elicitation') ? { form: {}, url: {} } : undefined,
        _meta: { ahp: { version: 1, clientRequests: ['_ahp/user_input', '_ahp/dynamic_tool'] } },
      } });
      if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
      if (info.protocolVersion !== acp.PROTOCOL_VERSION) throw new HarnessSdkError('PROTOCOL_VERSION_UNSUPPORTED');
      this.info = info;
      this.configureCapabilities();
    } catch (cause) {
      this.info = undefined;
      const error = this.withDiagnostics(sdkError(cause, 'ACP_HANDSHAKE_FAILED', true));
      if (this.channel === channel) await rethrowAfterRelease(error, () => this.releaseTransport());
      throw error;
    }
  }
  /** Issue a native request with requestTimeoutMs (30 seconds by default). Rejections are translated
   * to SDK errors. A timeout ends this wait while native work may continue. The adapter's normal
   * session prompt path uses the native context directly because its reply may be terminal. */
  async call<M extends acp.AgentRequestMethod>(method: M, params: acp.AgentRequestParamsByMethod[M]): Promise<acp.AgentRequestResponsesByMethod[M]>;
  /** Send a custom native method under the same deadline and error translation as standard methods. */
  async call(method: string, params: unknown): Promise<unknown>;
  async call(method: string, params: unknown): Promise<unknown> {
    try { return await waitForRequest(() => this.agent.request(method, params), {}, this.options.requestTimeoutMs ?? 30_000); }
    catch (error) { throw errorFromNative(error); }
  }
  /** Open, resume/load or fork one native session. Opens run one at a time so early updates
   * can establish the native identity. OutputSession.open supplies the sink and awaits the configured
   * backend before attachment. Supply protocol-valid parameters, including the fork source and boundary
   * in fork mode. A timed-out native request holds the open slot until its reply is drained. */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    // Early session/update frames can identify only one opening session at a time.
    const previousOpenCompleted = this.sessionOpenQueueTail;
    let releaseOpenSlot!: () => void;
    this.sessionOpenQueueTail = new Promise((resolve) => { releaseOpenSlot = resolve; });
    await previousOpenCompleted;
    const session = new AcpBackendSession(this, params, sink);
    const finishOpen = () => {
      this.openingSession = undefined;
      releaseOpenSlot();
    };
    try {
      if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
      const request = this.prepareSessionOpen(params, session);
      this.openingSession = session;
      const response = record(await this.requestSessionOpen(request, session, finishOpen));
      this.registerOpenResponse(session, response);
      if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
      session.configure(response);
      session.hydrating = false;
      if (session.loadedSnapshot.length) this.options.onLoadSnapshot?.(session.binding, session.loadedSnapshot);
      const patch = initialConfiguration(params, session.capabilities);
      if (Object.keys(patch).length) await session.setConfiguration(patch);
      const metadata = session.snapshot().metadata;
      if (metadata) await sink.emit({ type: 'session/metadata', payload: metadata });
      if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
      this.savedBindings.set(params.binding.sessionId, session.binding);
      return session;
    } catch (error) {
      if (session.abandonedOpen) throw error;
      return await rethrowAfterRelease(error, () => session.dispose());
    } finally {
      if (!session.abandonedOpen) finishOpen();
    }
  }

  private async requestSessionOpen(
    request: { method: string; params: unknown },
    session: AcpBackendSession,
    finishOpen: () => void,
  ): Promise<unknown> {
    let nativeReply: Promise<unknown> | undefined;
    try {
      return await waitForRequest(() => nativeReply = this.agent.request(request.method, request.params), {}, this.options.requestTimeoutMs ?? 30_000);
    } catch (cause) {
      const error = errorFromNative(cause);
      if (nativeReply && error.code === 'REQUEST_TIMEOUT') {
        // Late updates still identify this open. Drain its reply and release any acquired session.
        session.abandonedOpen = true;
        void nativeReply.then(response => this.registerOpenResponse(session, record(response)))
          .finally(() => session.dispose()).finally(finishOpen).catch(() => {});
      } else if (request.method === this.extension.methods.fork && error.details?.nativeCode === -32601) {
        await this.withdrawExtension('fork');
      }
      throw error;
    }
  }
  /** Attempt all tracked session releases, then close the native connection and channel, and clear indexes.
   * Reject RESOURCE_RELEASE_FAILED after all attempts if any fail. Repeated calls after closing begins
   * return immediately; disposal does not prove native executions stopped. */
  async dispose(): Promise<void> {
    if (this.closing) return; this.closing = true;
    const results = await Promise.allSettled([...this.sessions.values()].map(session => session.dispose()));
    const transport = await Promise.allSettled([this.releaseTransport()]);
    this.sessions.clear(); this.nativeSessions.clear();
    this.savedBindings.clear(); this.retiredNativeIds.clear();
    assertResourcesReleased([...results, ...transport]);
  }

  private async releaseTransport(): Promise<void> {
    const { connection, channel } = this;
    this.connection = undefined;
    this.channel = undefined;
    const error = new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP source connection closed', false, true);
    for (const delivery of this.deliveries.values()) delivery.reject(error);
    this.deliveries.clear();
    const results = await Promise.allSettled([Promise.resolve().then(() => connection?.close()), Promise.resolve().then(() => channel?.dispose())]);
    assertResourcesReleased(results);
  }

  private connection: acp.ClientConnection | undefined;
  private channel: AcpChannel | undefined;
  private info: acp.InitializeResponse | undefined;
  private initializing?: Promise<void>;
  /** AHP session index for acquired backends through the end of their release. */
  readonly sessions = new Map<string, AcpBackendSession>();
  private nativeSessions = new Map<string, AcpBackendSession>();
  private readonly savedBindings = new Map<string, SessionBinding>();
  private readonly retiredNativeIds = new Set<string>();
  private openingSession: AcpBackendSession | undefined;
  private sessionOpenQueueTail = Promise.resolve();
  private readonly deliveries = new Map<acp.JsonRpcId, Deferred>();
  private closing = false;
  private connectionLost = false;
  private sourceFailure?: HarnessSdkError;
  /** Peer-negotiated features. Backend requests can withdraw a method the peer rejects as unsupported. */
  extension: Extensions = { methods: {}, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  /** Negotiated baseline. Each backend clones it before applying session configuration. */
  capabilities: Capabilities = {};

  /** Install initialize's transport and handlers before sending the handshake. When the SDK reports
   * closure, reject outstanding response deliveries and fail live sessions unless disposal is underway. */
  private installConnection(channel: AcpChannel): AcpTerminalPort | undefined {
    this.channel = channel;
    this.connectionLost = false;
    this.sourceFailure = undefined;
    const wrapped = this.wrapStream(channel);
    const { app, terminal } = this.createClientApplication();
    const connection = this.connection = app.connect(wrapped);
    void connection.closed.then(async () => {
      if (this.connection !== connection) return;
      this.connectionLost = true;
      const error = this.withDiagnostics(this.sourceFailure ?? new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP source connection closed', false, true));
      for (const delivery of this.deliveries.values()) delivery.reject(error);
      this.deliveries.clear();
      if (!this.closing) await this.failSessions(error);
    });
    return terminal;
  }

  /** Return detached negotiated capabilities so callers can retain their initialization result. */
  private initializedResult(): InitializeResult {
    return {
      protocolVersion: 1,
      protocolContract: AHP_PROTOCOL_CONTRACT,
      runtime: { name: this.info?.agentInfo?.name ?? 'acp', version: this.info?.agentInfo?.version ?? 'unknown', adapter: 'acp/0.1.0' },
      capabilities: structuredClone(this.capabilities),
    };
  }

  /** Notify currently indexed sessions of observation loss. A rejected sink must not stop fan-out. */
  private failSessions(error: HarnessSdkError): Promise<void[]> {
    return Promise.all([...this.sessions.values()].filter(session => session.acceptsPeerTraffic)
      .map(session => session.sink.fail(error).catch(() => {})));
  }

  /** Build openSession's native request. For resume/load, register the known ID and begin snapshot
   * capture before dispatch so updates received before the reply reach the correct backend. */
  private prepareSessionOpen(params: SessionOpenParams, session: AcpBackendSession): { method: string; params: unknown } {
    if (this.sessions.has(params.binding.sessionId)) throw new HarnessSdkError('SESSION_ALREADY_OPEN');
    if (params.instructions && !this.extension.instructions) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'ACP peer did not negotiate instructions');
    const common = {
      cwd: params.cwd,
      mcpServers: mcp(params.mcpServers),
      ...(params.instructions ? { _meta: { ahp: { version: 1, instructions: params.instructions } } } : {}),
    };
    if (params.mode === 'new') return { method: 'session/new', params: common };
    if (params.mode === 'resume') {
      const nativeRef = params.binding.nativeRef;
      if (!nativeRef || nativeRef.provider !== 'acp') throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
      if (this.nativeSessions.has(nativeRef.value)) throw new HarnessSdkError('SESSION_ALREADY_OPEN');
      session.nativeId = nativeRef.value;
      this.retiredNativeIds.delete(session.nativeId);
      this.nativeSessions.set(session.nativeId, session);
      session.hydrating = true;
      const method = this.nativeCapabilities.sessionCapabilities?.resume != null ? 'session/resume' : 'session/load';
      return { method, params: { ...common, sessionId: session.nativeId } };
    }

    // The session/open schema requires fork data for this mode. The generated type leaves it optional.
    const fork = params.fork;
    const nativeRef = fork?.nativeRef ?? this.savedBindings.get(fork!.sourceSessionId)?.nativeRef;
    const method = this.extension.methods.fork;
    if (!nativeRef || !method) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    return { method, params: { ...common, sessionId: nativeRef.value, boundary: fork!.boundary } };
  }

  /** Confirm identity and take ownership before configuration and host callbacks. */
  private registerOpenResponse(session: AcpBackendSession, response: Record<string, unknown>): void {
    if (typeof response.sessionId === 'string') {
      if (session.nativeId && response.sessionId !== session.nativeId) throw new HarnessSdkError('ACP_PROTOCOL_ERROR', 'ACP session identity changed while opening');
      session.nativeId = response.sessionId;
    }
    if (!session.nativeId) throw new HarnessSdkError('ACP_PROTOCOL_ERROR', 'ACP session response lacked an identity');
    const owner = this.nativeSessions.get(session.nativeId);
    if (owner && owner !== session) throw new HarnessSdkError('SESSION_ALREADY_OPEN');
    session.nativeAcquired = true;
    this.retiredNativeIds.delete(session.nativeId);
    this.nativeSessions.set(session.nativeId, session);
    this.sessions.set(session.binding.sessionId, session);
  }

  /** Remove only this backend's routes. Successful opens retain their separate bindings for fork lookup. */
  retireSession(session: AcpBackendSession): void {
    const { sessionId } = session.binding;
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    if (this.nativeSessions.get(session.nativeId) === session) {
      this.nativeSessions.delete(session.nativeId);
      if (!this.closing) this.retiredNativeIds.add(session.nativeId);
    }
  }

  /** Withdraw a peer-rejected method from dispatch and every advertised session snapshot. */
  async withdrawExtension(key: ExtensionKey, source: 'ahp' | 'neutral' = 'ahp'): Promise<void> {
    const action = goalAction(key);
    if (source === 'neutral') {
      if (!action || !this.extension.goal?.actions.includes(action)) return;
      this.extension.goal.actions = this.extension.goal.actions.filter(candidate => candidate !== action);
    } else {
      if (!this.extension.methods[key]) return;
      delete this.extension.methods[key];
    }
    // A goal action stays advertised while the other source (AHP method or neutral control) still serves it.
    if (!action || !goalAvailable(this.extension, action)) removeExtensionCapability(this.capabilities, key);
    const sessions = new Set(this.sessions.values());
    if (this.openingSession) sessions.add(this.openingSession);
    await Promise.allSettled([...sessions].filter(session => session.acceptsPeerTraffic)
      .map(session => session.withdrawExtension(key)));
  }

  /** Attach redacted channel diagnostics before initialize rejects a handshake failure or the
   * SDK closure handler reports observation loss. Preserve the error when no tail is available. */
  private withDiagnostics(error: HarnessSdkError): HarnessSdkError {
    let tail: string | undefined;
    try { tail = this.channel?.diagnostics?.(); }
    catch { return error; }
    if (!tail) return error;
    return new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown, {
      ...error.details,
      diagnostics: { stderrTail: tail },
    });
  }
  /** Resolve the native ID for SDK callbacks and routeNotification. Only a session/update may
   * identify the current opening backend. Reject other unknown IDs as invalid native parameters. */
  private backend(nativeId: string, source: 'request' | 'update' | 'notification' = 'request'): AcpBackendSession {
    const existing = this.nativeSessions.get(nativeId);
    if (existing && (source !== 'request' || existing.acceptsPeerTraffic)) return existing;
    if (source === 'update' && !this.retiredNativeIds.has(nativeId) && this.openingSession && !this.openingSession.disposed
      && (!this.openingSession.nativeId || this.openingSession.nativeId === nativeId)) {
      this.openingSession.nativeId = nativeId;
      // Index by native ID as soon as a session/update identifies the opening session.
      this.nativeSessions.set(nativeId, this.openingSession);
      return this.openingSession;
    }
    throw new acp.RequestError(-32602, 'Unknown ACP session');
  }

  /** A local observation can close while an already admitted notification is being published. */
  private async publishNotification(session: AcpBackendSession, publish: () => Promise<void>): Promise<void> {
    if (!session.acceptsPeerTraffic) return;
    try { await publish(); }
    catch (error) {
      if (!(error instanceof HarnessSdkError && error.code === 'STREAM_CLOSED')) throw error;
    }
  }
  /** Register a native request with the session sink after establishing standard turn correlation.
   * The sink invokes the responder with an answer or cancellation. Resolve the native response first,
   * but keep the responder pending until wrapStream confirms its write, so settlement cannot claim early delivery. */
  private async interaction<T>(session: AcpBackendSession, requestId: acp.JsonRpcId, request: InteractionRequested, transform: (response: InteractionResponse | null) => T): Promise<T> {
    await session.ensureStandardStarted();
    if (!session.acceptsPeerTraffic) throw new acp.RequestError(-32602, 'Unknown ACP session');
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
    if (!('method' in frame) || 'id' in frame) return 'forward-to-sdk';
    if (frame.method === 'session/update') {
      const value = record(frame.params);
      const nativeId = String(value.sessionId);
      if (this.retiredNativeIds.has(nativeId)) return 'consumed';
      const session = this.backend(nativeId, 'update');
      await this.publishNotification(session, () => session.update(record(value.update)));
      return 'consumed';
    }
    if (frame.method === '_ahp/event' && this.capabilities.extensions?.length) {
      const value = record(frame.params);
      const nativeId = String(value.sessionId);
      if (this.retiredNativeIds.has(nativeId)) return 'consumed';
      const session = this.backend(nativeId, 'notification');
      await this.publishNotification(session, () => this.extension.nativeLifecycle
        ? session.nativeEvent(value.event, value) : session.extensionEvent(value.event, value));
      return 'consumed';
    }
    if (frame.method !== 'elicitation/complete') {
      const scope = record(frame.params).sessionId;
      if (typeof scope === 'string' && this.retiredNativeIds.has(scope)) return 'consumed';
      const recipients = typeof scope === 'string' ? [this.backend(scope, 'notification')] : [...this.sessions.values()];
      for (const session of recipients) await this.publishNotification(session, () =>
        session.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_UNKNOWN_NOTIFICATION', message: 'Unknown ACP notification retained', raw: safe({ method: frame.method, params: frame.params }) } }));
      return 'consumed';
    }
    return 'forward-to-sdk';
  }
  /** Route notifications in read order before forwarding other frames to the SDK. A successful
   * response write acknowledges delivery to the interaction responder. Stream errors fail observation. */
  private wrapStream(channel: AcpChannel): acp.Stream {
    const rawReader = channel.stream.readable.getReader();
    return {
      writable: new WritableStream({ write: async (frame) => {
        const rawWriter = channel.stream.writable.getWriter();
        try {
          await rawWriter.write(frame);
          if (this.channel === channel && 'id' in frame && !('method' in frame)) { this.deliveries.get(frame.id)?.resolve(); this.deliveries.delete(frame.id); }
        } catch (error) {
          if (this.channel === channel) {
            this.connectionLost = true;
            const failure = this.sourceFailure = sdkError(error, 'ACP_CONNECTION_CLOSED', true);
            for (const delivery of this.deliveries.values()) delivery.reject(failure);
            void this.failSessions(failure);
          }
          throw error;
        } finally {
          rawWriter.releaseLock();
        }
      }, close: () => channel.stream.writable.close(), abort: (reason) => channel.stream.writable.abort(reason) }),
      readable: new ReadableStream({ pull: async (controller) => {
        try {
          for (;;) {
            const next = await rawReader.read();
            if (next.done || this.channel !== channel) { rawReader.releaseLock(); controller.close(); return; }
            const frame = next.value;
            if (await this.routeNotification(frame) === 'consumed') continue;
            controller.enqueue(frame); return;
          }
        } catch (error) {
          rawReader.releaseLock();
          if (this.channel === channel) {
            this.connectionLost = true;
            const failure = this.sourceFailure = sdkError(error, 'ACP_CONNECTION_CLOSED', true);
            void this.failSessions(failure);
          }
          controller.error(error);
        }
      }, cancel: async (reason) => {
        try { await rawReader.cancel(reason); }
        finally { rawReader.releaseLock(); }
      } }),
    };
  }
  /** Configure the ACP SDK callbacks for installConnection before initialize advertises their
   * capabilities. The SDK invokes them for incoming peer requests and notifications. */
  private createClientApplication(): { app: acp.ClientApp; terminal: AcpTerminalPort | undefined } {
    const app = acp.client({ name: 'anureo-harness-sdk-acp' })
      .onRequest('session/request_permission', (context) => this.requestPermission(context))
      .onRequest('elicitation/create', (context) => this.requestElicitation(context))
      .onNotification('elicitation/complete', async (context) => {
        for (const session of [...this.sessions.values()]) await this.publishNotification(session, () =>
          session.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_ELICITATION_COMPLETE', message: 'External authorization completed', raw: safe(context.params) } }));
      })
      .onRequest('_ahp/user_input', (value: unknown) => record(value), (context) => this.extensionInteraction('userInput', context.requestId, context.params))
      .onRequest('_ahp/dynamic_tool', (value: unknown) => record(value), (context) => this.extensionInteraction('dynamicTool', context.requestId, context.params));
    const terminal = this.registerPorts(app);
    return { app, terminal };
  }
  /** Handle the ACP SDK's elicitation callback. Cancel unsupported scopes or modes immediately.
   * For a session request, keep URL details in the private payload and return the sink's answer to the peer. */
  private requestElicitation(context: acp.ClientRequestContext<acp.CreateElicitationRequest>): acp.CreateElicitationResponse | Promise<acp.CreateElicitationResponse> {
    const native = record(context.params);
    if (typeof native.sessionId !== 'string' || !['form', 'url'].includes(String(native.mode))) return { action: 'cancel' };
    const session = this.backend(native.sessionId);
    const request: InteractionRequested = {
      kind: 'elicitation',
      interactionId: `acp-elicitation:${String(context.requestId)}`,
      turnId: session.activeTurn,
      mode: native.mode as 'form' | 'url',
      message: String(native.message ?? ''),
      ...(native.mode === 'form'
        ? { schema: safe(native.requestedSchema) as JsonObject }
        : { privatePayload: { url: String(native.url ?? ''), elicitationId: String(native.elicitationId ?? '') } }),
    };
    return this.interaction<acp.CreateElicitationResponse>(session, context.requestId, request, (response) => {
      if (response?.kind !== 'elicitation') return { action: 'cancel' };
      return {
        action: response.action,
        ...(response.content ? { content: response.content as Record<string, string | number | boolean | string[]> } : {}),
      };
    });
  }

  /** Answer the ACP SDK's permission request with an offered option after publishing the policy
   * notice. If policy declines or has no matching option, await the interactive session response. */
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
      if (!session.acceptsPeerTraffic) throw new acp.RequestError(-32602, 'Unknown ACP session');
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
  /** Register the filesystem and terminal callbacks supplied by the host. The ACP SDK handler
   * validates session and terminal ownership before returning the port's response to the peer. */
  private registerPorts(app: acp.ClientApp): AcpTerminalPort | undefined {
    if (this.options.fs?.readTextFile) app.onRequest('fs/read_text_file', (ctx) => { this.backend(ctx.params.sessionId); return this.options.fs!.readTextFile!(ctx.params); });
    if (this.options.fs?.writeTextFile) app.onRequest('fs/write_text_file', (ctx) => { this.backend(ctx.params.sessionId); return this.options.fs!.writeTextFile!(ctx.params); });
    const terminal = this.options.terminal;
    if (terminal) {
      app.onRequest('terminal/create', (ctx) => this.backend(ctx.params.sessionId).createTerminal(terminal, ctx.params));
      app.onRequest('terminal/output', (ctx) => { this.backend(ctx.params.sessionId).requireTerminal(ctx.params.terminalId); return terminal.terminalOutput(ctx.params); });
      app.onRequest('terminal/wait_for_exit', (ctx) => { this.backend(ctx.params.sessionId).requireTerminal(ctx.params.terminalId); return terminal.waitForTerminalExit(ctx.params); });
      app.onRequest('terminal/kill', (ctx) => { this.backend(ctx.params.sessionId).requireTerminal(ctx.params.terminalId); return terminal.killTerminal(ctx.params); });
      app.onRequest('terminal/release', async (ctx) => { const session = this.backend(ctx.params.sessionId); session.requireTerminal(ctx.params.terminalId); const result = await terminal.releaseTerminal(ctx.params); session.terminals.delete(ctx.params.terminalId); return result; });
    }
    return terminal;
  }
  /** After initialize validates the peer version, store the baseline capability projection and
   * negotiated extension methods. Session construction clones the baseline before applying overrides. */
  private configureCapabilities(): void {
    this.extension = extensions(this.info);
    const native = this.nativeCapabilities;
    this.capabilities = {
      session: { resume: native.loadSession === true || native.sessionCapabilities?.resume != null, fork: this.extension.fork, revert: this.extension.revert, history: !!this.extension.methods.history },
      input: { delivery: ['native'], interrupt: { targets: ['session'], reportsPendingInputs: false } },
      turn: { inputModalities: ['text', ...(native.promptCapabilities?.image ? ['image' as const] : []), ...(native.promptCapabilities?.embeddedContext ? ['file' as const] : [])] },
      interactions: ['approval', 'elicitation', ...(this.extension.userInput ? ['userInput' as const] : []), ...(this.extension.dynamicTool ? ['dynamicTool' as const] : [])],
      goal: { actions: (['set', 'clear'] as const).filter(action => goalAvailable(this.extension, action)) },
      compact: !!this.extension.methods.compact, review: !this.extension.nativeLifecycle && !!this.extension.methods.review, subagents: { events: this.extension.subagents ? 'nested' : 'none' },
      mcp: { stdio: true, http: native.mcpCapabilities?.http === true, elicitation: ['form', 'url'] }, config: { options: [] },
      extensions: this.extension.version && (this.extension.nativeLifecycle || Object.keys(this.extension.methods).length || this.extension.subagents || this.extension.userInput || this.extension.dynamicTool)
        ? [{ name: 'x-acp/ahp', version: String(this.extension.version) }] : [],
    };
  }
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
  /** Create session-local projection and configuration state. AcpAdapter.openSession assigns the
   * native identity. The mapper reads this backend's current turn and applies peer metadata/config
   * updates through configure before publishing snapshots to the supplied sink. */
  constructor(readonly adapter: AcpAdapter, private readonly params: SessionOpenParams, readonly sink: SessionEventSink) {
    this.capabilities = structuredClone(adapter.capabilities);
    this.mapper = new AcpUpdateMapper(sink, () => this.activeTurn, () => this.snapshot(), (data) => this.configure(data), adapter.extension.subagents);
  }
  /** Attach the native ACP identity to the requested AHP binding; identity is established before openSession returns. */
  get binding(): SessionBinding { return { ...this.params.binding, nativeRef: { provider: 'acp', value: this.nativeId } }; }
  /** Expose the current attachment snapshot to OutputSession.open; collection fields are session-owned. */
  get state(): SessionState { return this.snapshot(); }
  /** Build state for attachment and sink publication. Configuration and capabilities are session-owned references. */
  snapshot(): SessionState {
    return {
      ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}),
      binding: this.binding,
      config: this.config,
      capabilities: this.capabilities,
      capabilityRevision: this.capabilityRevision,
      ...(this.goalState ? { goal: structuredClone(this.goalState) } : {}),
      status: this.activeTurn ? 'running' : 'ready',
      activeTurnIds: [...this.nativeStartedTurnIds, ...(this.standardTurnStarted && this.activeTurn ? [this.activeTurn] : [])],
    };
  }
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
  /** Publish a standard turn start before update, interaction registration or terminal prompt handling
   * continues. Bind after start publication, setting the guard before either await to prevent duplicate starts. */
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
    if (this.hydrating) {
      this.captureLoadedUpdate(data);
      return;
    }
    if (data.sessionUpdate === 'session_info_update' && Object.hasOwn(record(data._meta), 'goal')) {
      await this.publishGoal(neutralGoalState(record(data._meta).goal));
    }
    if (this.adapter.extension.nativeLifecycle) {
      const native = record(record(data._meta).ahp);
      const turnId = typeof native.turnId === 'string' ? native.turnId : undefined;
      if (turnId) {
        await this.correlatedMapper(turnId).update(data);
        return;
      }
      if (!isSessionUpdate(data, 'correlated')) throw new HarnessSdkError('NATIVE_CORRELATION_UNSUPPORTED');
    }
    if (!isSessionUpdate(data)) await this.ensureStandardStarted();
    await this.mapper.update(data);
  }
  /** Track the create before invoking the host so disposal can release its eventual terminal. */
  async createTerminal(terminal: AcpTerminalPort, params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse> {
    if (!this.acceptsPeerTraffic) throw new acp.RequestError(-32602, 'Unknown ACP session');
    const creation = Promise.resolve().then(() => terminal.createTerminal(params)).then(result => {
      this.terminals.add(result.terminalId);
      return result;
    });
    this.terminalCreations.add(creation);
    try { return await creation; }
    finally { this.terminalCreations.delete(creation); }
  }
  /** Reject peer operations on terminal IDs not successfully created for this session or already released. */
  requireTerminal(id: string): void { if (!this.terminals.has(id)) throw new acp.RequestError(-32602, 'Terminal does not belong to this session'); }
  /** Apply a configuration patch in key order and return the resulting session state. Reject unknown
   * keys before dispatch. AcpAdapter.openSession awaits initial overrides before attachment, and execute
   * returns this state for host patches. Publish each confirmed field. A later native failure rejects
   * with CONFIG_PARTIAL and the confirmed keys, whose changes remain applied. */
  async setConfiguration(patch: JsonObject): Promise<SessionState> {
    for (const key of Object.keys(patch)) if (!this.configKeys.has(key)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const appliedKeys: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      try {
        const option = this.configKeys.get(key);
        if (!option) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'ACP configuration option is no longer available');
        if (option.type === 'mode') {
          const modeId = String(value);
          await this.adapter.call('session/set_mode', { sessionId: this.nativeId, modeId });
          this.configure({ currentModeId: modeId });
        } else {
          const response = await this.adapter.call('session/set_config_option', { sessionId: this.nativeId, configId: String(option.id), type: option.type === 'boolean' ? 'boolean' : 'select', value });
          this.configure(record(response));
        }
      } catch (cause) {
        const error = errorFromNative(cause);
        if (!appliedKeys.length) throw error;
        throw new HarnessSdkError('CONFIG_PARTIAL', 'Some configuration changes were applied', error.retryable, error.outcomeUnknown,
          { appliedKeys, failedKey: key, cause: { code: error.code } });
      }
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
      case 'goal/set': return this.goal('set', method, params);
      case 'goal/clear': return this.goal('clear', method, params);
      case 'compact/start': return this.extension('compact', method, params);
      case 'review/start': return this.submitReview(params as AhpRequestMap['review/start']) as Promise<AhpResultMap[M]>;
      case 'interaction/respond': case 'interaction/cancel': throw new HarnessSdkError('INTERACTION_EXPIRED');
    }
    return result as AhpResultMap[M];
  }
  /**
   * Share one cleanup promise across calls. Mark closed before attempting every retained terminal
   * release and optional native close; clear local handles and reject aggregated release failures.
   * OutputSession.dispose awaits this during teardown. OutputSession.open also awaits it when a
   * backend arrives after teardown, and AcpAdapter.dispose calls it for every tracked backend.
   */
  async dispose(): Promise<void> {
    return this.releasing ??= (async () => {
      this.closed = true;
      try {
        await Promise.allSettled(this.terminalCreations);
        const operations: Promise<unknown>[] = [...this.terminals].map(terminalId => Promise.resolve().then(() => this.adapter.options.terminal?.releaseTerminal({ sessionId: this.nativeId, terminalId })));
        if (this.nativeAcquired && !this.nativeClosed && this.adapter.connected && this.adapter.nativeCapabilities.sessionCapabilities?.close != null) {
          operations.push(this.adapter.call('session/close', { sessionId: this.nativeId }));
        }
        assertResourcesReleased(await Promise.allSettled(operations));
      } finally {
        this.terminals.clear();
        this.nativeMappers.clear();
        this.adapter.retireSession(this);
      }
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
  nativeAcquired = false;
  abandonedOpen = false;
  get disposed(): boolean { return this.closed; }
  get acceptsPeerTraffic(): boolean { return !this.disposed && !this.abandonedOpen; }
  /** Native identity assigned by openSession, including early update correlation. */
  nativeId = '';
  /** While resume/load is pending, historical updates are captured instead of published. */
  hydrating = false;
  /** Bounded historical updates delivered to onLoadSnapshot after opening. */
  readonly loadedSnapshot: JsonObject[] = [];
  /** Successfully created terminal IDs awaiting explicit or disposal release. */
  readonly terminals = new Set<string>();
  private readonly terminalCreations = new Set<Promise<acp.CreateTerminalResponse>>();
  /** Session-local negotiated capabilities, refreshed by native configuration and extension failures. */
  readonly capabilities: Capabilities;
  private config: JsonObject = {};
  private configKeys = new Map<string, Record<string, unknown>>();
  private configurationData: Record<string, unknown> = {};
  private capabilityRevision = 1;
  private sessionTitle?: string | null;
  /** Latest goal published by the peer's neutral `_meta.goal` snapshots or confirmed by a goal request. */
  private goalState?: GoalState;
  private closed = false;
  private snapshotBytes = 0;
  /** Save pre-attachment updates for the host snapshot callback. Capture title as attachment metadata
   * and bound the remaining history by count and estimated size before retaining its safe projection. */
  private captureLoadedUpdate(data: Record<string, unknown>): void {
    if (data.sessionUpdate === 'session_info_update') {
      if (typeof data.title === 'string' || data.title === null) this.sessionTitle = data.title;
      // session/load republishes the authoritative goal; it overwrites any cached value.
      const meta = record(data._meta);
      if (Object.hasOwn(meta, 'goal')) this.goalState = neutralGoalState(meta.goal);
      return;
    }
    this.snapshotBytes += JSON.stringify(data).length * 3;
    if (this.loadedSnapshot.length >= 2048 || this.snapshotBytes > 16 * 1024 * 1024) {
      throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'ACP load snapshot exceeds its limit');
    }
    this.loadedSnapshot.push(safe(data) as JsonObject);
  }

  /** Return the per-turn mapper used by update. A native start must have been observed before
   * projection. nativeEvent flushes and removes the mapper on completion. */
  private correlatedMapper(turnId: string): AcpUpdateMapper {
    if (!this.nativeStartedTurnIds.has(turnId)) throw new HarnessSdkError('PROTOCOL_ERROR', 'ACP update arrived without its execution start');
    let mapper = this.nativeMappers.get(turnId);
    if (!mapper) {
      mapper = new AcpUpdateMapper(this.sink, () => turnId, () => this.snapshot(), value => this.configure(value), this.adapter.extension.subagents);
      this.nativeMappers.set(turnId, mapper);
    }
    return mapper;
  }

  /** Dispatch a legacy review in the single execution lane. The receipt confirms dispatch.
   * Native start notifications establish binding. Definite pre-start rejection releases admission;
   * unknown outcome retains it, and method-not-found withdraws review capability before rejecting. */
  private async submitReview(params: AhpRequestMap['review/start']): Promise<AhpResultMap['review/start']> {
    const method = this.adapter.extension.methods.review;
    if (!method || this.adapter.extension.nativeLifecycle) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    this.beginStandardSubmission(params.submissionId);
    try {
      await this.adapter.call(method, { ...params, sessionId: this.nativeId, turnId: this.activeTurn });
      // The legacy extension has no revised input receipt. Only its native
      // lifecycle notification can associate the review with an execution.
      return { submissionId: params.submissionId, disposition: 'dispatched' };
    } catch (cause) {
      const error = errorFromNative(cause, 'ACP_REVIEW_REJECTED');
      if (!this.standardTurnStarted && !error.outcomeUnknown) { this.activeTurn = undefined; this.standardSubmissionId = undefined; }
      if (error.details?.nativeCode === -32601) await this.adapter.withdrawExtension('review');
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
      if (this.activeTurn === turnId && this.standardTurnStarted) {
        if (error.outcomeUnknown) await this.sink.fail(error);
        else {
          this.releaseStandardTurn(turnId);
          await this.sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: { code: error.code, message: error.code, retryable: false, outcomeUnknown: false } } });
        }
      }
      throw error;
    } finally { this.releaseStandardTurn(turnId); }
  }
  /** Route goal/set and goal/clear to the AHP extension method when the peer advertised one, otherwise to the
   * provider-neutral control method. Neutral snapshots also arrive as session_info_update `_meta.goal`. */
  private async goal<M extends SessionMethod>(action: 'set' | 'clear', method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    const key: ExtensionKey = action === 'set' ? 'goalSet' : 'goalClear';
    if (this.adapter.extension.methods[key]) return this.extension(key, method, params);
    const neutral = this.adapter.extension.goal;
    if (!neutral?.actions.includes(action)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const request: Record<string, unknown> = { sessionId: this.nativeId, action };
    if (action === 'set') {
      const requested = record((params as AhpRequestMap['goal/set']).goal);
      const objective = typeof requested.objective === 'string' ? requested.objective.trim() : '';
      if (!objective) throw new HarnessSdkError('INVALID_PARAMS', 'Goal objective is required');
      request.objective = objective;
      if (requested.tokenBudget !== undefined) request.tokenBudget = requested.tokenBudget;
    }
    try {
      const response = record(await this.adapter.call(neutral.method, request));
      if (!Object.hasOwn(response, 'goal') || (response.goal !== null && typeof response.goal !== 'object')) {
        throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid ACP goal result', false, true);
      }
      const result = neutralGoalState(response.goal);
      assertResult(method, result);
      await this.publishGoal(result);
      return result as AhpResultMap[M];
    } catch (error) {
      if (error instanceof HarnessSdkError && error.details?.nativeCode === -32601) await this.adapter.withdrawExtension(key, 'neutral');
      throw error;
    }
  }
  /** Record the peer's goal and publish it when it changed, so hosts holding session state converge. */
  private async publishGoal(next: GoalState): Promise<void> {
    if (isDeepStrictEqual(this.goalState, next)) return;
    this.goalState = next;
    if (this.nativeAcquired) await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
  }
  /** Dispatch a negotiated extension, enrich history tool file changes, and validate the native result.
   * Method-not-found withdraws the affected live capability and publishes state before rejecting. */
  private async extension<M extends SessionMethod>(key: ExtensionKey, method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    const nativeMethod = this.adapter.extension.methods[key]; if (!nativeMethod) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    try {
      const response = await this.adapter.call(nativeMethod, { ...params, sessionId: this.nativeId });
      const result = key === 'history' ? projectHistoryFileChanges(response) : response;
      try { assertResult(method, result); }
      catch { throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid ACP extension result', false, true); }
      return result;
    } catch (error) {
      if (error instanceof HarnessSdkError && error.details?.nativeCode === -32601) await this.adapter.withdrawExtension(key);
      throw error;
    }
  }

  /** Publish the revised capability with this session's current configuration. */
  async withdrawExtension(key: ExtensionKey): Promise<void> {
    removeExtensionCapability(this.capabilities, key);
    this.capabilityRevision++;
    if (this.nativeAcquired) await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
  }
}

/** Map a goal ExtensionKey to the AHP goal action it serves. */
function goalAction(key: ExtensionKey): 'set' | 'clear' | undefined {
  return key === 'goalSet' ? 'set' : key === 'goalClear' ? 'clear' : undefined;
}
/** Whether the peer currently serves a goal action through an AHP method or the neutral control method. */
function goalAvailable(extension: Extensions, action: 'set' | 'clear'): boolean {
  return !!extension.methods[action === 'set' ? 'goalSet' : 'goalClear'] || !!extension.goal?.actions.includes(action);
}
/** Project a neutral goal snapshot (`null` clears it) onto AHP. A completed goal is no longer pending; every
 * other status, including paused and limited, still owns the session until the user or peer resolves it. */
function neutralGoalState(value: unknown): GoalState {
  const goal = record(value);
  if (!Object.keys(goal).length) return { goal: null, status: 'cleared' };
  return { goal: safe(goal) as JsonObject, status: goal.status === 'complete' ? 'cleared' : 'active' };
}

/** Update the operation's capability on the connection baseline or a session projection. */
function removeExtensionCapability(capabilities: Capabilities, key: ExtensionKey): void {
  switch (key) {
    case 'fork': capabilities.session!.fork = []; break;
    case 'steer': delete capabilities.input!.steer; break;
    case 'history': capabilities.session!.history = false; break;
    case 'revert': capabilities.session!.revert = []; break;
    case 'compact': capabilities.compact = false; break;
    case 'review': capabilities.review = false; break;
    case 'goalSet':
    case 'goalClear': {
      const removedAction = key === 'goalSet' ? 'set' : 'clear';
      const goal = capabilities.goal!;
      goal.actions = goal.actions?.filter(action => action !== removedAction);
      break;
    }
  }
}
/** Create an ACP adapter without starting I/O. Pass it to createClient for negotiation and owned cleanup,
 * or initialize/open/dispose it directly in that order; connect takes precedence over command. */
export function createAcpAdapter(options: AcpAdapterOptions): AcpAdapter { return new AcpAdapter(options); }

/** Check the settled release attempts after both dispose methods clear local ownership.
 * Keep provider errors private while preserving the number of failed releases. */
function assertResourcesReleased(results: PromiseSettledResult<unknown>[]): void {
  const errors = results.filter(result => result.status === 'rejected').map(() => ({ code: 'ACP_RELEASE_FAILED' }));
  if (errors.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'ACP resources were not fully released', false, true, { errors });
}

/** Preserve the setup failure and append only a sanitized cleanup code if release also fails. */
async function rethrowAfterRelease(cause: unknown, release: () => Promise<void>): Promise<never> {
  try { await release(); }
  catch (cleanupFailure) {
    const error = sdkError(cause);
    throw new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown, {
      ...error.details, cleanupErrors: [{ code: sdkError(cleanupFailure).code }],
    });
  }
  throw cause;
}

/** Fill absent tool-call file changes from legacy ACP history output before extension result validation.
 * Preserve explicit file changes and leave malformed page shapes for the result validator. */
function projectHistoryFileChanges(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const page = record(result);
  if (!Array.isArray(page.items)) return result;
  return {
    ...page,
    items: page.items.map((entry: unknown) => {
      const row = record(entry);
      const item = record(row.item);
      if (item.type !== 'toolCall' || item.fileChanges !== undefined || !Array.isArray(item.output)) return entry;
      return { ...row, item: { ...item, fileChanges: acpFileChanges(item.output) } };
    }),
  };
}

/** Build the initial patch after native descriptors arrive. Explicit model and permission mode
 * override matching config keys, and model aliases resolve against the attached session. */
function initialConfiguration(params: SessionOpenParams, capabilities: Capabilities): JsonObject {
  return {
    ...params.config,
    ...(params.model ? { model: resolveConfigValue(capabilities, 'model', params.model) } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
  };
}

/** Identify notifications that do not need turn correlation. v2 can send session-scoped usage,
 * while standard ACP treats a usage notification as evidence of activity in the reserved turn. */
function isSessionUpdate(data: Record<string, unknown>, mode: 'standard' | 'correlated' = 'standard'): boolean {
  switch (String(data.sessionUpdate)) {
    case 'session_info_update':
    case 'config_option_update':
    case 'current_mode_update':
    case 'available_commands_update':
      return true;
    case 'usage_update':
      return mode === 'correlated';
    default:
      return false;
  }
}

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
/** Track native interaction-response delivery separately from the response value; interaction awaits write acknowledgment. */
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}

/** Select an offered one-shot kind, or defer to the interactive path. */
function selectPermissionOption(options: readonly acp.PermissionOption[], decision: AcpPermissionDecision): string | undefined {
  const kind = decision === 'allow-once' ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === kind)?.optionId;
}
