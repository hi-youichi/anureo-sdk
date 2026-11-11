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
export interface AcpChannel {
  stream: acp.Stream;
  dispose(): Promise<void>;
  /** Redacted stderr tail captured so far; absent for injected streams. */
  diagnostics?(): string;
}
export type AcpPermissionDecision = 'allow-once' | 'reject-once';
export interface AcpPermissionContext {
  sessionId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  /** Options actually offered by the agent; a policy never fabricates an optionId. */
  options: readonly acp.PermissionOption[];
  signal: AbortSignal;
}
export type AcpPermissionPolicy =
  | AcpPermissionDecision
  | ((context: AcpPermissionContext) => AcpPermissionDecision | undefined | Promise<AcpPermissionDecision | undefined>);
export interface AcpAdapterOptions {
  command?: string; args?: readonly string[]; cwd?: string; env?: Record<string, string | undefined>;
  fs?: AcpFileSystemPort; terminal?: AcpTerminalPort;
  /** Inject an official v1 message stream for remote transports or deterministic wire tests. */
  connect?: () => Promise<AcpChannel>;
  requestTimeoutMs?: number; maxFrameBytes?: number;
  /** Retained stderr lines for failure diagnostics; 0 disables capture. Defaults to 200. */
  stderrTailLines?: number;
  /** Receives each redacted stderr line as it arrives (never raw). */
  onStderr?: (line: string) => void;
  /**
   * Answer `session/request_permission` without surfacing an AHP interaction.
   * Returning undefined (or a kind the agent did not offer) falls back to the
   * interactive path. Auto decisions are reported as `ACP_PERMISSION_AUTO_ANSWERED`
   * notices so they remain auditable.
   */
  autoRespondPermission?: AcpPermissionPolicy;
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
async function processStream(options: AcpAdapterOptions): Promise<AcpChannel> {
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
  // Retain a short redacted tail: a child that dies before initialize is otherwise
  // invisible, and raw stderr may carry credentials or prompts.
  const tail = new StderrTail(options.stderrTailLines ?? 200, options.onStderr);
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of child.stderr) tail.write(decoder.decode(chunk, { stream: true }));
    } catch { /* a closed stderr pipe is not a protocol failure */ }
    finally { tail.flush(); }
  })();
  return { stream: acp.ndJsonStream(outgoing, incoming), dispose: () => child.dispose(), diagnostics: () => tail.text() };
}

function selectPermissionOption(options: readonly acp.PermissionOption[], decision: AcpPermissionDecision): string | undefined {
  const kind = decision === 'allow-once' ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === kind)?.optionId
    ?? options.find((option) => option.optionId === decision)?.optionId;
}

export class AcpAdapter implements HarnessAdapter {
  private connection: acp.ClientConnection | undefined;
  private channel: AcpChannel | undefined;
  private info: acp.InitializeResponse | undefined;
  readonly sessions = new Map<string, AcpBackendSession>();
  private nativeSessions = new Map<string, AcpBackendSession>();
  private openingSession: AcpBackendSession | undefined;
  private sessionOpenQueueTail = Promise.resolve();
  private readonly deliveries = new Map<acp.JsonRpcId, Deferred>();
  private closing = false;
  private connectionLost = false;
  private sourceFailure?: HarnessSdkError;
  extension: Extensions = { methods: {}, fork: [], revert: [], subagents: false, instructions: false, userInput: false, dynamicTool: false };
  capabilities: Capabilities = {};
  constructor(readonly options: AcpAdapterOptions) {}
  get nativeCapabilities(): acp.AgentCapabilities { return this.info?.agentCapabilities ?? {}; }
  get agent(): acp.ClientContext { if (!this.connection) throw new HarnessSdkError('ACP_CONNECTION_CLOSED'); return this.connection.agent; }
  get connected(): boolean { return !!this.connection && !this.connectionLost; }
  /** Attach the redacted stderr tail so a silent startup crash stays diagnosable. */
  private withDiagnostics(error: HarnessSdkError): HarnessSdkError {
    const tail = this.channel?.diagnostics?.();
    if (!tail) return error;
    return new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown, {
      ...error.details,
      diagnostics: { stderrTail: tail },
    });
  }
  private backend(nativeId: string, allowOpening = false): AcpBackendSession {
    const existing = this.nativeSessions.get(nativeId);
    if (existing) return existing;
    if (allowOpening && this.openingSession && (!this.openingSession.nativeId || this.openingSession.nativeId === nativeId)) {
      this.openingSession.nativeId = nativeId;
      // Index by native ID as soon as a session/update identifies the opening session.
      this.nativeSessions.set(nativeId, this.openingSession);
      return this.openingSession;
    }
    throw new acp.RequestError(-32602, 'Unknown ACP session');
  }
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
  private async routeNotification(frame: acp.AnyMessage): Promise<'consumed' | 'forward-to-sdk'> {
    // Preserve unknown notifications without requiring a patched SDK union of update variants.
    if ('method' in frame && !('id' in frame) && frame.method === 'session/update') {
      const value = record(frame.params);
      const session = this.backend(String(value.sessionId), true);
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
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (this.closing) throw new HarnessSdkError('RUNTIME_DISPOSED');
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    if (this.info) return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: this.runtime(), capabilities: structuredClone(this.capabilities) };
    const channel = this.options.connect ? await this.options.connect() : await processStream(this.options);
    if (this.closing) { await channel.dispose(); throw new HarnessSdkError('RUNTIME_DISPOSED'); }
    this.channel = channel;
    const rawReader = this.channel.stream.readable.getReader(); const rawWriter = this.channel.stream.writable.getWriter();
    const wrapped: acp.Stream = {
      writable: new WritableStream({ write: async (frame) => {
        try {
          await rawWriter.write(frame);
          if ('id' in frame && !('method' in frame)) { this.deliveries.get(frame.id)?.resolve(); this.deliveries.delete(frame.id); }
        } catch (error) {
          this.connectionLost = true; this.sourceFailure = sdkError(error, 'ACP_CONNECTION_CLOSED', true);
          for (const delivery of this.deliveries.values()) delivery.reject(this.sourceFailure);
          void Promise.all([...this.sessions.values()].map(session => session.sink.fail(this.sourceFailure!).catch(() => {})));
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
          this.sourceFailure = sdkError(error, 'ACP_CONNECTION_CLOSED', true);
          controller.error(error);
          void Promise.all([...this.sessions.values()].map(session => session.sink.fail(this.sourceFailure!).catch(() => {})));
        }
      }, cancel: (reason) => rawReader.cancel(reason) }),
    };
    const app = acp.client({ name: 'anureo-harness-sdk-acp' })
      .onRequest('session/request_permission', async (context) => {
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
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: this.runtime(), capabilities: structuredClone(this.capabilities) };
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
  async dispose(): Promise<void> {
    if (this.closing) return; this.closing = true;
    const results = await Promise.allSettled([...this.sessions.values()].map(session => session.dispose()));
    const transport = await Promise.allSettled([Promise.resolve().then(() => this.connection?.close()), Promise.resolve().then(() => this.channel?.dispose())]);
    this.sessions.clear(); this.nativeSessions.clear();
    const failures = [...results, ...transport].filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'ACP resources were not fully released', false, true, { errors: failures.map(() => ({ code: 'ACP_RELEASE_FAILED' })) });
  }
}

export class AcpBackendSession implements BackendSession {
  // Native lifecycle tracks turn IDs and a separate mapper per turn.
  private readonly nativeMappers = new Map<string, AcpUpdateMapper>();
  private readonly nativeStartedTurnIds = new Set<string>();

  // Standard ACP and legacy extensions share one turn. activeTurn can exist
  // before a start notification; standardTurnStarted marks start handling,
  // not completed submission binding.
  private standardTurnStarted = false;
  private standardSubmissionId?: string;
  activeTurn: string | undefined;
  private readonly mapper: AcpUpdateMapper;

  private releasing?: Promise<void>;
  private nativeClosed = false;
  nativeId = '';
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
  private snapshotBytes = 0;
  constructor(readonly adapter: AcpAdapter, private readonly params: SessionOpenParams, readonly sink: SessionEventSink) {
    this.capabilities = structuredClone(adapter.capabilities);
    this.mapper = new AcpUpdateMapper(sink, () => this.activeTurn, () => this.snapshot(), (data) => this.configure(data), adapter.extension.subagents);
  }
  get binding(): SessionBinding { return { ...this.params.binding, nativeRef: { provider: 'acp', value: this.nativeId } }; }
  get state(): SessionState { return this.snapshot(); }
  snapshot(): SessionState { return { ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}), binding: this.binding, config: this.config, capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, status: this.activeTurn ? 'running' : 'ready', activeTurnIds: [...this.nativeStartedTurnIds, ...(this.standardTurnStarted && this.activeTurn ? [this.activeTurn] : [])] }; }
  async nativeEvent(raw: unknown, scope: Record<string, unknown>): Promise<void> {
    const event = record(raw), payload = record(event.payload);
    if (event.type === 'submission/bound') { assertDefinition<import('@anureo/protocol').SubmissionBound>('SubmissionBound', payload); await this.sink.bindSubmission!(payload.submissionId, payload.turnId); return; }
    assertDefinition<AhpEventPayload>('AhpEventPayload', raw);
    if (raw.type === 'turn/started') this.nativeStartedTurnIds.add(raw.payload.turnId);
    if (raw.type === 'turn/completed') {
      await this.nativeMappers.get(raw.payload.turnId)?.complete();
      this.nativeMappers.delete(raw.payload.turnId); this.nativeStartedTurnIds.delete(raw.payload.turnId);
    }
    await this.sink.emit(raw, { ...(typeof scope.turnId === 'string' ? { turnId: scope.turnId } : {}) });
  }
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
    await this.sink.emit(raw, { ...(typeof scope.turnId === 'string' ? { turnId: scope.turnId } : this.activeTurn ? { turnId: this.activeTurn } : {}) });
    if (raw.type === 'turn/completed' && this.activeTurn === raw.payload.turnId) {
      this.activeTurn = undefined; this.standardSubmissionId = undefined; this.standardTurnStarted = false;
    }
  }
  private async submitReview(params: AhpRequestMap['review/start']): Promise<AhpResultMap['review/start']> {
    const method = this.adapter.extension.methods.review; if (!method) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    if (this.activeTurn) throw new HarnessSdkError('NATIVE_CORRELATION_UNSUPPORTED');
    this.activeTurn = randomUUID(); this.standardSubmissionId = params.submissionId; this.standardTurnStarted = false; this.mapper.reset();
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
  async ensureStandardStarted(): Promise<void> {
    if (!this.standardSubmissionId || !this.activeTurn || this.standardTurnStarted) return;
    this.standardTurnStarted = true;
    await this.sink.emit({ type: 'turn/started', payload: { turnId: this.activeTurn } });
    await this.sink.bindSubmission(this.standardSubmissionId, this.activeTurn);
  }
  private async submitInput(start: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    if (start.delivery !== 'native') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    if (this.adapter.extension.nativeLifecycle) {
      try {
        const result = record(await this.adapter.agent.request('session/prompt', { sessionId: this.nativeId, prompt: input(start.input), _meta: { ahp: { version: 2, submissionId: start.submissionId } } }));
        const value = record(record(result._meta).ahp).acceptance;
        assertDefinition<import('@anureo/protocol').SubmissionAcceptance>('SubmissionAcceptance', value);
        return value;
      } catch (cause) { throw errorFromNative(cause, 'ACP_INPUT_REJECTED'); }
    }
    // Standard ACP has no per-execution correlation. It can safely expose only
    // one outstanding prompt; this is a backend-specific evidence limitation.
    if (this.activeTurn) throw new HarnessSdkError('NATIVE_CORRELATION_UNSUPPORTED');
    this.activeTurn = randomUUID(); this.standardSubmissionId = start.submissionId; this.standardTurnStarted = false; this.mapper.reset();
    const turnId = this.activeTurn;
    try {
      const completed = await this.adapter.agent.request('session/prompt', { sessionId: this.nativeId, prompt: input(start.input),
        ...(Object.keys(this.adapter.extension.methods).length ? { _meta: { ahp: { version: 1, turnId } } } : {}) });
      await this.ensureStandardStarted(); await this.mapper.complete();
      const outcome = stopOutcome(completed.stopReason);
      if (outcome.notice) await this.sink.emit({ type: 'notice', payload: { severity: 'warning', code: outcome.notice.code, message: outcome.notice.message } }, { turnId });
      await this.sink.emit({ type: 'turn/completed', payload: { turnId, status: outcome.status } });
      return { submissionId: start.submissionId, accepted: true, disposition: 'started', turnId };
    } catch (cause) {
      const error = errorFromNative(cause, 'ACP_INPUT_REJECTED');
      if (this.standardTurnStarted) {
        if (error.outcomeUnknown) await this.sink.fail(error);
        else await this.sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: { code: error.code, message: error.code, retryable: false, outcomeUnknown: false } } });
      }
      throw error;
    } finally { this.activeTurn = undefined; this.standardSubmissionId = undefined; this.standardTurnStarted = false; }
  }
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
  requireTerminal(id: string): void { if (!this.terminals.has(id)) throw new acp.RequestError(-32602, 'Terminal does not belong to this session'); }
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
}
export function createAcpAdapter(options: AcpAdapterOptions): AcpAdapter { return new AcpAdapter(options); }

export interface DshAcpOptions extends Omit<AcpAdapterOptions, 'command' | 'args'> {
  /** `dsh` executable; defaults to `dsh` on PATH. */
  command?: string;
  /** Profile under `$DSH_HOME/profiles`; defaults to `acp`. */
  profile?: string;
  /** Overrides `$DSH_HOME`; defaults to the env var, then `~/.dsh`. */
  dshHome?: string;
  /** Shorthand for `autoRespondPermission: 'allow-once'` (unattended hosts only). */
  autoApprove?: boolean;
}

/**
 * Preset for `dsh --profile acp`: pure standard ACP v1, persistent sessions,
 * stdio + Streamable HTTP MCP, `session/resume` and `session/close`.
 *
 * DSH needs Node.js >= 24.9 and a `$DSH_HOME` with provider credentials; a wrong
 * runtime exits before `initialize`, so the retained stderr tail is the only
 * diagnostic that survives.
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
