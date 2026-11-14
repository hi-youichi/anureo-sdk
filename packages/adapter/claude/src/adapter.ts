// Owns native Claude adapters and sessions; the package entry point only assembles exports.
import type { ClaudeAdapterOptions, ClaudeQuery } from "./options";
import { claudeFileChanges, completeClaudeTool } from './file-changes';
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  query, getSessionMessages, getSessionInfo, forkSession,
  type Options, type Query, type SDKMessage, type SDKUserMessage,
  type SessionStore, type SessionKey, type SessionMessage, type PermissionMode, type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BoundedEventQueue, HarnessSdkError, sdkError,
  type BackendSession, type HarnessAdapter, type SessionEventSink, type SessionMethod,
} from "@anureo/sdk";
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, publicValue, validateJsonSchema,
  type Capabilities, type AhpRequestMap, type AhpResultMap, type HistoryItem, type HistoryPage,
  type InitializeParams, type InitializeResult, type InputBlock, type InteractionRequested, type InteractionResponse,
  type Item, type JsonObject, type JsonValue, type SessionBinding, type SessionOpenParams, type SessionState, type Boundary,
} from "@anureo/protocol";
import { FileSessionStore } from "./store";
import { compileOutputSchema, type OutputSchema } from './output-schema';
import { claudeTurnError } from './turn-error';

/** Connect a client to Claude queries and retain ownership of opened backend sessions.
 * createClient initializes and disposes this adapter through its output wrapper; direct consumers
 * initialize before opening sessions and await disposal when finished.
 * Constructor setup reads host configuration without starting Claude. */
export class ClaudeNativeAdapter implements HarnessAdapter {
  /** Retain launch/extension options and select an optional state store without native I/O.
   * Explicit stateDir wins for adapter storage; defaultHome suppresses its CLAUDE_CONFIG_DIR
   * override while retaining any explicitly supplied environment. */
  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    const stateDir = options.stateDir ?? options.env?.CLAUDE_CONFIG_DIR;
    this.env = { ...basicEnvironment(), ...options.env, ...(stateDir && !options.defaultHome ? { CLAUDE_CONFIG_DIR: stateDir } : {}) };
    if (!options.sessionStore && stateDir) this.defaultStore = new FileSessionStore(join(stateDir, "ahp-session-store"));
    this.sessionStore = options.sessionStore ?? this.defaultStore;
  }
  /** Report store/checkpoint-dependent support without native discovery or resource acquisition. */
  get capabilities(): Capabilities { return capabilities({ store: !!this.sessionStore, checkpoints: !!this.options.enableFileCheckpointing }); }
  /** Validate protocol negotiation and explicit home policy for Client.initialize. Reject invalid
   * negotiation, disposed adapters or missing home configuration; no native query is opened here. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    if (this.disposed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (!this.env.CLAUDE_CONFIG_DIR && !this.options.defaultHome && !this.options.queryFactory) throw new HarnessSdkError("HARNESS_CONFIG_INVALID", "Claude requires an explicit isolated CLAUDE_CONFIG_DIR");
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: "claude", version: "0.3.265", adapter: "claude-native/0.1.0" }, capabilities: this.capabilities };
  }
  /** Open and retain a backend for OutputSession.open, awaiting resume/fork setup and query
   * construction. Native handshake/execution events arrive through the sink; this is not a readiness
   * or terminal wait. Setup failures reject; the client owns successful backend disposal. */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (params.binding.adapterId !== "claude" && params.binding.adapterId !== "claude-native") throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    const session = new ClaudeBackendSession(this, params, sink, this.defaultStore);
    await session.open(); this.sessions.add(session); return session;
  }
  /** Query model metadata once for directory hosts, defaulting cwd to process.cwd().
   * End input and close the query after discovery; startup/query/close failures reject. */
  async listModels(cwd = process.cwd()): Promise<Awaited<ReturnType<Query["supportedModels"]>>> {
    const input = new BoundedEventQueue<SDKUserMessage>();
    const stream = (this.options.queryFactory ?? query)({ prompt: input, options: this.queryOptions(cwd) });
    try { return await stream.supportedModels(); } finally { input.end(); stream.close(); }
  }
  /** Internal launch projection shared by ClaudeBackendSession.startQuery, listModels and
   * createClaudeCatalogSession. Returns native options without launching; callers apply operation
   * overrides and own every query started with these options. */
  queryOptions(cwd: string): Options {
    return {
      cwd, env: this.env, settingSources: [], persistSession: true,
      includePartialMessages: true, includeHookEvents: true,
      ...(this.options.command ?? this.options.executable ? { pathToClaudeCodeExecutable: this.options.command ?? this.options.executable } : {}),
      ...(this.options.executableRuntime ? { executable: this.options.executableRuntime } : {}),
      ...(this.options.args?.length ? { spawnClaudeCodeProcess: (options) => spawn(options.command, [...options.args, ...this.options.args!], { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true }) } : {}),
      ...(this.sessionStore ? { sessionStore: this.sessionStore, sessionStoreFlush: "eager" as const } : {}),
      enableFileCheckpointing: this.options.enableFileCheckpointing ?? false,
    };
  }
  /** Await all retained sessions before releasing the adapter registry; reject the first cleanup
   * failure after all attempts settle. Later calls return without retrying failed cleanup. */
  async dispose(): Promise<void> {
    if (this.disposed) return; this.disposed = true;
    const results = await Promise.allSettled([...this.sessions].map(session => session.dispose())); this.sessions.clear();
    const failed = results.find((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failed) throw failed.reason;
  }
  /** Retained launch/extension configuration used by later queries; avoid mutating it during work. */
  readonly options: ClaudeAdapterOptions;
  /** Selected native store, shared with sessions; an injected store keeps its host-owned lifecycle. */
  readonly sessionStore?: SessionStore;
  /** Native launch environment; may contain credentials and is not a safe diagnostic projection. */
  readonly env: Record<string, string | undefined>;
  private readonly sessions = new Set<ClaudeBackendSession>();
  /** Internal native-input UUID to SDK turn mappings retained across in-memory resume/fork. */
  readonly turnMaps = new Map<string, Record<string, string>>();
  private readonly defaultStore?: FileSessionStore;
  private disposed = false;
}
/** Adapter-internal BackendSession implementation retained in the root export for compatibility.
 * ClaudeNativeAdapter.openSession constructs and opens it; OutputSession.execute forwards SDK
 * requests and OutputSession.dispose awaits its cleanup on behalf of the client.
 * Native receipt, execution association and terminal completion remain separate observations. */
export class ClaudeBackendSession implements BackendSession {
  /** Prepare binding/configuration for ClaudeNativeAdapter.openSession without starting a query.
   * Reject unsupported config keys or invalid values before native open. */
  constructor(private readonly adapter: ClaudeNativeAdapter, private readonly params: SessionOpenParams, private readonly sink: SessionEventSink, private readonly fileStore?: FileSessionStore) {
    this.binding = { ...params.binding, nativeRef: params.binding.nativeRef ?? { provider: "claude", value: randomUUID() } };
    this.capabilities = adapter.capabilities; this.config = structuredClone(params.config ?? {}); this.model = params.model ?? str(this.config.model);
    for (const [key, value] of Object.entries(this.config)) {
      const option = this.capabilities.config?.options.find((entry) => entry.id === key);
      if (!option) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED", "Unknown Claude config option");
      if (!validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Invalid Claude config value");
    }
  }
  /** Resolve resume/fork state and start a query for ClaudeNativeAdapter.openSession.
   * Store, boundary and native setup failures reject. Successful opens transfer backend cleanup
   * to the adapter/client; native setup is not a terminal execution wait. */
  async open(): Promise<void> {
    if (this.params.mode === "resume" && !this.params.binding.nativeRef) throw new HarnessSdkError("SESSION_NOT_FOUND");
    if (this.params.mode === "fork") {
      if (!this.params.fork?.nativeRef) throw new HarnessSdkError("SESSION_NOT_FOUND");
      const source = this.params.fork.nativeRef.value;
      const point = await this.boundaryPoint(source, this.params.fork.boundary);
      const forked = point.uuid ? await (this.adapter.options.forkSession ?? forkSession)(source, { dir: this.params.cwd, sessionStore: this.adapter.sessionStore, upToMessageId: point.uuid }) : { sessionId: randomUUID() };
      this.binding = { ...this.binding, nativeRef: { provider: "claude", value: forked.sessionId } };
      this.turns = this.fileStore ? await this.fileStore.loadTurnMap(source) : structuredClone(this.adapter.turnMaps.get(source) ?? {});
    } else this.turns = this.fileStore ? await this.fileStore.loadTurnMap(this.nativeId) : this.adapter.turnMaps.get(this.nativeId) ?? {};
    this.adapter.turnMaps.set(this.nativeId, this.turns);
    await this.fileStore?.saveTurnMap(this.nativeId, this.turns);
    const fresh = this.params.mode === "new" || (this.params.mode === "fork" && !await this.hasHistory(this.nativeId));
    await this.startQuery({ mode: fresh ? "fresh" : "resume" });
  }
  /** Dispatch the SDK's backend port requests. Input resolves on native dispatch, independently of
   * association/terminal events; configuration applies in order without rollback. Busy/unsupported
   * operations and native failures reject. Closing releases observation with execution unconfirmed. */
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.closed) throw new HarnessSdkError("SESSION_CLOSED");
    if (this.switchingOutput && method !== 'session/close' && method !== 'history/read') throw new HarnessSdkError('SESSION_BUSY', 'Claude output format is changing');
    if (method !== 'session/close' && method !== 'history/read') {
      if (this.queryFailure) throw this.queryFailure;
      if (!this.query) throw new HarnessSdkError('SESSION_CLOSED');
    }
    if (this.reverting && method === 'session/config/set') throw new HarnessSdkError('SESSION_BUSY', 'Claude configuration cannot change during revert');
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case 'input/submit': return await this.submitInput(params as AhpRequestMap['input/submit']) as AhpResultMap[M];
      case 'session/interrupt': {
        const receipt = await this.query!.interrupt();
        const stillQueued = receipt?.still_queued?.flatMap(id => { const pending = this.nativeInputs.get(id); return pending ? [pending.submissionId] : []; });
        result = { accepted: true, ...(stillQueued ? { stillQueued } : {}) }; break;
      }
      case 'turn/interrupt': case 'turn/steer': throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Claude controls target the session, not an atomically matched Turn');
      case "session/config/set": result = await this.setConfig((params as AhpRequestMap["session/config/set"]).patch); break;
      case "history/read": {
        const request = params as AhpRequestMap["history/read"]; result = await this.readHistory(request); break;
      }
      case "session/revert": result = await this.revert(params as AhpRequestMap['session/revert']); break;
      case "session/close": await this.dispose(); result = { closed: true, observationClosed: true, executionStopped: "unconfirmed" }; break;
      default: throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    }
    return result as AhpResultMap[M];
  }
  /** Share cleanup completion with execute's close path and OutputSession.dispose. Stop input admission, invalidate the
   * pump generation and await query close/return; this does not prove native execution stopped. */
  async dispose(): Promise<void> {
    return this.release ??= (async () => {
      this.closed = true; this.generation++;
      this.nativeInputs.clear(); this.input?.end();
      if (this.query) await this.releaseQuery(this.query);
    })();
  }
  /** Current native session identity, updated by fork/revert and native initialization. */
  binding: SessionBinding;
  /** Store/checkpoint capability projection captured from the adapter at construction. */
  readonly capabilities: Capabilities;
  /** Apply execute's configuration controls in order and publish a snapshot only after all succeed.
   * Earlier native effects (including model changes) survive rejection; the admission counter prevents
   * an output-format replacement from racing an in-flight patch and is released on every outcome.
   * Preserve SDK error metadata; unclassified failures become unknown outcomes, which Session's
   * request-failure handler uses to require recovery before further configuration/input. */
  private async setConfig(patch: JsonObject): Promise<SessionState> {
    this.configOperations++;
    try {
      // Apply settings sequentially without rollback on failure. Model changes
      // take effect immediately; commit the config snapshot only after all settings succeed.
      if (patch.model !== undefined) {
        if (typeof patch.model !== "string") throw new HarnessSdkError("INVALID_PARAMS");
        await this.query!.setModel(patch.model);
        this.model = patch.model;
      }
      if (patch.permissionMode !== undefined) {
        await this.query!.setPermissionMode(permission(patch.permissionMode));
      }
      if (patch.fastMode !== undefined) {
        if (typeof patch.fastMode !== "boolean") throw new HarnessSdkError("INVALID_PARAMS");
        await this.query!.applyFlagSettings({ fastMode: patch.fastMode });
      }
      if (patch.effort !== undefined) {
        if (patch.effort !== null && !isEffort(patch.effort)) throw new HarnessSdkError("INVALID_PARAMS");
        await this.query!.applyFlagSettings({ effortLevel: patch.effort });
      }
      if (patch.maxThinkingTokens !== undefined) {
        if (patch.maxThinkingTokens !== null && typeof patch.maxThinkingTokens !== "number") throw new HarnessSdkError("INVALID_PARAMS");
        await this.query!.setMaxThinkingTokens(patch.maxThinkingTokens);
      }

      this.config = { ...this.config, ...patch };
      this.capabilityRevision++;
      const state = this.snapshot();
      await this.sink.emit({ type: "session/state", payload: state });
      return state;
    } catch (cause) { throw sdkError(cause, "CLAUDE_CONFIG_FAILED", true); }
    finally { this.configOperations--; }
  }
  private release?: Promise<void>;
  private readonly nativeInputs = new Map<string, { submissionId: string; turnId?: string }>();
  private query?: ClaudeQuery;
  private pumping?: Promise<void>;
  private readonly queryReleases = new WeakMap<ClaudeQuery, Promise<void>>();
  private outputSchema?: OutputSchema;
  private switchingOutput = false;
  private queryMode: QueryStart["mode"] = "resume";
  private queryResumeAt?: string;
  private queryFailure?: HarnessSdkError;
  private configOperations = 0;
  private input?: BoundedEventQueue<SDKUserMessage>;
  private active?: ActiveTurn;
  private generation = 0;
  private closed = false;
  private reverting = false;
  private config: JsonObject;
  private capabilityRevision = 1;
  private model?: string;
  private turns: Record<string, string> = {};
  private historySnapshots = new Map<string, HistoryItem[]>();
  /** Native fast-mode outcome as the CLI reports it (the setting may be on but not in effect). */
  private fastMode?: { state: "off" | "cooldown" | "on"; reason?: string };
  private storeKeys = new Map<string, SessionKey>();
  private sessionTitle?: string | null;
  private metadataTail: Promise<void> = Promise.resolve();
  private metadataPending?: { generation: number; dirty: boolean; promise: Promise<void> };
  /** Wrap startQuery's store so successful main-session appends schedule title refreshes.
   * Forward store failures unchanged and ignore appends from replaced queries; metadata refresh runs
   * independently so title reads cannot reject a committed append. Store lifecycle stays host-owned. */
  private observedStore(store: SessionStore, generation: number): SessionStore {
    return {
      append: async (key, entries) => {
        await store.append(key, entries);
        if (!key.subpath && key.sessionId === this.nativeId && generation === this.generation && !this.closed) void this.refreshMetadata();
      },
      load: store.load.bind(store),
      ...(store.listSessions ? { listSessions: store.listSessions.bind(store) } : {}),
      ...(store.listSubkeys ? { listSubkeys: store.listSubkeys.bind(store) } : {}),
      ...(store.delete ? { delete: store.delete.bind(store) } : {}),
      ...(store.listSessionSummaries ? { listSessionSummaries: store.listSessionSummaries.bind(store) } : {}),
    };
  }
  /** Coalesce store-append/open/terminal refreshes in generation order. Publish changed titles
   * through the sink; read failures publish a best-effort notice and never fail a committed append. */
  private refreshMetadata(): Promise<void> {
    const generation = this.generation, nativeId = this.nativeId;
    if (this.metadataPending?.generation === generation) {
      this.metadataPending.dirty = true;
      return this.metadataPending.promise;
    }
    const pending = { generation, dirty: true, promise: Promise.resolve() };
    pending.promise = this.metadataTail.then(async () => {
      try {
        while (pending.dirty && !this.closed && generation === this.generation && nativeId === this.nativeId) {
          pending.dirty = false;
          try {
            const info = await (this.adapter.options.getSessionInfo ?? getSessionInfo)(nativeId, { dir: this.params.cwd, sessionStore: this.adapter.sessionStore });
            if (!info || this.closed || generation !== this.generation || nativeId !== this.nativeId) continue;
            const title = info.summary.trim() || null;
            if (this.sessionTitle === title) continue;
            this.sessionTitle = title;
            await this.sink.emit({ type: "session/metadata", payload: { title } });
          } catch {
            // A metadata read must not reject a committed append or fail the turn.
            if (!this.closed && generation === this.generation) await this.sink.emit({ type: "notice", payload: { severity: "warning", code: "SESSION_METADATA_UNAVAILABLE", message: "Session title could not be refreshed" } }).catch(() => {});
          }
        }
      } finally { if (this.metadataPending === pending) this.metadataPending = undefined; }
    });
    this.metadataPending = pending;
    this.metadataTail = pending.promise;
    return pending.promise;
  }
  private get nativeId(): string { return this.binding.nativeRef!.value; }
  /** Let open distinguish an empty fork (new native query) from a transcript that must be resumed.
   * Store/history read failures reject open before query construction. */
  private async hasHistory(id: string): Promise<boolean> { return (await this.messages(id)).length > 0; }
  /** Accept native init/result fast-mode states and report whether the public snapshot changed. */
  private trackFastMode(value: Record<string, unknown>): boolean {
    const state = str(value.fast_mode_state);
    if (state !== "off" && state !== "cooldown" && state !== "on") return false;
    const reason = str(value.fast_mode_disabled_reason);
    const next = { state, ...(reason ? { reason } : {}) } as const;
    const changed = JSON.stringify(next) !== JSON.stringify(this.fastMode);
    this.fastMode = next;
    return changed;
  }
  /** Build state for open/config/message publications without exposing mutable binding/config objects. */
  private snapshot(): SessionState { return { ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}), binding: structuredClone(this.binding), status: this.active ? "running" : "ready", config: structuredClone(this.config), capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, ...(this.model ? { model: this.model } : {}), ...(this.fastMode ? { fastMode: this.fastMode } : {}), activeTurnIds: this.active ? [this.active.id] : [] }; }
  /** Construct a generation-specific query for open, restoreConversation or replaceOutputFormat,
   * then start background pumping and await resumed-title refresh. Fresh mode opens the current native
   * ID as a new session; resume mode reopens its transcript, optionally at resumeAt. Factory/setup
   * failures reject here; subsequent source failures are reported to the sink by pump. */
  private async startQuery({ mode, resumeAt }: QueryStart): Promise<void> {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const generation = ++this.generation;
    this.queryMode = mode;
    this.queryResumeAt = resumeAt;
    this.input = new BoundedEventQueue<SDKUserMessage>({ maxEvents: 64 });
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const server of this.params.mcpServers ?? []) mcpServers[server.name] = server.type === "stdio" ? { type: "stdio", command: server.command, args: server.args, env: server.env } : { type: "http", url: server.url, headers: server.headers };
    const options: Options = {
      ...this.adapter.queryOptions(this.params.cwd),
      ...(this.adapter.sessionStore ? { sessionStore: this.observedStore(this.adapter.sessionStore, generation) } : {}),
      ...(mode === "fresh" ? { sessionId: this.nativeId } : { resume: this.nativeId }),
      ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.params.instructions ? { systemPrompt: this.params.instructions } : {}),
      ...(this.config.permissionMode !== undefined || this.params.permissionMode ? { permissionMode: permission(this.config.permissionMode ?? this.params.permissionMode) } : {}),
      // Permit an explicit later mode switch; this flag does not select bypass mode.
      allowDangerouslySkipPermissions: true,
      ...(typeof this.config.maxThinkingTokens === "number" ? { maxThinkingTokens: this.config.maxThinkingTokens } : {}),
      ...(isEffort(this.config.effort) ? { effort: this.config.effort } : {}),
      ...(typeof this.config.fastMode === 'boolean' ? { settings: { fastMode: this.config.fastMode } } : {}),
      ...(this.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: this.outputSchema.schema } } : {}),
      mcpServers,
      canUseTool: async (toolName, input, details) => this.permissionRequest(toolName, input, details),
      onElicitation: async (request, details) => this.elicitationRequest(request, details),
    };
    this.query = (this.adapter.options.queryFactory ?? query)({ prompt: this.input, options });
    this.pumping = this.pump(this.query, generation);
    if (mode === "resume") await this.refreshMetadata();
  }
  /** Consume the query started by startQuery until closure/generation replacement. Fail SDK
   * observation on source errors or early EOF with pending work; never replay native input. */
  private async pump(stream: ClaudeQuery, generation: number): Promise<void> {
    try {
      for await (const message of stream) { if (this.closed || generation !== this.generation) return; await this.mapMessage(message); }
      if (!this.closed && generation === this.generation && (this.active || this.nativeInputs.size)) await this.sink.fail(new HarnessSdkError("CONNECTION_CLOSED", "Claude query ended before a result", false, true));
    } catch (cause) { if (!this.closed && generation === this.generation) await this.sink.fail(sdkError(cause, "CLAUDE_QUERY_FAILED", true)); }
  }
  /** Publish one active execution for native message or permission evidence; subsequent input
   * associations reuse it until a native terminal result clears the active slot. */
  private async beginExecution(userUuid: string = randomUUID()): Promise<ActiveTurn> {
    if (!this.active) {
      this.queryMode = "resume";
      this.queryResumeAt = undefined;
      this.active = { id: randomUUID(), userUuid, consumed: new Set(), output: new Map(), stoppedTools: new Map(), blockIndex: 0 };
      await this.sink.emit({ type: 'turn/started', payload: { turnId: this.active.id } });
    }
    return this.active;
  }
  /** Project pump messages into ordered sink events and native-input associations. Persist verified
   * turn mappings before terminal publication; sink/store failures reject into pump observation failure. */
  private async mapMessage(message: SDKMessage): Promise<void> {
    const value = record(message);
    const refused = str(value.refused_user_message_uuid);
    if (refused && this.nativeInputs.has(refused)) {
      await this.rejectInput(refused, { code: 'NATIVE_INPUT_REJECTED', message: 'Native input rejected' });
      return;
    }
    const mainReply = !value.parent_tool_use_id && (message.type === 'assistant' || message.type === 'stream_event' || message.type === 'result');
    const uuids = Array.isArray(value.user_message_uuids) ? value.user_message_uuids.filter((id): id is string => typeof id === 'string') : str(value.user_message_uuid) ? [String(value.user_message_uuid)] : [];
    // A message UUID is input identity. New UUID echoes inside an active native
    // loop bind additional inputs to that loop; they never create another turn.
    if (mainReply && (this.active || uuids.some(id => this.nativeInputs.has(id)) || this.nativeInputs.size && message.type !== 'result')) {
      if (message.type === 'result' && value.num_turns === 0 && !this.active) {
        for (const id of uuids) {
          if (!this.nativeInputs.has(id)) continue;
          await this.rejectInput(id, { code: 'NATIVE_INPUT_NOT_EXECUTED', message: 'Input ended without an execution' });
        }
        return;
      }
      await this.associateInputs(uuids);
    }
    const active = this.active;
    if (message.type === "system" && message.subtype === "init") {
      this.trackFastMode(value);
      if (message.session_id !== this.nativeId) {
        this.binding = { ...this.binding, nativeRef: { provider: "claude", value: message.session_id } };
        this.adapter.turnMaps.set(this.nativeId, this.turns); await this.fileStore?.saveTurnMap(this.nativeId, this.turns);
      }
      await this.sink.emit({ type: "session/state", payload: this.snapshot() }); return;
    }
    if (!active) { await this.notice(value); return; }
    if (message.type === "assistant") {
      if (!message.parent_tool_use_id) active.apiError = message.error;
      for (const block of message.message.content) await this.completeBlock(record(block), message.message.id, message.parent_tool_use_id !== null ? "subagent" : "main");
      return;
    }
    if (message.type === "stream_event") { await this.streamEvent(record(message.event)); return; }
    if (message.type === "user") {
      const body = record(message.message).content;
      if (Array.isArray(body)) for (const part of body) {
        const block = record(part); if (block.type !== "tool_result") continue;
        const toolId = str(block.tool_use_id); if (!toolId) continue;
        const previous = active.output.get(toolId);
        if (previous?.type === "toolCall") { const item = completeClaudeTool(previous, toolResult(block, value.tool_use_result)); active.output.set(toolId, item); await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id }); }
      }
      return;
    }
    if (message.type === "result") return this.completeTurn(message, active);
    if (message.type === "system" && typeof value.subtype === "string") {
      const subtype = value.subtype;
      if (subtype.startsWith("task_")) {
        const id = str(value.task_id); if (!id) return this.notice(value);
        const previous = active.output.get(`task:${id}`); const patch = record(value.patch);
        const status = str(value.status) ?? str(patch.status) ?? "running";
        const final = ["completed", "failed", "stopped", "killed"].includes(status);
        const item: Item = { id: `task:${id}`, type: "subagent", subagentId: id, state: status === "completed" ? "completed" : status === "failed" ? "failed" : final ? "interrupted" : "running", status: final ? status === "completed" ? "completed" : "failed" : "running", task: str(value.description) ?? str(patch.description) ?? str(value.summary), ...(str(value.tool_use_id) ? { parentItemId: str(value.tool_use_id) } : {}) };
        active.output.set(item.id, item);
        if (final) await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
        else if (!previous) await this.sink.emit({ type: "item/started", payload: { item } }, { turnId: active.id });
        else await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "patch", value: safe(item) } }, { turnId: active.id });
        return;
      }
      if (subtype.startsWith("hook_")) {
        const id = str(value.hook_id); if (!id) return this.notice(value);
        const previous = active.output.get(`hook:${id}`);
        const item: Item = { id: `hook:${id}`, type: "hook", name: str(value.hook_name) ?? "hook", status: subtype === "hook_response" ? value.outcome === "success" ? "completed" : "failed" : "running", ...(value.output !== undefined ? { output: safe(value.output) } : {}) };
        active.output.set(item.id, item);
        if (subtype === "hook_progress") { if (!previous) await this.sink.emit({ type: "item/started", payload: { item } }, { turnId: active.id }); await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "output", text: str(value.output) ?? "" } }, { turnId: active.id }); }
        else await this.sink.emit({ type: previous || subtype === "hook_response" ? "item/completed" : "item/started", payload: { item } }, { turnId: active.id });
        return;
      }
      if (subtype === "compact_boundary") { await this.sink.emit({ type: "item/completed", payload: { item: { id: str(value.uuid) ?? randomUUID(), type: "compaction", status: "completed", summary: str(value.summary), trigger: str(record(value.compact_metadata).trigger) } } }, { turnId: active.id }); return; }
    }
    await this.notice(value);
  }
  /** Publish mapMessage's native refusal/no-execution evidence before removing a pending input.
   * Unknown UUIDs are ignored; publication failure leaves the input retained and rejects into pump. */
  private async rejectInput(id: string, error: { code: string; message: string }): Promise<void> {
    const pending = this.nativeInputs.get(id);
    if (!pending) return;
    await this.sink.emit({ type: 'submission/status', payload: { submissionId: pending.submissionId, status: 'rejected', error: { ...error, retryable: false, outcomeUnknown: false } } });
    this.nativeInputs.delete(id);
  }
  /** Bind mapMessage's echoed UUIDs to the current execution and persist the verified map.
   * Native evidence can add inputs to an existing execution, but cannot move a bound input to a
   * different execution. Binding or store failures reject and are reported by pump. */
  private async associateInputs(uuids: string[]): Promise<void> {
    const execution = await this.beginExecution(uuids[0]);
    for (const id of uuids) {
      const pending = this.nativeInputs.get(id); if (!pending) continue;
      if (pending.turnId && pending.turnId !== execution.id) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native input changed executions');
      if (!pending.turnId) {
        pending.turnId = execution.id; execution.consumed.add(id); this.turns[id] = execution.id;
        await this.sink.bindSubmission(pending.submissionId, execution.id);
      }
    }
    this.adapter.turnMaps.set(this.nativeId, this.turns); await this.fileStore?.saveTurnMap(this.nativeId, this.turns);
  }
  /** Finish mapMessage's captured execution: validate final output, publish items and usage,
   * then clear only consumed input IDs before the terminal and ready-state events. A sink failure
   * rejects into pump; inputs omitted by native correlation remain pending rather than guessed. */
  private async completeTurn(message: Extract<SDKMessage, { type: "result" }>, active: ActiveTurn): Promise<void> {
    const value = record(message);
    const interrupted = str(message.stop_reason) === "interrupted" || str(value.terminal_reason) === "interrupted";
    let error = claudeTurnError(message, active.apiError);
    let structuredText: string | undefined;
    if (this.outputSchema && !error && !interrupted) {
      if (value.structured_output === undefined) {
        error = { code: 'CLAUDE_STRUCTURED_OUTPUT_MISSING', message: 'Claude completed without the requested structured output', retryable: false, outcomeUnknown: false };
      } else if (!this.outputSchema.validate(value.structured_output)) {
        error = { code: 'CLAUDE_STRUCTURED_OUTPUT_INVALID', message: 'Claude structured output does not match outputSchema', retryable: false, outcomeUnknown: false };
      } else structuredText = JSON.stringify(value.structured_output);
    }
    const resultText = !this.outputSchema && message.subtype === "success" ? message.result : undefined;
    const textItems = [...active.output.values()].filter((item) => item.type === "agentMessage" && item.status !== "completed");
    for (let index = 0; index < textItems.length; index++) {
      const item = textItems[index]!; if (item.type !== "agentMessage") continue;
      const completed: Item = { ...item, text: index === textItems.length - 1 && resultText !== undefined ? resultText : item.text, phase: !this.outputSchema && index === textItems.length - 1 ? "final" : "commentary", status: "completed" };
      active.output.set(item.id, completed); await this.sink.emit({ type: "item/completed", payload: { item: completed } }, { turnId: active.id });
    }
    if (!textItems.length && resultText) {
      const item: Item = { id: `${active.userUuid}:final`, type: "agentMessage", phase: "final", text: resultText, status: "completed" };
      await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
    }
    if (structuredText !== undefined) {
      const item: Item = { id: `${active.id}:structured-output`, type: 'agentMessage', phase: 'final', text: structuredText, status: 'completed' };
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: active.id });
    }
    const nativeUsage = record(message.usage);
    const usage = { provider: "claude", scope: "turn" as const, source: "native" as const, ...(typeof nativeUsage.input_tokens === "number" ? { input: nativeUsage.input_tokens } : {}), ...(typeof nativeUsage.output_tokens === "number" ? { output: nativeUsage.output_tokens } : {}), ...(typeof nativeUsage.cache_read_input_tokens === "number" ? { cacheRead: nativeUsage.cache_read_input_tokens } : {}), ...(typeof nativeUsage.cache_creation_input_tokens === "number" ? { cacheWrite: nativeUsage.cache_creation_input_tokens } : {}) };
    await this.sink.emit({ type: "usage/updated", payload: usage }, { turnId: active.id });
    const failed = error !== undefined;
    for (const pending of active.output.values()) {
      if (pending.type !== "toolCall" || pending.kind !== "fileChange" || pending.status === "completed" || pending.status === "failed") continue;
      const item: Item = { ...pending, status: active.stoppedTools.get(pending.id) ?? (interrupted ? "interrupted" : failed ? "failed" : undefined) };
      active.output.set(item.id, item);
      await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
    }
    this.active = undefined;
    for (const id of active.consumed) this.nativeInputs.delete(id);
    this.trackFastMode(value);
    await this.sink.emit({ type: "turn/completed", payload: { turnId: active.id, status: interrupted ? "interrupted" : failed ? "failed" : "completed", usage, ...(error && !interrupted ? { error } : {}) } });
    void this.refreshMetadata();
    // The init snapshot was taken mid-turn ("running"); publish the settled state.
    await this.sink.emit({ type: "session/state", payload: this.snapshot() });
  }
  /** Update the active turn from streamed content, publishing starts/deltas before final blocks.
   * mapMessage calls only with an active turn; sink rejection propagates to the query pump. */
  private async streamEvent(event: Record<string, unknown>): Promise<void> {
    const active = this.active!; const type = event.type;
    if (type === "message_start") { active.streamMessageId = str(record(event.message).id); return; }
    const index = typeof event.index === "number" ? event.index : 0;
    const id = `${active.streamMessageId ?? active.userUuid}:${index}`;
    if (type === "content_block_start") {
      const block = record(event.content_block);
      const blockId = str(block.id) ?? id;
      const status = this.active?.stoppedTools.get(blockId) ?? "running";
      const item = this.blockItem(block, blockId, status);
      active.output.set(item.id, item); await this.sink.emit({ type: "item/started", payload: { item } }, { turnId: active.id });
    } else if (type === "content_block_delta") {
      const delta = record(event.delta); const previous = active.output.get(id);
      if (!previous || (previous.type !== "agentMessage" && previous.type !== "reasoning")) return;
      const text = str(delta.text) ?? str(delta.thinking) ?? "";
      if (previous.type === "agentMessage") previous.text += text; else previous.text = (previous.text ?? "") + text;
      await this.sink.emit({ type: "item/delta", payload: { itemId: id, kind: previous.type === "reasoning" ? "reasoningSummary" : "text", text } }, { turnId: active.id });
    }
  }
  /** Project a live/history content block to a public item, preserving unknown native content safely. */
  private blockItem(block: Record<string, unknown>, id: string, status: NonNullable<Item["status"]>): Item {
    if (block.type === "text") return { id, type: "agentMessage", text: str(block.text) ?? "", phase: "commentary", status };
    if (block.type === "thinking") return { id, type: "reasoning", text: str(block.thinking) ?? "", status };
    if (block.type === "tool_use") {
      const name = str(block.name) ?? "unknown";
      const fileChanges = claudeFileChanges(name, block.input);
      return { id, type: "toolCall", kind: name === "Bash" ? "command" : ["Write", "Edit", "MultiEdit"].includes(name) ? "fileChange" : name.startsWith("mcp__") ? "mcp" : "other", title: name, input: safe(block.input), status, nativeType: name, ...(fileChanges !== undefined ? { fileChanges } : {}) };
    }
    return { id, type: "toolCall", kind: "other", title: "Unknown Claude content", nativeType: str(block.type) ?? "unknown", raw: safe(block), status };
  }
  /** Reconcile completeBlock with unfinished text/thinking streams before allocating a fallback ID.
   * Mutates the turn's fallback counter only when no native or unfinished-stream identity exists. */
  private resolveCompleteBlockId(block: Record<string, unknown>, messageId: string, active: ActiveTurn): string {
    const nativeBlockId = str(block.id);
    if (nativeBlockId) return nativeBlockId;

    // Only text and thinking reuse unfinished stream items, in Map insertion order.
    const existingStreamItem = [...active.output.values()].find((item) => {
      if (!item.id.startsWith(`${messageId}:`) || item.status === "completed") return false;
      if (block.type === "text") return item.type === "agentMessage";
      if (block.type === "thinking") return item.type === "reasoning";
      return false;
    });
    if (existingStreamItem) return existingStreamItem.id;

    return `${messageId}:${active.blockIndex++}`;
  }
  /** Merge a complete assistant block into active output and publish its start/patch/completion.
   * Text and tool calls stay pending until native result/tool evidence; sink failures reach pump. */
  private async completeBlock(block: Record<string, unknown>, messageId: string, context: "main" | "subagent"): Promise<void> {
    const active = this.active!;
    const id = this.resolveCompleteBlockId(block, messageId, active);
    const previous = active.output.get(id);
    const running = block.type === "text" || block.type === "tool_use";
    const status = this.active?.stoppedTools.get(id) ?? (running ? "running" : "completed");
    const item = this.blockItem(block, id, status);
    if (context === "subagent") item.extensions = { ...(item.extensions ?? {}), nativeParentTool: "subagent" };
    active.output.set(id, item);
    if (!previous) await this.sink.emit({ type: "item/started", payload: { item: { ...item, status: "running" } } }, { turnId: active.id });
    else if (block.type === "tool_use") await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "patch", value: safe(item) } }, { turnId: active.id });
    if (item.type !== "agentMessage" && block.type !== "tool_use") await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
  }
  /** Publish otherwise unmapped native messages through the sink with privacy-safe raw content. */
  private async notice(value: Record<string, unknown>): Promise<void> {
    const subtype = str(value.subtype) ?? str(value.type) ?? "unknown";
    await this.sink.emit({ type: "notice", payload: { severity: /error|denied|retry|rate_limit/.test(subtype) ? "warning" : "info", code: `CLAUDE_${subtype.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`, message: str(value.content) ?? str(value.message) ?? subtype, raw: safe(value) } }, this.active ? { turnId: this.active.id } : {});
  }
  /** Native canUseTool callback registered by startQuery. Await SDK approval/user answers or
   * native cancellation, translating unavailable interactions to denial and removing the abort listener.
   * The sink registers the responder; Session/InteractionRegistry invokes it for answers or teardown.
   * Execution-start publication failures reject this native callback before interaction registration. */
  private async permissionRequest(toolName: string, input: Record<string, unknown>, details: Parameters<NonNullable<Options["canUseTool"]>>[2]): Promise<PermissionResult> {
    // A native tool permission request is execution evidence even when the SDK
    // callback arrives before its assistant message. Binding still waits for UUID evidence.
    if (!this.active && this.nativeInputs.size) await this.beginExecution();
    const turnId = this.active?.id;
    if (!turnId) return { behavior: "deny", message: "No active AHP turn" };
    const interactionId = details.toolUseID;
    const rawQuestions = Array.isArray(input.questions) ? input.questions.map(record) : [];
    const isUserQuestionRequest = toolName === "AskUserQuestion" && rawQuestions.length > 0 && rawQuestions.every((question) => typeof question.question === "string");
    const request = isUserQuestionRequest
      ? this.createUserQuestionRequest(interactionId, turnId, details.toolUseID, rawQuestions)
      : this.createToolApprovalRequest({ interactionId, turnId, toolName, input, details });
    return new Promise<PermissionResult>((resolve) => {
      let answered = false; const finish = (result: PermissionResult) => { if (!answered) { answered = true; details.signal.removeEventListener("abort", abort); resolve(result); } };
      const abort = () => { void this.sink.resolveInteraction({ interactionId, outcome: "expired", reason: "native_cancelled" }); finish({ behavior: "deny", message: "Request cancelled" }); };
      details.signal.addEventListener("abort", abort, { once: true });
      void this.sink.requestInteraction(request, async (answer) => {
        const stopped = !answer ? "interrupted" : answer.kind === "approval" && answer.optionId === "deny" ? "declined" : undefined;
        if (stopped && this.active?.id === turnId) {
          this.active.stoppedTools.set(details.toolUseID, stopped);
          const previous = this.active.output.get(details.toolUseID);
          if (previous?.type === "toolCall") {
            const item: Item = { ...previous, status: stopped }; this.active.output.set(item.id, item);
            await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "patch", value: safe(item) } }, { turnId });
          }
        }
        if (!answer) finish({ behavior: "deny", message: "Request cancelled" });
        else if (answer.kind === "approval") finish(answer.optionId === "deny" ? { behavior: "deny", message: "User denied tool execution" } : { behavior: "allow", updatedInput: input, ...(answer.optionId === "allow-session" ? { updatedPermissions: details.suggestions?.filter((entry) => entry.destination === "session") } : {}) });
        else if (answer.kind === "userInput") finish({
          behavior: "allow",
          updatedInput: {
            ...input,
            answers: Object.fromEntries(rawQuestions.map((question, index) => [
              str(question.question)!, answer.answers[`q${index}`],
            ])),
          },
        });
        else finish({ behavior: "deny", message: "Invalid response" });
      }).catch(() => finish({ behavior: "deny", message: "Interaction unavailable" }));
    });
  }
  /** Build stable qN question identities for permissionRequest so answers map back to native text. */
  private createUserQuestionRequest(interactionId: string, turnId: string, itemId: string, rawQuestions: Record<string, unknown>[]): InteractionRequested {
    return {
      interactionId,
      kind: "userInput",
      turnId,
      itemId,
      questions: rawQuestions.map((question, index) => ({
        // Answers above use the same zero-based qN IDs to recover the native question text.
        id: `q${index}`,
        prompt: str(question.question)!,
        ...(Array.isArray(question.options) ? {
          options: question.options.map((option) => ({
            id: str(record(option).label) ?? String(option),
            label: str(record(option).label) ?? String(option),
          })),
        } : {}),
        ...(question.secret === true ? { secret: true } : {}),
      })),
    };
  }
  /** Offer only native-supported allow scopes to permissionRequest; session grants require suggestions. */
  private createToolApprovalRequest(
    { interactionId, turnId, toolName, input, details }: {
      interactionId: string; turnId: string; toolName: string; input: Record<string, unknown>;
      details: Parameters<NonNullable<Options["canUseTool"]>>[2];
    },
  ): InteractionRequested {
    return {
      interactionId,
      kind: "approval",
      turnId,
      itemId: details.toolUseID,
      title: details.title ?? toolName,
      input: safe(input),
      options: [
        { id: "allow-once", label: "Allow once", semantic: "allowOnce" },
        ...(details.suggestions?.some((entry) => entry.destination === "session") ? [
          { id: "allow-session", label: "Allow for this session", semantic: "allowSession" as const },
        ] : []),
        { id: "deny", label: "Deny", semantic: "deny" },
      ],
    };
  }
  /** Native onElicitation callback registered by startQuery. Await a sink-delivered answer or native
   * abort; map abort/unavailable interactions to cancellation and remove the abort listener on completion.
   * The native answer can finish before the sink publishes interaction/resolved.
   * Session/InteractionRegistry invokes the registered responder; unrepresentable form content rejects
   * responder delivery while the failed interaction wait cancels the native callback. */
  private async elicitationRequest(request: Parameters<NonNullable<Options["onElicitation"]>>[0], details: Parameters<NonNullable<Options["onElicitation"]>>[1]): Promise<Awaited<ReturnType<NonNullable<Options["onElicitation"]>>>> {
    const interactionId = details.requestId;
    const ahp: InteractionRequested = { interactionId, kind: "elicitation", mode: request.mode ?? "form", ...(this.active ? { turnId: this.active.id } : {}), message: request.message, ...(request.requestedSchema ? { schema: json(request.requestedSchema) as JsonObject } : {}), ...(request.url ? { privatePayload: { url: request.url }, privatePayloadAvailable: true } : {}) };
    return new Promise((resolve) => {
      let answered = false; const finish = (value: NonNullable<Awaited<ReturnType<NonNullable<Options["onElicitation"]>>>>) => { if (!answered) { answered = true; details.signal.removeEventListener("abort", abort); resolve(value); } };
      const abort = () => { void this.sink.resolveInteraction({ interactionId, outcome: "expired", reason: "native_cancelled" }); finish({ action: "cancel" }); };
      details.signal.addEventListener("abort", abort, { once: true });
      void this.sink.requestInteraction(ahp, async (answer) => finish(answer?.kind === "elicitation" ? { action: answer.action, ...(answer.content ? { content: elicitationContent(answer.content) } : {}) } : { action: "cancel" })).catch(() => finish({ action: "cancel" }));
    });
  }
  /** Read native history for boundary/history callers through the supplied public store. Capture
   * the SDK-derived store key for opaque attachment reads; reject absent stores and read failures. */
  private async messages(nativeId = this.nativeId): Promise<SessionMessage[]> {
    const store = this.adapter.sessionStore; if (!store) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    // Let the SDK derive its own project key. Observing that public load key avoids copying
    // the SDK's cwd-sanitization algorithm or reading its private transcript paths.
    const scoped: SessionStore = {
      append: store.append.bind(store),
      load: async (key) => { if (key.sessionId === nativeId && !key.subpath) this.storeKeys.set(nativeId, key); return store.load(key); },
      ...(store.listSessions ? { listSessions: store.listSessions.bind(store) } : {}),
      ...(store.listSubkeys ? { listSubkeys: store.listSubkeys.bind(store) } : {}),
    };
    return (this.adapter.options.getSessionMessages ?? getSessionMessages)(nativeId, { dir: this.params.cwd, sessionStore: scoped, includeSystemMessages: true });
  }
  /** Resolve open/revert boundaries from verified prompt identities and opaque store entries.
   * Reject missing turns; retain transcript-only trailing entries when selecting a through boundary. */
  private async boundaryPoint(nativeId: string, boundary: Boundary): Promise<BoundaryPoint> {
    if (!this.adapter.sessionStore) {
      const promptUuid = boundary.nativeTurnId ?? Object.entries(this.turns).find(([, turn]) => turn === boundary.turnId)?.[0];
      if (!promptUuid) throw new HarnessSdkError("TURN_NOT_FOUND");
      const prompts = Object.keys(this.turns); const index = prompts.indexOf(promptUuid);
      return { promptUuid, ...(index >= 0 && prompts[index + 1] ? { nextPromptUuid: prompts[index + 1] } : {}) };
    }
    const messages = await this.messages(nativeId);
    const turns = this.fileStore ? await this.fileStore.loadTurnMap(nativeId) : this.adapter.turnMaps.get(nativeId) ?? this.turns;
    const promptUuid = boundary.nativeTurnId ?? Object.entries(turns).find(([, id]) => id === boundary.turnId)?.[0];
    if (!promptUuid) throw new HarnessSdkError("TURN_NOT_FOUND", "No verified native turn boundary");
    const index = messages.findIndex((message) => message.uuid === promptUuid && isPrompt(message));
    if (index < 0) throw new HarnessSdkError("TURN_NOT_FOUND");
    const next = messages.findIndex((message, position) => position > index && isPrompt(message));
    let uuid = boundary.relation === "before" ? index > 0 ? messages[index - 1]!.uuid : undefined : messages[(next >= 0 ? next : messages.length) - 1]!.uuid;
    const key = this.storeKeys.get(nativeId);
    if (boundary.relation === "through" && key) {
      const entries = await this.adapter.sessionStore!.load(key);
      if (entries) {
        const start = entries.findIndex((entry) => entry.uuid === promptUuid);
        const end = next >= 0 ? entries.findIndex((entry) => entry.uuid === messages[next]!.uuid) : entries.length;
        if (start < 0 || end < start) throw new HarnessSdkError("TURN_NOT_FOUND");
        // Preserve structured-output and transcript-only trailing entries too; their
        // opaque payloads are neither decoded nor synthesized.
        const last = entries.slice(start, end).reverse().find((entry) => typeof entry.uuid === "string");
        if (last?.uuid) uuid = last.uuid;
      }
    }
    return { promptUuid, ...(next >= 0 ? { nextPromptUuid: messages[next]!.uuid } : {}), ...(uuid ? { uuid } : {}) };
  }
  /** Restore execute's requested file/conversation scope only while idle. Drain the old query
   * before replacement; reject partial restoration with applied-scope metadata without undoing an
   * already-applied restoration phase on failure. */
  private async revert(request: AhpRequestMap['session/revert']): Promise<AhpResultMap['session/revert']> {
    const query = this.query;
    if (this.closed || !query) throw new HarnessSdkError('SESSION_CLOSED');
    if (this.reverting || this.active || this.nativeInputs.size) throw new HarnessSdkError('SESSION_BUSY', 'Claude revert requires no active or pending inputs');
    this.reverting = true;
    try {
      const point = await this.boundaryPoint(this.nativeId, request.boundary);
      if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
      let appliedFiles = false;
      if (request.scope === 'files' || request.scope === 'both') {
        await this.restoreFiles(query, request.boundary, point);
        appliedFiles = true;
      }
      if (request.scope !== 'files') {
        try {
          await this.restoreConversation(query, point);
        } catch (cause) {
          if (appliedFiles) throw new HarnessSdkError('REVERT_PARTIAL', 'Files were restored but conversation restore could not be confirmed', false, true, { appliedScope: 'files' });
          throw sdkError(cause, 'CLAUDE_REVERT_FAILED', true);
        }
      }
      return { appliedScope: request.scope, boundary: request.boundary, nativeRef: this.binding.nativeRef };
    } finally { this.reverting = false; }
  }
  /** Revert's file phase verifies a checkpoint with a dry run before applying it. Recheck close
   * after preview; a failed/partial native rewind rejects without attempting conversation restore. */
  private async restoreFiles(query: ClaudeQuery, boundary: Boundary, point: BoundaryPoint): Promise<void> {
    if (!this.adapter.options.enableFileCheckpointing) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED');
    const checkpoint = boundary.relation === 'before' ? point.promptUuid : point.nextPromptUuid;
    if (!checkpoint) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'No verified post-turn checkpoint exists');
    const preview = await query.rewindFiles(checkpoint, { dryRun: true });
    if (!preview.canRewind) throw new HarnessSdkError('CHECKPOINT_UNAVAILABLE');
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const rewound = await query.rewindFiles(checkpoint);
    if (!rewound.canRewind || rewound.skippedLinks) throw new HarnessSdkError('REVERT_PARTIAL', 'Some files could not be restored', false, true, { appliedScope: 'files' });
  }
  /** Revert's conversation phase forks at the verified cutoff, drains the old query, then publishes
   * the replacement binding/state. Recheck close after native waits so disposal cannot reopen work;
   * revert translates failure to a partial result when its file phase already applied. */
  private async restoreConversation(query: ClaudeQuery, point: BoundaryPoint): Promise<void> {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const native = point.uuid ? await (this.adapter.options.forkSession ?? forkSession)(this.nativeId, { dir: this.params.cwd, sessionStore: this.adapter.sessionStore, upToMessageId: point.uuid }) : { sessionId: randomUUID() };
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    this.generation++; this.input?.end();
    await this.releaseQuery(query); await this.pumping;
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    this.binding = { ...this.binding, nativeRef: { provider: 'claude', value: native.sessionId } };
    this.adapter.turnMaps.set(this.nativeId, this.turns); await this.fileStore?.saveTurnMap(this.nativeId, this.turns);
    await this.startQuery({ mode: point.uuid ? "resume" : "fresh" }); await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
  }
  /** Admit execute's bounded input and enqueue native content, returning a dispatch receipt.
   * Changed schemas replace an idle query first; rejection never retries or replays the new input. */
  private async submitInput(start: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (this.closed || !this.input) throw new HarnessSdkError('SESSION_CLOSED');
    if (this.reverting) throw new HarnessSdkError('SESSION_BUSY', 'Claude input cannot be submitted during revert');
    // Native association echoes are bounded to 64 UUIDs. Do not admit more
    // unresolved inputs than we can correlate without guessing.
    if (this.nativeInputs.size >= 64) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED');
    const nativeContent = content(start.input);
    const changing = !isDeepStrictEqual(this.outputSchema?.schema, start.outputSchema);
    if (changing && (this.active || this.nativeInputs.size || this.configOperations)) throw new HarnessSdkError('SESSION_BUSY', 'Claude output format can change only with no active execution, pending input or configuration change');
    const outputSchema = changing && start.outputSchema !== undefined ? compileOutputSchema(start.outputSchema) : undefined;
    if (changing) this.switchingOutput = true;
    try {
      // Do not yield admission for an unchanged format: another submission could
      // otherwise start a switch before this input is recorded as pending.
      if (changing) await this.replaceOutputFormat(outputSchema);
      if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
      const userUuid = randomUUID();
      this.nativeInputs.set(userUuid, { submissionId: start.submissionId });
      try {
        this.input!.push({ type: 'user', uuid: userUuid, session_id: this.nativeId,
          message: { role: 'user', content: nativeContent }, parent_tool_use_id: null,
          priority: start.delivery === 'afterTurn' ? 'later' : 'next' });
        return { submissionId: start.submissionId, disposition: 'dispatched' };
      } catch (cause) { this.nativeInputs.delete(userUuid); throw cause; }
    } finally { if (changing) this.switchingOutput = false; }
  }
  /** Drain and replace the query for submitInput before enqueueing its input. Latch startup/cleanup
   * failure for later operations; input remains undispatched and caller-owned retry policy stays explicit. */
  private async replaceOutputFormat(outputSchema?: OutputSchema): Promise<void> {
    const query = this.query!, pumping = this.pumping;
    this.generation++;
    this.input?.end();
    try {
      // Query.return() awaits the official SDK's mirror flush and cleanup.
      await this.releaseQuery(query);
      await pumping;
      if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
      this.query = undefined;
      this.outputSchema = outputSchema;
      await this.startQuery({ mode: this.queryMode, resumeAt: this.queryResumeAt });
    } catch (cause) {
      const error = sdkError(cause, 'CLAUDE_OUTPUT_FORMAT_FAILED');
      // The new input has not been enqueued. Never replay it to recover a Query.
      const failure = new HarnessSdkError(error.code, error.message, false, false, error.details);
      if (!this.closed) this.queryFailure = failure;
      throw failure;
    }
  }
  /** Share query close/return completion across replacement, revert and disposal. Attempt both
   * stages and reject RESOURCE_RELEASE_FAILED with safe codes when either fails. */
  private releaseQuery(query: ClaudeQuery): Promise<void> {
    const previous = this.queryReleases.get(query);
    if (previous) return previous;
    const release = Promise.resolve().then(async () => {
      const errors: Array<{ code: string }> = [];
      try { query.close(); } catch { errors.push({ code: 'CLAUDE_CLOSE_FAILED' }); }
      try { await (query as ClaudeQuery & Partial<Pick<Query, 'return'>>).return?.(); } catch { errors.push({ code: 'CLAUDE_RETURN_FAILED' }); }
      if (errors.length) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Claude resources were not fully released', false, true, { errors });
    });
    this.queryReleases.set(query, release);
    return release;
  }
  /** Build/reuse one of eight retained history snapshots for execute, then clone the requested page.
   * A new snapshot projects native entries before loading structured-output attachments. Reject expired
   * snapshots, invalid offsets or store failures; pagination reuses the snapshot without rereading it. */
  private async readHistory(request: AhpRequestMap["history/read"]): Promise<HistoryPage> {
    let snapshotToken = request.snapshotToken;
    if (!snapshotToken) {
      const items = this.projectHistory(await this.messages());
      const withStructuredOutput = await this.structuredHistory(items);
      snapshotToken = randomUUID(); this.historySnapshots.set(snapshotToken, withStructuredOutput);
      if (this.historySnapshots.size > 8) this.historySnapshots.delete(this.historySnapshots.keys().next().value!);
    }
    const snapshot = this.historySnapshots.get(snapshotToken); if (!snapshot) throw new HarnessSdkError("CURSOR_EXPIRED");
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.length) throw new HarnessSdkError("CURSOR_INVALID");
    const limit = Math.min(request.limit ?? 200, 1000); const page = snapshot.slice(offset, offset + limit);
    return { items: structuredClone(page), ...(offset + page.length < snapshot.length ? { nextCursor: String(offset + page.length) } : {}), snapshotToken, source: this.binding.nativeRef };
  }
  /** Reconstruct readHistory's live-compatible item IDs and tool results from ordered native entries.
   * Keep grouping and per-API-message block counters local to this snapshot; tool results amend only
   * an earlier call in the same turn, and unmatched results remain visible as unknown content. */
  private projectHistory(messages: SessionMessage[]): HistoryItem[] {
    const items: HistoryItem[] = []; let currentTurn = "native:session"; let currentNativeTurn: string | undefined;
    // Transcripts split one API message across entries; live items use `${apiMessageId}:${contentBlockIndex}`, so count blocks per API message.
    const blockCounts = new Map<string, number>();
    for (const message of messages) {
      if (isPrompt(message)) { currentTurn = this.turns[message.uuid] ?? `native:${message.uuid}`; currentNativeTurn = message.uuid; }
      const body = record(message.message).content;
      const blocks = typeof body === "string" ? [{ type: "text", text: body }] : Array.isArray(body) ? body.map(record) : [];
      if (message.type === "user" && isPrompt(message)) items.push({ turnId: currentTurn, nativeTurnId: message.uuid, nativeItemId: message.uuid, item: { id: message.uuid, type: "userMessage", content: blocks.filter((block) => block.type === "text").map((block) => ({ type: "text", text: str(block.text) ?? "" })), status: "completed" } });
      else for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!;
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          let previous: HistoryItem | undefined;
          for (let position = items.length - 1; position >= 0; position--) { const candidate = items[position]!; if (candidate.turnId === currentTurn && candidate.item.id === block.tool_use_id && candidate.item.type === "toolCall") { previous = candidate; break; } }
          if (previous?.item.type === "toolCall") { previous.item = completeClaudeTool(previous.item, toolResult(block, record(message).tool_use_result)); continue; }
        }
        const apiMessageId = str(record(message.message).id); const blockIndex = apiMessageId ? blockCounts.get(apiMessageId) ?? 0 : index;
        if (apiMessageId) blockCounts.set(apiMessageId, blockIndex + 1);
        const id = str(block.id) ?? `${apiMessageId ?? message.uuid}:${blockIndex}`;
        const running = block.type === "tool_use";
        const status = this.active?.stoppedTools.get(id) ?? (running ? "running" : "completed");
        const item = this.blockItem(block, id, status);
        if (block.type === "tool_use") delete item.status;
        items.push({ turnId: currentTurn, ...(currentNativeTurn ? { nativeTurnId: currentNativeTurn } : {}), nativeItemId: message.uuid, item });
      }
    }
    return items;
  }
  /** Add saved structured-output attachments only for tool calls surviving readHistory's transcript.
   * Read the captured public-store key; missing keys leave history unchanged and load failures reject. */
  private async structuredHistory(items: HistoryItem[]): Promise<HistoryItem[]> {
    const key = this.storeKeys.get(this.nativeId), store = this.adapter.sessionStore;
    if (!key || !store) return items;
    // The public history helper omits attachments. Only expose native output
    // attachments linked to a StructuredOutput call surviving in that history.
    const calls = new Map(items.flatMap(entry => entry.item.type === 'toolCall' && entry.item.nativeType === 'StructuredOutput' ? [[entry.item.id, entry] as const] : []));
    if (!calls.size) return items;
    const finals = new Map<string, HistoryItem>();
    for (const entry of await store.load(key) ?? []) {
      if (entry.type !== 'attachment' || entry.isSidechain || entry.teamName) continue;
      const attachment = record(entry.attachment), call = calls.get(str(attachment.toolUseID) ?? '');
      if (attachment.type !== 'structured_output' || attachment.data === undefined || !call) continue;
      finals.set(call.turnId, {
        turnId: call.turnId, ...(call.nativeTurnId ? { nativeTurnId: call.nativeTurnId } : {}), ...(typeof entry.uuid === 'string' ? { nativeItemId: entry.uuid } : {}),
        item: { id: `${call.turnId}:structured-output`, type: 'agentMessage', phase: 'final', status: 'completed', text: JSON.stringify(attachment.data) },
      });
    }
    const last = new Map(items.map((entry, index) => [entry.turnId, index]));
    return items.flatMap((entry, index) => {
      const final = finals.get(entry.turnId);
      return final && last.get(entry.turnId) === index ? [entry, final] : [entry];
    });
  }
}
/** Construct the adapter supplied to createClient without opening Claude. The client initializes
 * and disposes it through its output wrapper; direct adapter consumers initialize before session opens
 * and await disposal after use. Options and injected store lifecycle remain host-owned. */
export function createClaudeAdapter(options?: ClaudeAdapterOptions): ClaudeNativeAdapter { return new ClaudeNativeAdapter(options); }
export { FileSessionStore } from "./store";

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
/** Normalize native values to JSON; absent or unserializable content becomes null. */
function json(value: unknown): JsonValue { try { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; } catch { return null; } }
/** Apply the protocol privacy projection to JSON-normalized native event/history content. */
function safe(value: unknown): JsonValue { return publicValue(json(value)); }
/** Share live/history tool-result privacy projection before completeClaudeTool derives output and edits. */
function toolResult(block: Record<string, unknown>, structuredContent: unknown): Record<string, unknown> {
  return { ...block, content: safe(block.content), ...(structuredContent !== undefined ? { structuredContent: safe(structuredContent) } : {}) };
}
/** Translate SDK elicitation answers to native MCP field shapes; reject unrepresentable content. */
function elicitationContent(value: JsonObject): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean" || (Array.isArray(field) && field.every((entry) => typeof entry === "string"))) content[key] = field as string | number | boolean | string[];
    else throw new HarnessSdkError("INVALID_PARAMS", "Elicitation response cannot be represented by MCP");
  }
  return content;
}
const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];
// Claude's effort levels (Options.effort); per-model support is reported by supportedModels().supportedEffortLevels.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = typeof EFFORT_LEVELS[number];
const isEffort = (value: unknown): value is Effort => typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
/** Validate native permission configuration before query setup or an explicit mode change. */
function permission(value: unknown): PermissionMode { if (typeof value !== "string" || !PERMISSION_MODES.includes(value as PermissionMode)) throw new HarnessSdkError("INVALID_PARAMS", "Unsupported permission mode"); return value as PermissionMode; }
/** Share capability projection between adapter negotiation and newly constructed backend sessions. */
function capabilities({ store, checkpoints }: { store: boolean; checkpoints: boolean }): Capabilities {
  return {
    session: { resume: store, fork: store ? ["before", "through"] : [], revert: [...(store ? ["conversation" as const] : []), ...(checkpoints ? ["files" as const] : []), ...(store && checkpoints ? ["both" as const] : [])], history: store },
    input: { delivery: ['native', 'afterTurn'], interrupt: { targets: ['session'], reportsPendingInputs: true } },
    turn: { outputSchema: true, overrides: [], inputModalities: ["text", "image"] },
    interactions: ["approval", "userInput", "elicitation"], subagents: { events: "nested" },
    mcp: { stdio: true, http: true, elicitation: ["form", "url"] },
    config: { options: [{ id: "model", scope: "session", schema: { type: "string", minLength: 1 } }, { id: "permissionMode", title: "Permissions", scope: "session", schema: { type: "string", enum: PERMISSION_MODES, default: "default" } }, { id: "effort", title: "Effort", scope: "session", schema: { type: "string", enum: [...EFFORT_LEVELS], default: "high" } }, { id: "fastMode", title: "Fast mode", scope: "session", schema: { type: "boolean", default: false } }, { id: "maxThinkingTokens", scope: "session", schema: { type: ["integer", "null"], minimum: 0 } }] },
  };
}
/** Forward only launch/platform essentials before explicit host environment overrides are applied. */
function basicEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "USER", "LOGNAME", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
/** Translate admitted input to Claude text/image blocks; reject unsupported modalities before enqueue. */
function content(input: InputBlock[]): SDKUserMessage["message"]["content"] {
  return input.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.type === "image" && block.data && block.mimeType && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(block.mimeType)) return { type: "image" as const, source: { type: "base64" as const, data: block.data, media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" } };
    if (block.type === "image" && block.url) return { type: "image" as const, source: { type: "url" as const, url: block.url } };
    throw new HarnessSdkError("CAPABILITY_UNSUPPORTED", "Input cannot be represented by the Claude SDK");
  });
}
/** Distinguish real user prompts from tool-result-only entries for history grouping and boundaries. */
function isPrompt(message: SessionMessage): boolean {
  if (message.type !== "user") return false;
  const body = record(message.message).content;
  return typeof body === "string" || (Array.isArray(body) && body.some((part) => record(part).type !== "tool_result"));
}

/** Verified prompt/checkpoint and transcript cutoff identities resolved before fork or revert. */
interface BoundaryPoint { uuid?: string; promptUuid: string; nextPromptUuid?: string }

/** Query startup identity retained by schema replacement until beginExecution observes native work. */
type QueryStart = { mode: "fresh" | "resume"; resumeAt?: string };

/** Per-execution output/correlation state, released only after native terminal evidence. */
interface ActiveTurn { id: string; userUuid: string; consumed: Set<string>; output: Map<string, Item>; stoppedTools: Map<string, "declined" | "interrupted">; streamMessageId?: string; blockIndex: number; apiError?: Extract<SDKMessage, { type: 'assistant' }>['error'] }
