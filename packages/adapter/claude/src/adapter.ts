// Owns Claude query launch, session command dispatch and native execution observation.
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
  type BackendSession, type HarnessAdapter, type NativeInteractionResponder, type SessionEventSink, type SessionMethod,
} from "@anureo/sdk";
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, publicValue, validateJsonSchema,
  type Capabilities, type AhpRequestMap, type AhpResultMap, type HarnessError, type HistoryItem, type HistoryPage,
  type InitializeParams, type InitializeResult, type InputBlock, type InteractionRequested,
  type Item, type JsonObject, type JsonValue, type SessionBinding, type SessionOpenParams, type SessionState, type Boundary,
} from "@anureo/protocol";
import { FileSessionStore } from "./store";
import { compileOutputSchema, type OutputSchema } from './output-schema';
import { claudeTurnError } from './turn-error';

/** Connect a client to Claude queries and retain ownership of opened backend sessions.
 * createClient initializes and disposes this adapter through its output wrapper; direct consumers
 * initialize before opening sessions and await disposal when finished. */
export class ClaudeNativeAdapter implements HarnessAdapter {
  /** Select the launch environment and store without starting Claude. stateDir takes precedence
   * for adapter storage. With defaultHome enabled, an explicitly supplied CLAUDE_CONFIG_DIR is
   * forwarded as supplied. */
  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    const stateDir = options.stateDir ?? options.env?.CLAUDE_CONFIG_DIR;
    this.env = { ...basicEnvironment(), ...options.env, ...(stateDir && !options.defaultHome ? { CLAUDE_CONFIG_DIR: stateDir } : {}) };
    if (!options.sessionStore && stateDir) this.defaultStore = new FileSessionStore(join(stateDir, "ahp-session-store"));
    this.sessionStore = options.sessionStore ?? this.defaultStore;
  }
  /** Report store/checkpoint-dependent support without native discovery or resource acquisition. */
  get capabilities(): Capabilities { return capabilities({ store: !!this.sessionStore, checkpoints: !!this.options.enableFileCheckpointing }); }
  /** Negotiate protocol support for Client.initialize through withStructuredOutput. Reject invalid
   * negotiation, a disposed adapter, or an absent Claude home unless defaultHome or a query
   * factory is supplied. Native launch is deferred to discovery or a session open. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    if (this.disposed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (!this.env.CLAUDE_CONFIG_DIR && !this.options.defaultHome && !this.options.queryFactory) throw new HarnessSdkError("HARNESS_CONFIG_INVALID", "Claude requires an explicit isolated CLAUDE_CONFIG_DIR");
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: "claude", version: "0.3.265", adapter: "claude-native/0.1.0" }, capabilities: this.capabilities };
  }
  /** Open and retain a backend for OutputSession.open to attach. Await resume/fork setup, query
   * construction and any resumed-title refresh. Native handshake and execution events arrive
   * independently through the sink. Setup errors reject the open. The client disposes the backend
   * it attaches, and adapter disposal also releases retained sessions. */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (params.binding.adapterId !== "claude" && params.binding.adapterId !== "claude-native") throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    const session = new ClaudeBackendSession(this, params, sink, this.defaultStore);
    await session.open();
    this.sessions.add(session);
    return session;
  }
  /** Read model metadata with a one-shot query using cwd, which defaults to process.cwd().
   * The adapter supplies an empty input stream and closes the query after discovery. Startup,
   * discovery and close failures reject, with a close failure taking precedence over discovery. */
  async listModels(cwd = process.cwd()): Promise<Awaited<ReturnType<Query["supportedModels"]>>> {
    const input = new BoundedEventQueue<SDKUserMessage>();
    const stream = (this.options.queryFactory ?? query)({ prompt: input, options: this.queryOptions(cwd) });
    try { return await stream.supportedModels(); } finally { input.end(); stream.close(); }
  }
  /** Build native launch options for internal use without starting a query. listModels uses them
   * directly. ClaudeBackendSession.sessionQueryOptions and createClaudeCatalogSession's openConnection
   * add their own options. The operation that starts the query owns its cleanup. */
  queryOptions(cwd: string): Options {
    return {
      cwd, env: this.env, settingSources: [], persistSession: true,
      includePartialMessages: true, includeHookEvents: true,
      ...(this.options.command ?? this.options.executable ? { pathToClaudeCodeExecutable: this.options.command ?? this.options.executable } : {}),
      ...(this.options.executableRuntime ? { executable: this.options.executableRuntime } : {}),
      ...(this.options.args?.length ? {
        // Read host arguments at spawn time, when the native SDK supplies its own launch arguments.
        spawnClaudeCodeProcess: (options) => spawn(options.command, [...options.args, ...this.options.args!], {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
        }),
      } : {}),
      ...(this.sessionStore ? { sessionStore: this.sessionStore, sessionStoreFlush: "eager" as const } : {}),
      enableFileCheckpointing: this.options.enableFileCheckpointing ?? false,
    };
  }
  /** Release retained sessions. Await all attempts and reject with the first cleanup failure in
   * registry order. Once disposal starts, subsequent calls resolve independently of that cleanup. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const results = await Promise.allSettled([...this.sessions].map(session => session.dispose()));
    this.sessions.clear();
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
  /** Internal map from native session ID to the input UUIDs verified against SDK turns.
   * Backend sessions reuse it across in-memory resume and copy it for forks. */
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
  /** Resolve resume/fork state and start a query for ClaudeNativeAdapter.openSession. Store,
   * boundary and query-setup failures reject before the adapter registers the backend. */
  async open(): Promise<void> {
    if (this.params.mode === "resume" && !this.params.binding.nativeRef) throw new HarnessSdkError("SESSION_NOT_FOUND");
    if (this.params.mode === "fork") {
      if (!this.params.fork?.nativeRef) throw new HarnessSdkError("SESSION_NOT_FOUND");
      const source = this.params.fork.nativeRef.value;
      const point = await this.boundaryPoint(source, this.params.fork.boundary);
      const forked = point.uuid ? await this.forkTranscript(source, point.uuid) : { sessionId: randomUUID() };
      this.binding = { ...this.binding, nativeRef: { provider: "claude", value: forked.sessionId } };
      this.turns = this.fileStore ? await this.fileStore.loadTurnMap(source) : structuredClone(this.adapter.turnMaps.get(source) ?? {});
    } else this.turns = this.fileStore ? await this.fileStore.loadTurnMap(this.nativeId) : this.adapter.turnMaps.get(this.nativeId) ?? {};
    await this.rememberTurnMap();
    const fresh = this.params.mode === "new" || (this.params.mode === "fork" && !await this.hasHistory(this.nativeId));
    await this.startQuery({ mode: fresh ? "fresh" : "resume" });
  }
  /** Dispatch requests forwarded by OutputSession.execute. Submission returns after enqueueing
   * native input. Association and terminal results arrive through the sink. Busy or unsupported
   * operations and native failures reject. Close awaits query cleanup with execution stop unconfirmed. */
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.closed) throw new HarnessSdkError("SESSION_CLOSED");
    if (method === "history/read") return await this.readHistory(params as AhpRequestMap["history/read"]) as AhpResultMap[M];
    if (method === "session/close") {
      await this.dispose();
      return { closed: true, observationClosed: true, executionStopped: "unconfirmed" } as AhpResultMap[M];
    }
    const query = this.requireQuery();
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case 'input/submit': return await this.submitInput(params as AhpRequestMap['input/submit'], query) as AhpResultMap[M];
      case 'session/interrupt': {
        const receipt = await query.interrupt();
        const stillQueued = receipt?.still_queued?.flatMap(id => {
          const pending = this.nativeInputs.get(id);
          return pending ? [pending.submissionId] : [];
        });
        result = { accepted: true, ...(stillQueued ? { stillQueued } : {}) };
        break;
      }
      case 'turn/interrupt': case 'turn/steer': throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Claude controls target the session, not an atomically matched Turn');
      case "session/config/set":
        if (this.reverting) throw new HarnessSdkError('SESSION_BUSY', 'Claude configuration cannot change during revert');
        result = await this.setConfig((params as AhpRequestMap["session/config/set"]).patch);
        break;
      case "session/revert": result = await this.revert(params as AhpRequestMap['session/revert']); break;
      default: throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    }
    return result as AhpResultMap[M];
  }
  /** Share query close/return completion between the close request and OutputSession.dispose.
   * Stop input admission, clear pending associations and invalidate message observation immediately.
   * Cleanup rejects on release failure and leaves native execution stop unconfirmed. */
  async dispose(): Promise<void> {
    return this.release ??= (async () => {
      this.closed = true;
      this.generation++;
      this.nativeInputs.clear();
      this.input?.end();
      if (this.query) await this.releaseQuery(this.query);
    })();
  }
  /** Current native session identity, updated by fork/revert and native initialization. */
  binding: SessionBinding;
  /** Store/checkpoint capability projection captured from the adapter at construction. */
  readonly capabilities: Capabilities;
  /** Enforce execute's query admission policy for operations other than history and close. */
  private requireQuery(): ClaudeQuery {
    if (this.switchingOutput) throw new HarnessSdkError('SESSION_BUSY', 'Claude output format is changing');
    if (this.queryFailure) throw this.queryFailure;
    if (!this.query) throw new HarnessSdkError('SESSION_CLOSED');
    return this.query;
  }
  /** Apply execute's configuration controls in order and publish state after all controls succeed.
   * Earlier native effects, including model changes, survive a rejected patch. Keep output-format
   * replacement blocked until the patch settles. Session.onRequestFailed enters recovery when
   * the returned SDK error carries an unknown outcome. */
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
  /** Coalesce title reads for observedStore, startQuery and completeTurn. startQuery awaits the
   * refresh on resume, while append and terminal publication proceed independently. Ignore stale
   * reads after replacement or close and report read failures with a best-effort warning. */
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
  /** Let open choose a fresh query for an empty fork. A history read failure rejects open. */
  private async hasHistory(id: string): Promise<boolean> {
    return (await this.messages(id)).length > 0;
  }
  /** Copy the source transcript through a verified cutoff for open or restoreConversation.
   * The caller installs the returned session ID. Native copy failures reject that phase. */
  private forkTranscript(nativeId: string, cutoff: string): ReturnType<typeof forkSession> {
    return (this.adapter.options.forkSession ?? forkSession)(nativeId, {
      dir: this.params.cwd, sessionStore: this.adapter.sessionStore, upToMessageId: cutoff,
    });
  }
  /** Open, association, init and conversation restore update the in-memory map before awaiting
   * its optional disk copy. Save failure rejects the caller without undoing the map update. */
  private rememberTurnMap(): Promise<void> | undefined {
    this.adapter.turnMaps.set(this.nativeId, this.turns);
    return this.fileStore?.saveTurnMap(this.nativeId, this.turns);
  }
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
  /** Clone binding and config for state publications during initialization, configuration,
   * completion and conversation restore. Report running while an execution occupies the active slot. */
  private snapshot(): SessionState { return { ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}), binding: structuredClone(this.binding), status: this.active ? "running" : "ready", config: structuredClone(this.config), capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, ...(this.model ? { model: this.model } : {}), ...(this.fastMode ? { fastMode: this.fastMode } : {}), activeTurnIds: this.active ? [this.active.id] : [] }; }
  /** Construct a generation-specific query for open, restoreConversation or replaceOutputFormat,
   * then start background pumping and await resumed-title refresh. Fresh mode opens the current native
   * ID as a new session; resume mode reopens its transcript, optionally at resumeAt. Factory/setup
   * failures reject here; subsequent source failures are reported to the sink by pump. */
  private async startQuery(start: QueryStart): Promise<void> {
    const { mode, resumeAt } = start;
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const generation = ++this.generation;
    this.queryMode = mode;
    this.queryResumeAt = resumeAt;
    this.input = new BoundedEventQueue<SDKUserMessage>({ maxEvents: 64 });
    const options = this.sessionQueryOptions(start, generation);
    this.query = (this.adapter.options.queryFactory ?? query)({ prompt: this.input, options });
    this.pumping = this.pump(this.query, generation);
    if (mode === "resume") await this.refreshMetadata();
  }
  /** Project the session and generation into launch options for startQuery. Native tool callbacks
   * are invoked by the SDK. The observed store schedules title refreshes only for this generation. */
  private sessionQueryOptions({ mode, resumeAt }: QueryStart, generation: number): Options {
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const server of this.params.mcpServers ?? []) mcpServers[server.name] = server.type === "stdio" ? { type: "stdio", command: server.command, args: server.args, env: server.env } : { type: "http", url: server.url, headers: server.headers };
    return {
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
  }
  /** Consume the query started by startQuery until closure/generation replacement. Fail SDK
   * observation on source errors or early EOF with pending work; never replay native input. */
  private async pump(stream: ClaudeQuery, generation: number): Promise<void> {
    try {
      for await (const message of stream) { if (this.closed || generation !== this.generation) return; await this.mapMessage(message); }
      if (!this.closed && generation === this.generation && (this.active || this.nativeInputs.size)) await this.sink.fail(new HarnessSdkError("CONNECTION_CLOSED", "Claude query ended before a result", false, true));
    } catch (cause) { if (!this.closed && generation === this.generation) await this.sink.fail(sdkError(cause, "CLAUDE_QUERY_FAILED", true)); }
  }
  /** Return the active execution to associateInputs. Allocate and publish it on the first native
   * execution evidence from associateInputs or permissionRequest. Starting work also makes later
   * schema replacements resume the native transcript. Publication failure rejects to the caller. */
  private async beginExecution(userUuid: string = randomUUID()): Promise<ActiveTurn> {
    if (!this.active) {
      this.queryMode = "resume";
      this.queryResumeAt = undefined;
      this.active = { id: randomUUID(), userUuid, consumed: new Set(), output: new Map(), stoppedTools: new Map(), blockIndex: 0 };
      await this.sink.emit({ type: 'turn/started', payload: { turnId: this.active.id } });
    }
    return this.active;
  }
  /** Route pump messages after processing native input refusal or association evidence. Bind
   * inputs before projecting the associated reply. Sink and store failures reject back to pump. */
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
        await this.rememberTurnMap();
      }
      await this.sink.emit({ type: "session/state", payload: this.snapshot() }); return;
    }
    if (!active) { await this.notice(value); return; }
    if (message.type === "assistant") {
      if (!message.parent_tool_use_id) active.apiError = message.error;
      for (const block of message.message.content) await this.completeBlock({ block: record(block), messageId: message.message.id, context: message.parent_tool_use_id !== null ? "subagent" : "main", active });
      return;
    }
    if (message.type === "stream_event") { await this.streamEvent(record(message.event), active); return; }
    if (message.type === "user") {
      return this.publishToolResults(value, active);
    }
    if (message.type === "result") return this.completeTurn(message, active);
    if (message.type === "system" && typeof value.subtype === "string") {
      const subtype = value.subtype;
      if (subtype.startsWith("task_")) return this.publishTask(value, active);
      if (subtype.startsWith("hook_")) return this.publishHook(subtype, value, active);
      if (subtype === "compact_boundary") { await this.sink.emit({ type: "item/completed", payload: { item: { id: str(value.uuid) ?? randomUUID(), type: "compaction", status: "completed", summary: str(value.summary), trigger: str(record(value.compact_metadata).trigger) } } }, { turnId: active.id }); return; }
    }
    await this.notice(value);
  }
  /** Complete live tool calls from matching native user-message results. mapMessage awaits
   * publication to keep these effects ordered before later native messages. */
  private async publishToolResults(value: Record<string, unknown>, active: ActiveTurn): Promise<void> {
    const body = record(value.message).content;
    if (!Array.isArray(body)) return;
    for (const part of body) {
      const block = record(part);
      if (block.type !== "tool_result") continue;
      const toolId = str(block.tool_use_id);
      if (!toolId) continue;
      const previous = active.output.get(toolId);
      if (previous?.type !== "toolCall") continue;
      const item = completeClaudeTool(previous, toolResult(block, value.tool_use_result));
      active.output.set(toolId, item);
      await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
    }
  }
  /** Map native task updates to an item's start, patch or terminal event. mapMessage awaits
   * publication, falling back to a notice when the native task identity is missing. */
  private async publishTask(value: Record<string, unknown>, active: ActiveTurn): Promise<void> {
    const id = str(value.task_id);
    if (!id) return this.notice(value);
    const previous = active.output.get(`task:${id}`);
    const patch = record(value.patch);
    const status = str(value.status) ?? str(patch.status) ?? "running";
    const final = ["completed", "failed", "stopped", "killed"].includes(status);
    const item: Item = {
      id: `task:${id}`,
      type: "subagent",
      subagentId: id,
      state: status === "completed" || status === "failed" ? status : final ? "interrupted" : "running",
      status: status === "completed" ? "completed" : final ? "failed" : "running",
      task: str(value.description) ?? str(patch.description) ?? str(value.summary),
      ...(str(value.tool_use_id) ? { parentItemId: str(value.tool_use_id) } : {}),
    };
    active.output.set(item.id, item);
    if (final) await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
    else if (!previous) await this.sink.emit({ type: "item/started", payload: { item } }, { turnId: active.id });
    else await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "patch", value: safe(item) } }, { turnId: active.id });
  }
  /** Give hook progress a start event when the hook was previously unseen. mapMessage awaits
   * publication before consuming another message, including when a missing hook ID emits a notice. */
  private async publishHook(subtype: string, value: Record<string, unknown>, active: ActiveTurn): Promise<void> {
    const id = str(value.hook_id);
    if (!id) return this.notice(value);
    const previous = active.output.get(`hook:${id}`);
    const item: Item = {
      id: `hook:${id}`,
      type: "hook",
      name: str(value.hook_name) ?? "hook",
      status: subtype === "hook_response" ? value.outcome === "success" ? "completed" : "failed" : "running",
      ...(value.output !== undefined ? { output: safe(value.output) } : {}),
    };
    active.output.set(item.id, item);
    if (subtype === "hook_progress") {
      if (!previous) await this.sink.emit({ type: "item/started", payload: { item } }, { turnId: active.id });
      await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "output", text: str(value.output) ?? "" } }, { turnId: active.id });
    } else {
      await this.sink.emit({ type: previous || subtype === "hook_response" ? "item/completed" : "item/started", payload: { item } }, { turnId: active.id });
    }
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
    await this.rememberTurnMap();
  }
  /** Finish mapMessage's captured execution. Validate final output, publish items and usage, then
   * clear consumed input IDs before the terminal and ready-state events. Uncorrelated inputs stay
   * pending. A sink failure rejects into pump. */
  private async completeTurn(message: Extract<SDKMessage, { type: "result" }>, active: ActiveTurn): Promise<void> {
    const value = record(message);
    const { interrupted, error, resultText, structuredText } = this.terminalOutput(message, active, value);
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
  /** Classify native termination and validate structured output before completeTurn publishes
   * any final item. Missing or invalid output becomes a terminal error. An interruption bypasses
   * schema validation and retains precedence in the terminal event. */
  private terminalOutput(message: Extract<SDKMessage, { type: "result" }>, active: ActiveTurn, value: Record<string, unknown>): {
    interrupted: boolean; error: HarnessError | undefined; resultText: string | undefined; structuredText: string | undefined;
  } {
    const interrupted = str(message.stop_reason) === "interrupted" || str(value.terminal_reason) === "interrupted";
    let error = claudeTurnError(message, active.apiError);
    let structuredText: string | undefined;
    if (this.outputSchema && !error && !interrupted) {
      if (value.structured_output === undefined) {
        error = { code: 'CLAUDE_STRUCTURED_OUTPUT_MISSING', message: 'Claude completed without the requested structured output', retryable: false, outcomeUnknown: false };
      } else if (!this.outputSchema.validate(value.structured_output)) {
        error = { code: 'CLAUDE_STRUCTURED_OUTPUT_INVALID', message: 'Claude structured output does not match outputSchema', retryable: false, outcomeUnknown: false };
      } else {
        structuredText = JSON.stringify(value.structured_output);
      }
    }
    const resultText = !this.outputSchema && message.subtype === "success" ? message.result : undefined;
    return { interrupted, error, resultText, structuredText };
  }
  /** Update the active turn from streamed content, publishing starts/deltas before final blocks.
   * mapMessage calls only with an active turn; sink rejection propagates to the query pump. */
  private async streamEvent(event: Record<string, unknown>, active: ActiveTurn): Promise<void> {
    const type = event.type;
    if (type === "message_start") { active.streamMessageId = str(record(event.message).id); return; }
    const index = typeof event.index === "number" ? event.index : 0;
    const id = `${active.streamMessageId ?? active.userUuid}:${index}`;
    if (type === "content_block_start") {
      const block = record(event.content_block);
      const blockId = str(block.id) ?? id;
      const status = active.stoppedTools.get(blockId) ?? "running";
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
  private async completeBlock({ block, messageId, context, active }: {
    block: Record<string, unknown>; messageId: string; context: "main" | "subagent"; active: ActiveTurn;
  }): Promise<void> {
    const id = this.resolveCompleteBlockId(block, messageId, active);
    const previous = active.output.get(id);
    const running = block.type === "text" || block.type === "tool_use";
    const status = active.stoppedTools.get(id) ?? (running ? "running" : "completed");
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
  /** Native canUseTool callback supplied by sessionQueryOptions. Await SDK approval/user answers or
   * native cancellation, translating unavailable interactions to denial and removing the abort listener.
   * Session and InteractionRegistry invoke the registered responder for answers or cancellation.
   * Execution-start publication failures reject this native callback before interaction registration. */
  private async permissionRequest(toolName: string, input: Record<string, unknown>, details: Parameters<NonNullable<Options["canUseTool"]>>[2]): Promise<PermissionResult> {
    // A native tool permission request is execution evidence even when the SDK
    // callback arrives before its assistant message. Binding still waits for UUID evidence.
    if (!this.active && this.nativeInputs.size) await this.beginExecution();
    const turnId = this.active?.id;
    if (!turnId) return { behavior: "deny", message: "No active AHP turn" };
    const rawQuestions = Array.isArray(input.questions) ? input.questions.map(record) : [];
    const isUserQuestionRequest = toolName === "AskUserQuestion" && rawQuestions.length > 0 && rawQuestions.every((question): question is Record<string, unknown> & { question: string } => typeof question.question === "string");
    const request = isUserQuestionRequest
      ? this.createUserQuestionRequest(turnId, details.toolUseID, rawQuestions)
      : this.createToolApprovalRequest({ turnId, toolName, input, details });
    return this.awaitInteraction<PermissionResult>({
      request,
      signal: details.signal,
      cancelled: { behavior: "deny", message: "Request cancelled" },
      unavailable: { behavior: "deny", message: "Interaction unavailable" },
      respond: async (answer, finish) => {
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
              str(question.question), answer.answers[`q${index}`],
            ])),
          },
        });
        else finish({ behavior: "deny", message: "Invalid response" });
      },
    });
  }
  /** Build stable qN question identities for permissionRequest so answers map back to native text. */
  private createUserQuestionRequest(turnId: string, toolUseId: string, rawQuestions: Array<Record<string, unknown> & { question: string }>): InteractionRequested {
    return {
      interactionId: toolUseId,
      kind: "userInput",
      turnId,
      itemId: toolUseId,
      questions: rawQuestions.map((question, index) => ({
        // Answers above use the same zero-based qN IDs to recover the native question text.
        id: `q${index}`,
        prompt: question.question,
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
  /** Offer session approval to permissionRequest only when the native callback supplied a
   * session-scoped permission update it can return. */
  private createToolApprovalRequest(
    { turnId, toolName, input, details }: {
      turnId: string; toolName: string; input: Record<string, unknown>;
      details: Parameters<NonNullable<Options["canUseTool"]>>[2];
    },
  ): InteractionRequested {
    return {
      interactionId: details.toolUseID,
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
  /** Native onElicitation callback supplied by sessionQueryOptions. Await a sink-delivered answer
   * or native abort. The answer can reach Claude before the sink publishes interaction/resolved.
   * Unrepresentable form content rejects responder delivery. Native abort or a rejected sink wait
   * returns cancellation. */
  private async elicitationRequest(
    request: Parameters<NativeElicitation>[0],
    details: Parameters<NativeElicitation>[1],
  ): Promise<Awaited<ReturnType<NativeElicitation>>> {
    const ahp: InteractionRequested = {
      interactionId: details.requestId,
      kind: "elicitation",
      mode: request.mode ?? "form",
      ...(this.active ? { turnId: this.active.id } : {}),
      message: request.message,
      ...(request.requestedSchema ? { schema: json(request.requestedSchema) as JsonObject } : {}),
      ...(request.url ? { privatePayload: { url: request.url }, privatePayloadAvailable: true } : {}),
    };
    return this.awaitInteraction<NonNullable<Awaited<ReturnType<NativeElicitation>>>>({
      request: ahp,
      signal: details.signal,
      cancelled: { action: "cancel" },
      unavailable: { action: "cancel" },
      respond: async (answer, finish) => finish(answer?.kind === "elicitation"
        ? { action: answer.action, ...(answer.content ? { content: elicitationContent(answer.content) } : {}) }
        : { action: "cancel" }),
    });
  }
  /** Register the responder for permissionRequest and elicitationRequest. Resolve the native
   * wait once and remove its abort listener. Native abort reports expiry to the sink without
   * awaiting publication. A rejected sink wait supplies the operation's fallback response. */
  private awaitInteraction<T>({ request, signal, cancelled, unavailable, respond }: {
    request: InteractionRequested;
    signal: AbortSignal;
    cancelled: T;
    unavailable: T;
    respond: (answer: Parameters<NativeInteractionResponder>[0], finish: (result: T) => void) => Promise<void>;
  }): Promise<T> {
    const interactionId = request.interactionId;
    return new Promise((resolve) => {
      let answered = false;
      const finish = (result: T) => {
        if (answered) return;
        answered = true;
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
        void this.sink.resolveInteraction({ interactionId, outcome: "expired", reason: "native_cancelled" });
        finish(cancelled);
      };
      signal.addEventListener("abort", abort, { once: true });
      void this.sink.requestInteraction(request, answer => respond(answer, finish)).catch(() => finish(unavailable));
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
  /** Resolve the checkpoint and transcript cutoff for open and revert. Without a store, use
   * native prompt IDs or known associations for file checkpoints. With a store, verify the prompt
   * in history and include opaque trailing entries for through boundaries when available.
   * Unknown boundaries and store failures reject the caller. */
  private async boundaryPoint(nativeId: string, boundary: Boundary): Promise<BoundaryPoint> {
    const store = this.adapter.sessionStore;
    if (!store) {
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
      const entries = await store.load(key);
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
   * before replacement. Hold admission across lookup and cleanup, releasing it on any outcome.
   * Failed conversation restoration after file rewind rejects with REVERT_PARTIAL and appliedScope. */
  private async revert(request: AhpRequestMap['session/revert']): Promise<AhpResultMap['session/revert']> {
    const query = this.query;
    if (this.closed || !query) throw new HarnessSdkError('SESSION_CLOSED');
    if (this.reverting || this.active || this.nativeInputs.size) throw new HarnessSdkError('SESSION_BUSY', 'Claude revert requires no active or pending inputs');
    this.reverting = true;
    try {
      const point = await this.boundaryPoint(this.nativeId, request.boundary);
      if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
      const rewindFiles = request.scope === 'files' || request.scope === 'both';
      if (rewindFiles) {
        await this.restoreFiles(query, request.boundary, point);
      }
      if (request.scope !== 'files') {
        try {
          await this.restoreConversation(query, point);
        } catch (cause) {
          if (rewindFiles) throw new HarnessSdkError('REVERT_PARTIAL', 'Files were restored but conversation restore could not be confirmed', false, true, { appliedScope: 'files' });
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
   * revert translates failure to a REVERT_PARTIAL rejection when its file phase already applied. */
  private async restoreConversation(query: ClaudeQuery, point: BoundaryPoint): Promise<void> {
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    const native = point.uuid ? await this.forkTranscript(this.nativeId, point.uuid) : { sessionId: randomUUID() };
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    this.endQueryInput();
    await this.releaseQuery(query);
    await this.pumping;
    if (this.closed) throw new HarnessSdkError('SESSION_CLOSED');
    this.binding = { ...this.binding, nativeRef: { provider: 'claude', value: native.sessionId } };
    await this.rememberTurnMap();
    await this.startQuery({ mode: point.uuid ? "resume" : "fresh" }); await this.sink.emit({ type: 'session/state', payload: this.snapshot() });
  }
  /** Admit execute's bounded input and enqueue native content, returning a dispatch receipt.
   * Changed schemas replace an idle query first; rejection never retries or replays the new input. */
  private async submitInput(start: AhpRequestMap['input/submit'], query: ClaudeQuery): Promise<AhpResultMap['input/submit']> {
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
      if (changing) await this.replaceOutputFormat(query, outputSchema);
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
  /** Drain and replace the query for submitInput before enqueueing its input. Reject startup or
   * cleanup failure as a definite dispatch failure and latch it for later query operations while open. */
  private async replaceOutputFormat(query: ClaudeQuery, outputSchema: OutputSchema | undefined): Promise<void> {
    const pumping = this.pumping;
    this.endQueryInput();
    try {
      // The optional native return() also waits for the SDK's mirror flush.
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
  /** Invalidate the retired query's observation and end its input before release. Conversation
   * restore and output replacement each await close/return and their own pump before reopening. */
  private endQueryInput(): void {
    this.generation++;
    this.input?.end();
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

type NativeElicitation = NonNullable<Options["onElicitation"]>;

/** Execution output and input associations that completeTurn reads before clearing the active slot. */
interface ActiveTurn { id: string; userUuid: string; consumed: Set<string>; output: Map<string, Item>; stoppedTools: Map<string, "declined" | "interrupted">; streamMessageId?: string; blockIndex: number; apiError?: Extract<SDKMessage, { type: 'assistant' }>['error'] }
