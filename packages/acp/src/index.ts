import { acpFileChanges } from './file-changes';
import * as acp from '@agentclientprotocol/sdk';
import {
  spawnHarnessProcess, HarnessSdkError, waitForRequest,
  type HarnessAdapter, type BackendSession, type SessionEventSink, type SessionMethod, type HarnessProcess,
} from '@anureo/sdk';
import {
  negotiateVersion, assertResult, assertDefinition,
  type Capabilities, type SessionBinding, type SessionOpenParams, type SessionState, type InitializeParams,
  type InitializeResult, type AhpRequestMap, type AhpResultMap, type JsonObject, type InteractionRequested,
  type InteractionResponse, type AhpEventPayload,
} from '@anureo/protocol';
import { AcpUpdateMapper, record, safe, input, mcp, configuration } from './mapping';

export interface AcpFileSystemPort {
  readTextFile?: (params: acp.ReadTextFileRequest) => Promise<acp.ReadTextFileResponse>;
  writeTextFile?: (params: acp.WriteTextFileRequest) => Promise<acp.WriteTextFileResponse | void>;
}
export interface AcpTerminalPort {
  createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  terminalOutput(params: acp.TerminalOutputRequest): Promise<acp.TerminalOutputResponse>;
  releaseTerminal(params: acp.ReleaseTerminalRequest): Promise<acp.ReleaseTerminalResponse | void>;
  waitForTerminalExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  killTerminal(params: acp.KillTerminalRequest): Promise<acp.KillTerminalResponse | void>;
}
export interface AcpAdapterOptions {
  command?: string; args?: readonly string[]; cwd?: string; env?: Record<string, string | undefined>;
  fs?: AcpFileSystemPort; terminal?: AcpTerminalPort;
  /** Inject an official v1 message stream for remote transports or deterministic wire tests. */
  connect?: () => Promise<{ stream: acp.Stream; dispose(): Promise<void> }>;
  requestTimeoutMs?: number; maxFrameBytes?: number;
  /** session/load snapshots have no turn boundaries; expose them separately from AHP realtime events. */
  onLoadSnapshot?: (binding: SessionBinding, updates: readonly JsonObject[]) => void;
}
type Deferred = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
function deferred(): Deferred {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
function errorFromNative(error: unknown, fallback = 'ACP_REQUEST_FAILED'): HarnessSdkError {
  if (error instanceof HarnessSdkError) return error;
  if (error instanceof acp.RequestError) {
    const code = error.code === -32601 ? 'CAPABILITY_UNSUPPORTED' : error.code === -32602 ? 'INVALID_PARAMS' : error.code === -32000 ? 'AUTH_REQUIRED' : error.code === -32002 ? 'RESOURCE_NOT_FOUND' : fallback;
    return new HarnessSdkError(code, code, false, false, { nativeCode: error.code });
  }
  return new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP connection closed', false, true);
}
type ExtensionKey = 'fork' | 'revert' | 'steer' | 'history' | 'goalSet' | 'goalClear' | 'compact' | 'review';
interface Extensions { methods: Partial<Record<ExtensionKey, string>>; fork: Array<'before' | 'through'>; revert: Array<'conversation' | 'files' | 'both'>; subagents: boolean; instructions: boolean; userInput: boolean; dynamicTool: boolean }
function extensions(response: unknown): Extensions {
  const extension = record(record(record(response)._meta).ahp);
  const methods: Extensions['methods'] = {};
  const result: Extensions = { methods, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  if (extension.version !== 1) return result;
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
async function processStream(options: AcpAdapterOptions): Promise<{ stream: acp.Stream; dispose(): Promise<void> }> {
  if (!options.command) throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'An ACP executable or stream factory is required');
  const child: HarnessProcess = await spawnHarnessProcess({ command: options.command, args: options.args, cwd: options.cwd, env: options.env });
  const iterator = child.stdout[Symbol.asyncIterator](); let lineBytes = 0;
  const incoming = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const value = await iterator.next();
        if (value.done) { controller.close(); return; }
        for (const byte of value.value) {
          if (byte === 10) lineBytes = 0;
          else if (++lineBytes > (options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'ACP frame exceeds its limit');
        }
        controller.enqueue(value.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  });
  let outgoingLineBytes = 0;
  const outgoing = new WritableStream<Uint8Array>({ write: (chunk) => {
    for (const byte of chunk) {
      if (byte === 10) outgoingLineBytes = 0;
      else if (++outgoingLineBytes > (options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'ACP outgoing frame exceeds its limit');
    }
    return child.write(chunk);
  }, close: () => child.closeInput() });
  // Drain stderr without retaining raw provider data or credentials in diagnostics.
  void (async () => { try { for await (const _chunk of child.stderr) { /* explicitly discarded */ } } catch {} })();
  return { stream: acp.ndJsonStream(outgoing, incoming), dispose: () => child.dispose() };
}

export class AcpAdapter implements HarnessAdapter {
  private connection: acp.ClientConnection | undefined;
  private channel: { stream: acp.Stream; dispose(): Promise<void> } | undefined;
  private info: acp.InitializeResponse | undefined;
  readonly sessions = new Map<string, AcpBackendSession>();
  private nativeSessions = new Map<string, AcpBackendSession>();
  private opening: AcpBackendSession | undefined;
  private openTail = Promise.resolve();
  private readonly deliveries = new Map<acp.JsonRpcId, Deferred>();
  private closing = false;
  extension: Extensions = { methods: {}, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  capabilities: Capabilities = {};
  constructor(readonly options: AcpAdapterOptions) {}
  get nativeCapabilities(): acp.AgentCapabilities { return this.info?.agentCapabilities ?? {}; }
  get agent(): acp.ClientContext { if (!this.connection) throw new HarnessSdkError('ACP_CONNECTION_CLOSED'); return this.connection.agent; }
  private backend(nativeId: string, allowOpening = false): AcpBackendSession {
    const existing = this.nativeSessions.get(nativeId);
    if (existing) return existing;
    if (allowOpening && this.opening && (!this.opening.nativeId || this.opening.nativeId === nativeId)) { this.opening.nativeId = nativeId; this.nativeSessions.set(nativeId, this.opening); return this.opening; }
    throw new acp.RequestError(-32602, 'Unknown ACP session');
  }
  private async interaction<T>(session: AcpBackendSession, requestId: acp.JsonRpcId, request: InteractionRequested, transform: (response: InteractionResponse | null) => T): Promise<T> {
    const delivery = deferred(); this.deliveries.set(requestId, delivery);
    return new Promise<T>((resolve, reject) => {
      let answered = false;
      void session.sink.requestInteraction(request, async (response) => {
        answered = true; resolve(transform(response));
        await delivery.promise;
      }).catch(() => { if (!answered) reject(new acp.RequestError(-32603, 'Interaction could not be completed')); });
    });
  }
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    negotiateVersion(params.protocolVersions);
    if (this.info) return { protocolVersion: 1, runtime: this.runtime(), capabilities: structuredClone(this.capabilities) };
    this.channel = this.options.connect ? await this.options.connect() : await processStream(this.options);
    const rawReader = this.channel.stream.readable.getReader(); const rawWriter = this.channel.stream.writable.getWriter();
    const wrapped: acp.Stream = {
      writable: new WritableStream({ write: async (frame) => {
        try {
          await rawWriter.write(frame);
          if ('id' in frame && !('method' in frame)) { this.deliveries.get(frame.id)?.resolve(); this.deliveries.delete(frame.id); }
        } catch (error) { for (const delivery of this.deliveries.values()) delivery.reject(error); throw error; }
      }, close: () => rawWriter.close(), abort: (reason) => rawWriter.abort(reason) }),
      readable: new ReadableStream({ pull: async (controller) => {
        try {
          for (;;) {
            const next = await rawReader.read(); if (next.done) { controller.close(); return; }
            const frame = next.value;
            // Preserve unknown notifications without requiring a patched SDK union of update variants.
            if ('method' in frame && !('id' in frame) && frame.method === 'session/update') {
              const value = record(frame.params); const session = this.backend(String(value.sessionId), true);
              await session.update(record(value.update)); continue;
            }
            if ('method' in frame && !('id' in frame) && frame.method === '_ahp/event' && Object.keys(this.extension.methods).length) {
              const value = record(frame.params); const session = this.backend(String(value.sessionId)); const event = value.event;
              assertDefinition<AhpEventPayload>('AhpEventPayload', event);
              if (event.type === 'turn/started') session.activeTurn = event.payload.turnId;
              await session.sink.emit(event, { ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}) });
              if (event.type === 'turn/completed' && session.activeTurn === event.payload.turnId) session.activeTurn = undefined;
              continue;
            }
            if ('method' in frame && !('id' in frame) && frame.method !== 'elicitation/complete') {
              const scope = record(frame.params).sessionId;
              const recipients = typeof scope === 'string' ? [this.backend(scope)] : [...this.sessions.values()];
              for (const session of recipients) await session.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'ACP_UNKNOWN_NOTIFICATION', message: 'Unknown ACP notification retained', raw: safe({ method: frame.method, params: frame.params }) } });
              continue;
            }
            controller.enqueue(frame); return;
          }
        } catch (error) { controller.error(error); }
      }, cancel: (reason) => rawReader.cancel(reason) }),
    };
    const app = acp.client({ name: 'anureo-harness-sdk-acp' })
      .onRequest('session/request_permission', (context) => {
        const session = this.backend(context.params.sessionId);
        return this.interaction<acp.RequestPermissionResponse>(session, context.requestId, {
          kind: 'approval', interactionId: `acp-permission:${String(context.requestId)}`, turnId: session.activeTurn,
          itemId: context.params.toolCall.toolCallId,
          options: context.params.options.map((option) => ({ id: option.optionId, label: option.name, semantic: option.kind === 'allow_once' ? 'allowOnce' : option.kind === 'allow_always' ? 'allowSession' : 'deny' })),
          ...(context.params.toolCall.rawInput !== undefined ? { input: safe(context.params.toolCall.rawInput) } : {}),
        }, (response) => response?.kind === 'approval' ? { outcome: { outcome: 'selected', optionId: response.optionId } } : { outcome: { outcome: 'cancelled' } });
      })
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
    this.connection = app.connect(wrapped);
    void this.connection.closed.then(async () => {
      const error = new HarnessSdkError('ACP_CONNECTION_CLOSED', 'ACP source connection closed', false, true);
      for (const delivery of this.deliveries.values()) delivery.reject(error); this.deliveries.clear();
      if (!this.closing) await Promise.all([...this.sessions.values()].map((session) => session.sink.fail(error).catch(() => {})));
    });
    this.info = await this.call('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: 'anureo-harness-sdk', version: '0.1.0' }, clientCapabilities: {
      fs: { readTextFile: !!this.options.fs?.readTextFile, writeTextFile: !!this.options.fs?.writeTextFile }, terminal: !!terminal,
      session: { configOptions: { boolean: {} }, compaction: {} }, plan: {},
      elicitation: params.clientCapabilities?.interactions?.includes('elicitation') ? { form: {}, url: {} } : undefined,
      _meta: { ahp: { version: 1, clientRequests: ['_ahp/user_input', '_ahp/dynamic_tool'] } },
    } });
    if (this.info.protocolVersion !== acp.PROTOCOL_VERSION) { await this.dispose(); throw new HarnessSdkError('PROTOCOL_VERSION_UNSUPPORTED'); }
    this.extension = extensions(this.info);
    const native = this.nativeCapabilities;
    this.capabilities = {
      session: { resume: native.loadSession === true || native.sessionCapabilities?.resume != null, fork: this.extension.fork, revert: this.extension.revert, history: !!this.extension.methods.history },
      turn: { interrupt: true, steer: !!this.extension.methods.steer, inputModalities: ['text', ...(native.promptCapabilities?.image ? ['image' as const] : []), ...(native.promptCapabilities?.embeddedContext ? ['file' as const] : [])] },
      interactions: ['approval', 'elicitation', ...(this.extension.userInput ? ['userInput' as const] : []), ...(this.extension.dynamicTool ? ['dynamicTool' as const] : [])],
      goal: { actions: [...(this.extension.methods.goalSet ? ['set' as const] : []), ...(this.extension.methods.goalClear ? ['clear' as const] : [])] },
      compact: !!this.extension.methods.compact, review: !!this.extension.methods.review, subagents: { events: this.extension.subagents ? 'nested' : 'none' },
      mcp: { stdio: true, http: native.mcpCapabilities?.http === true, elicitation: ['form', 'url'] }, config: { options: [] },
      extensions: Object.keys(this.extension.methods).length || this.extension.subagents || this.extension.userInput || this.extension.dynamicTool ? [{ name: 'x-acp/ahp', version: '1' }] : [],
    };
    return { protocolVersion: 1, runtime: this.runtime(), capabilities: structuredClone(this.capabilities) };
  }
  private runtime() { return { name: this.info?.agentInfo?.name ?? 'acp', version: this.info?.agentInfo?.version ?? 'unknown', adapter: 'acp/0.1.0' }; }
  async call<M extends acp.AgentRequestMethod>(method: M, params: acp.AgentRequestParamsByMethod[M]): Promise<acp.AgentRequestResponsesByMethod[M]>;
  async call(method: string, params: unknown): Promise<unknown>;
  async call(method: string, params: unknown): Promise<unknown> {
    try { return await waitForRequest(() => this.agent.request(method, params), {}, this.options.requestTimeoutMs ?? 30_000); }
    catch (error) { throw errorFromNative(error); }
  }
  private async extensionInteraction(kind: 'userInput' | 'dynamicTool', id: acp.JsonRpcId, params: Record<string, unknown>): Promise<unknown> {
    if (!this.extension[kind]) throw new acp.RequestError(-32601, 'Extension was not negotiated');
    const session = this.backend(String(params.sessionId));
    const request = { ...record(params.request), kind, interactionId: `acp-${kind}:${String(id)}`, turnId: session.activeTurn };
    assertDefinition<InteractionRequested>('InteractionRequested', request);
    return this.interaction(session, id, request, (response) => response ?? { cancelled: true });
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    const old = this.openTail; let release!: () => void; this.openTail = new Promise((resolve) => { release = resolve; }); await old;
    const session = new AcpBackendSession(this, params, sink); this.opening = session;
    try {
      if (params.instructions && !this.extension.instructions) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'ACP peer did not negotiate instructions');
      const common = { cwd: params.cwd, mcpServers: mcp(params.mcpServers), ...(params.instructions ? { _meta: { ahp: { version: 1, instructions: params.instructions } } } : {}) };
      let response: Record<string, unknown>;
      if (params.mode === 'new') response = record(await this.call('session/new', common));
      else if (params.mode === 'resume') {
        if (!params.binding.nativeRef || params.binding.nativeRef.provider !== 'acp') throw new HarnessSdkError('SESSION_BINDING_MISMATCH');
        session.nativeId = params.binding.nativeRef.value; this.nativeSessions.set(session.nativeId, session); session.hydrating = true;
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
      this.nativeSessions.set(session.nativeId, session); this.sessions.set(params.binding.sessionId, session);
      session.configure(response); session.hydrating = false;
      if (session.loadedSnapshot.length) this.options.onLoadSnapshot?.(session.binding, session.loadedSnapshot);
      const patch = { ...params.config, ...(params.model ? { model: params.model } : {}), ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}) };
      if (Object.keys(patch).length) await session.setConfiguration(patch);
      if (session.state().metadata) await sink.emit({ type: 'session/metadata', payload: session.state().metadata! });
      return session;
    } catch (error) { for (const [id, value] of this.nativeSessions) if (value === session) this.nativeSessions.delete(id); this.sessions.delete(params.binding.sessionId); throw error; }
    finally { this.opening = undefined; release(); }
  }
  async dispose(): Promise<void> {
    if (this.closing) return; this.closing = true;
    for (const session of this.sessions.values()) await session.dispose().catch(() => {});
    this.connection?.close(); await this.channel?.dispose();
    this.sessions.clear(); this.nativeSessions.clear();
  }
}

export class AcpBackendSession implements BackendSession {
  nativeId = '';
  activeTurn: string | undefined;
  hydrating = false;
  readonly loadedSnapshot: JsonObject[] = [];
  readonly terminals = new Set<string>();
  readonly capabilities: Capabilities;
  private config: JsonObject = {};
  private configKeys = new Map<string, Record<string, unknown>>();
  private configurationData: Record<string, unknown> = {};
  private capabilityRevision = 1;
  private sessionTitle?: string | null;
  private closed = false;
  private readonly mapper: AcpUpdateMapper;
  private snapshotBytes = 0;
  constructor(readonly adapter: AcpAdapter, private readonly params: SessionOpenParams, readonly sink: SessionEventSink) {
    this.capabilities = structuredClone(adapter.capabilities);
    this.mapper = new AcpUpdateMapper(sink, () => this.activeTurn, () => this.state(), (data) => this.configure(data), adapter.extension.subagents);
  }
  get binding(): SessionBinding { return { ...this.params.binding, nativeRef: { provider: 'acp', value: this.nativeId } }; }
  state(): SessionState { return { ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}), binding: this.binding, config: this.config, capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, status: this.activeTurn ? 'running' : 'ready', ...(this.activeTurn ? { activeTurnId: this.activeTurn } : {}) }; }
  configure(data: Record<string, unknown>): void {
    if (Object.hasOwn(data, 'sessionTitle')) { this.sessionTitle = data.sessionTitle as string | null; return; }
    this.configurationData = { ...this.configurationData, ...data };
    if (typeof data.currentModeId === 'string') this.configurationData.modes = { ...record(this.configurationData.modes), currentModeId: data.currentModeId };
    const descriptor = configuration(this.configurationData); this.configKeys = descriptor.keys;
    this.capabilities.config = { options: descriptor.options }; this.config = { ...this.config, ...descriptor.values };
    if (typeof data.currentModeId === 'string') this.config.mode = data.currentModeId;
    this.capabilityRevision++;
  }
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
    await this.mapper.update(data);
  }
  requireTerminal(id: string): void { if (!this.terminals.has(id)) throw new acp.RequestError(-32602, 'Terminal does not belong to this session'); }
  async setConfiguration(patch: JsonObject): Promise<SessionState> {
    for (const key of Object.keys(patch)) if (!this.configKeys.has(key)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    for (const [key, value] of Object.entries(patch)) {
      const option = this.configKeys.get(key)!;
      if (option.type === 'mode') await this.adapter.call('session/set_mode', { sessionId: this.nativeId, modeId: String(value) });
      else {
        const response = await this.adapter.call('session/set_config_option', { sessionId: this.nativeId, configId: String(option.id), type: option.type === 'boolean' ? 'boolean' : 'select', value });
        this.configure(record(response));
      }
      this.config[key] = value;
    }
    return this.state();
  }
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
        if (key === 'steer') this.capabilities.turn!.steer = false;
        if (key === 'history') this.capabilities.session!.history = false;
        if (key === 'revert') this.capabilities.session!.revert = [];
        if (key === 'compact') this.capabilities.compact = false;
        if (key === 'review') this.capabilities.review = false;
        if (key === 'goalSet' || key === 'goalClear') this.capabilities.goal!.actions = this.capabilities.goal!.actions?.filter((action) => action !== (key === 'goalSet' ? 'set' : 'clear'));
        await this.sink.emit({ type: 'session/state', payload: this.state() });
      }
      throw error;
    }
  }
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case 'turn/start': {
        const turn = params as AhpRequestMap['turn/start']; const prompt = input(turn.input);
        this.activeTurn = turn.turnId; this.mapper.reset();
        await this.sink.emit({ type: 'turn/started', payload: { turnId: turn.turnId } });
        void (async () => {
          try {
            const completed = await this.adapter.agent.request('session/prompt', { sessionId: this.nativeId, prompt, ...(this.capabilities.extensions?.some((extension) => extension.name === 'x-acp/ahp') ? { _meta: { ahp: { version: 1, turnId: turn.turnId } } } : {}) });
            await this.mapper.complete();
            await this.sink.emit({ type: 'turn/completed', payload: { turnId: turn.turnId, status: completed.stopReason === 'cancelled' ? 'interrupted' : 'completed' } });
          } catch (error) {
            const failure = errorFromNative(error, 'ACP_TURN_FAILED');
            if (failure.outcomeUnknown) await this.sink.fail(failure);
            else await this.sink.emit({ type: 'turn/completed', payload: { turnId: turn.turnId, status: 'failed', error: { code: failure.code, message: failure.message, retryable: false, outcomeUnknown: false } } });
          } finally { if (this.activeTurn === turn.turnId) this.activeTurn = undefined; }
        })().catch(() => {});
        result = { turnId: turn.turnId, accepted: true }; break;
      }
      case 'turn/interrupt': await this.adapter.agent.notify('session/cancel', { sessionId: this.nativeId }); result = { accepted: true, turnId: (params as AhpRequestMap['turn/interrupt']).turnId }; break;
      case 'session/config/set': result = await this.setConfiguration((params as AhpRequestMap['session/config/set']).patch); break;
      case 'session/close': await this.dispose(); result = { closed: true }; break;
      case 'turn/steer': return this.extension('steer', method, params);
      case 'session/revert': return this.extension('revert', method, params);
      case 'history/read': return this.extension('history', method, params);
      case 'goal/set': return this.extension('goalSet', method, params);
      case 'goal/clear': return this.extension('goalClear', method, params);
      case 'compact/start': return this.extension('compact', method, params);
      case 'review/start': return this.extension('review', method, params);
      case 'interaction/respond': case 'interaction/cancel': throw new HarnessSdkError('INTERACTION_EXPIRED');
    }
    return result as AhpResultMap[M];
  }
  async dispose(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (this.activeTurn) await this.adapter.agent.notify('session/cancel', { sessionId: this.nativeId }).catch(() => {});
    for (const terminalId of this.terminals) await this.adapter.options.terminal?.releaseTerminal({ sessionId: this.nativeId, terminalId }).catch(() => {});
    this.terminals.clear();
    if (this.adapter.nativeCapabilities.sessionCapabilities?.close != null) await this.adapter.call('session/close', { sessionId: this.nativeId }).catch(() => {});
  }
}
export function createAcpAdapter(options: AcpAdapterOptions): AcpAdapter { return new AcpAdapter(options); }
