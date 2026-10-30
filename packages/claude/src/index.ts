import { claudeFileChanges, completeClaudeTool } from './file-changes';
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
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
  negotiateVersion, publicValue, validateJsonSchema,
  type Capabilities, type AhpRequestMap, type AhpResultMap, type HistoryItem, type HistoryPage,
  type InitializeParams, type InitializeResult, type InputBlock, type InteractionRequested, type InteractionResponse,
  type Item, type JsonObject, type JsonValue, type SessionBinding, type SessionOpenParams, type SessionState, type Boundary,
} from "@anureo/protocol";
import { FileSessionStore } from "./store";

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "setModel" | "setPermissionMode" | "setMaxThinkingTokens" | "applyFlagSettings" | "rewindFiles" | "supportedModels" | "close">;
export type ClaudeQueryFactory = (params: Parameters<typeof query>[0]) => ClaudeQuery;
export interface ClaudeAdapterOptions {
  command?: string;
  executable?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  stateDir?: string;
  /** Keep stateDir for adapter files only; do not export CLAUDE_CONFIG_DIR (the CLI's default home and its login are used). */
  defaultHome?: boolean;
  queryFactory?: ClaudeQueryFactory;
  sessionStore?: SessionStore;
  getSessionMessages?: typeof getSessionMessages;
  getSessionInfo?: typeof getSessionInfo;
  forkSession?: typeof forkSession;
  enableFileCheckpointing?: boolean;
  /** Script-based external executables can specify the interpreter; native binaries need none. */
  executableRuntime?: "node" | "bun" | "deno";
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function json(value: unknown): JsonValue { try { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; } catch { return null; } }
function safe(value: unknown): JsonValue { return publicValue(json(value)); }
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
function permission(value: unknown): PermissionMode { if (typeof value !== "string" || !PERMISSION_MODES.includes(value as PermissionMode)) throw new HarnessSdkError("INVALID_PARAMS", "Unsupported permission mode"); return value as PermissionMode; }
function capabilities(store: boolean, checkpoints: boolean): Capabilities {
  return {
    session: { resume: store, fork: store ? ["before", "through"] : [], revert: [...(store ? ["conversation" as const] : []), ...(checkpoints ? ["files" as const] : []), ...(store && checkpoints ? ["both" as const] : [])], history: store },
    turn: { steer: false, interrupt: true, outputSchema: false, overrides: [], inputModalities: ["text", "image"] },
    interactions: ["approval", "userInput", "elicitation"], subagents: { events: "nested" },
    mcp: { stdio: true, http: true, elicitation: ["form", "url"] },
    config: { options: [{ id: "model", scope: "session", schema: { type: "string", minLength: 1 } }, { id: "permissionMode", title: "Permissions", scope: "session", schema: { type: "string", enum: PERMISSION_MODES, default: "default" } }, { id: "effort", title: "Effort", scope: "session", schema: { type: "string", enum: [...EFFORT_LEVELS], default: "high" } }, { id: "fastMode", title: "Fast mode", scope: "session", schema: { type: "boolean", default: false } }, { id: "maxThinkingTokens", scope: "session", schema: { type: ["integer", "null"], minimum: 0 } }] },
  };
}
function basicEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "USER", "LOGNAME", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
function content(input: InputBlock[]): SDKUserMessage["message"]["content"] {
  return input.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    if (block.type === "image" && block.data && block.mimeType && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(block.mimeType)) return { type: "image" as const, source: { type: "base64" as const, data: block.data, media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" } };
    if (block.type === "image" && block.url) return { type: "image" as const, source: { type: "url" as const, url: block.url } };
    throw new HarnessSdkError("CAPABILITY_UNSUPPORTED", "Input cannot be represented by the Claude SDK");
  });
}
function isPrompt(message: SessionMessage): boolean {
  if (message.type !== "user") return false;
  const body = record(message.message).content;
  return typeof body === "string" || (Array.isArray(body) && body.some((part) => record(part).type !== "tool_result"));
}

export class ClaudeNativeAdapter implements HarnessAdapter {
  readonly options: ClaudeAdapterOptions;
  readonly sessionStore?: SessionStore;
  private readonly defaultStore?: FileSessionStore;
  private readonly sessions = new Set<ClaudeBackendSession>();
  readonly turnMaps = new Map<string, Record<string, string>>();
  private disposed = false;
  readonly env: Record<string, string | undefined>;
  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    const stateDir = options.stateDir ?? options.env?.CLAUDE_CONFIG_DIR;
    this.env = { ...basicEnvironment(), ...options.env, ...(stateDir && !options.defaultHome ? { CLAUDE_CONFIG_DIR: stateDir } : {}) };
    if (!options.sessionStore && stateDir) this.defaultStore = new FileSessionStore(join(stateDir, "ahp-session-store"));
    this.sessionStore = options.sessionStore ?? this.defaultStore;
  }
  get capabilities(): Capabilities { return capabilities(!!this.sessionStore, !!this.options.enableFileCheckpointing); }
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    negotiateVersion(params.protocolVersions);
    if (this.disposed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (!this.env.CLAUDE_CONFIG_DIR && !this.options.defaultHome && !this.options.queryFactory) throw new HarnessSdkError("HARNESS_CONFIG_INVALID", "Claude requires an explicit isolated CLAUDE_CONFIG_DIR");
    return { protocolVersion: 1, runtime: { name: "claude", version: "0.3.257", adapter: "claude-native/0.1.0" }, capabilities: this.capabilities };
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    if (this.disposed) throw new HarnessSdkError("RUNTIME_DISPOSED");
    if (params.binding.adapterId !== "claude" && params.binding.adapterId !== "claude-native") throw new HarnessSdkError("SESSION_BINDING_MISMATCH");
    const session = new ClaudeBackendSession(this, params, sink, this.defaultStore);
    await session.open(); this.sessions.add(session); return session;
  }
  async listModels(cwd = process.cwd()): Promise<Awaited<ReturnType<Query["supportedModels"]>>> {
    const input = new BoundedEventQueue<SDKUserMessage>();
    const stream = (this.options.queryFactory ?? query)({ prompt: input, options: this.queryOptions(cwd) });
    try { return await stream.supportedModels(); } finally { input.end(); stream.close(); }
  }
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
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await Promise.allSettled([...this.sessions].map((session) => session.dispose())); this.sessions.clear(); }
}

interface ActiveTurn { id: string; userUuid: string; interrupted: boolean; output: Map<string, Item>; stoppedTools: Map<string, "declined" | "interrupted">; streamMessageId?: string; blockIndex: number }
export class ClaudeBackendSession implements BackendSession {
  binding: SessionBinding;
  readonly capabilities: Capabilities;
  private query?: ClaudeQuery;
  private input?: BoundedEventQueue<SDKUserMessage>;
  private active?: ActiveTurn;
  private generation = 0;
  private closed = false;
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
  /** Observe the public SDK store; title records themselves remain opaque. */
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
  constructor(private readonly adapter: ClaudeNativeAdapter, private readonly params: SessionOpenParams, private readonly sink: SessionEventSink, private readonly fileStore?: FileSessionStore) {
    this.binding = { ...params.binding, nativeRef: params.binding.nativeRef ?? { provider: "claude", value: randomUUID() } };
    this.capabilities = adapter.capabilities; this.config = structuredClone(params.config ?? {}); this.model = params.model ?? str(this.config.model);
    for (const [key, value] of Object.entries(this.config)) {
      const option = this.capabilities.config?.options.find((entry) => entry.id === key);
      if (!option) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED", "Unknown Claude config option");
      if (!validateJsonSchema(option.schema, value)) throw new HarnessSdkError("INVALID_PARAMS", "Invalid Claude config value");
    }
  }
  private get nativeId(): string { return this.binding.nativeRef!.value; }
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
    await this.startQuery(this.params.mode === "new" || (this.params.mode === "fork" && !await this.hasHistory(this.nativeId)));
  }
  private async hasHistory(id: string): Promise<boolean> { return (await this.messages(id)).length > 0; }
  private trackFastMode(value: Record<string, unknown>): boolean {
    const state = str(value.fast_mode_state);
    if (state !== "off" && state !== "cooldown" && state !== "on") return false;
    const reason = str(value.fast_mode_disabled_reason);
    const next = { state, ...(reason ? { reason } : {}) } as const;
    const changed = JSON.stringify(next) !== JSON.stringify(this.fastMode);
    this.fastMode = next;
    return changed;
  }
  private snapshot(): SessionState { return { ...(this.sessionTitle !== undefined ? { metadata: { title: this.sessionTitle } } : {}), binding: structuredClone(this.binding), status: this.active ? "running" : "ready", config: structuredClone(this.config), capabilities: this.capabilities, capabilityRevision: this.capabilityRevision, ...(this.model ? { model: this.model } : {}), ...(this.fastMode ? { fastMode: this.fastMode } : {}), ...(this.active ? { activeTurnId: this.active.id } : {}) }; }
  private async startQuery(fresh: boolean, resumeAt?: string): Promise<void> {
    const generation = ++this.generation;
    this.input = new BoundedEventQueue<SDKUserMessage>({ maxEvents: 1 });
    const mcpServers: NonNullable<Options["mcpServers"]> = {};
    for (const server of this.params.mcpServers ?? []) mcpServers[server.name] = server.type === "stdio" ? { type: "stdio", command: server.command, args: server.args, env: server.env } : { type: "http", url: server.url, headers: server.headers };
    const options: Options = {
      ...this.adapter.queryOptions(this.params.cwd),
      ...(this.adapter.sessionStore ? { sessionStore: this.observedStore(this.adapter.sessionStore, generation) } : {}),
      ...(fresh ? { sessionId: this.nativeId } : { resume: this.nativeId }),
      ...(resumeAt ? { resumeSessionAt: resumeAt } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.params.instructions ? { systemPrompt: this.params.instructions } : {}),
      ...(this.config.permissionMode !== undefined || this.params.permissionMode ? { permissionMode: permission(this.config.permissionMode ?? this.params.permissionMode) } : {}),
      // Permit an explicit later mode switch; this flag does not select bypass mode.
      allowDangerouslySkipPermissions: true,
      ...(typeof this.config.maxThinkingTokens === "number" ? { maxThinkingTokens: this.config.maxThinkingTokens } : {}),
      ...(isEffort(this.config.effort) ? { effort: this.config.effort } : {}),
      ...(this.config.fastMode === true ? { settings: { fastMode: true } } : {}),
      mcpServers,
      canUseTool: async (toolName, input, details) => this.permissionRequest(toolName, input, details),
      onElicitation: async (request, details) => this.elicitationRequest(request, details),
    };
    this.query = (this.adapter.options.queryFactory ?? query)({ prompt: this.input, options });
    void this.pump(this.query, generation);
    if (!fresh) await this.refreshMetadata();
  }
  private async pump(stream: ClaudeQuery, generation: number): Promise<void> {
    try {
      for await (const message of stream) { if (this.closed || generation !== this.generation) return; await this.mapMessage(message); }
      if (!this.closed && generation === this.generation && this.active) await this.sink.fail(new HarnessSdkError("CONNECTION_CLOSED", "Claude query ended before a result", false, true));
    } catch (cause) { if (!this.closed && generation === this.generation) await this.sink.fail(sdkError(cause, "CLAUDE_QUERY_FAILED", true)); }
  }
  private async mapMessage(message: SDKMessage): Promise<void> {
    const value = record(message);
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
    if (value.user_message_uuid && value.user_message_uuid !== active.userUuid && !value.parent_tool_use_id) throw new HarnessSdkError("TURN_MISMATCH", "Claude replied to a different input UUID");
    if (message.type === "assistant") {
      for (const block of message.message.content) await this.completeBlock(record(block), message.message.id, message.parent_tool_use_id !== null);
      return;
    }
    if (message.type === "stream_event") { await this.streamEvent(record(message.event)); return; }
    if (message.type === "user") {
      const body = record(message.message).content;
      if (Array.isArray(body)) for (const part of body) {
        const block = record(part); if (block.type !== "tool_result") continue;
        const toolId = str(block.tool_use_id); if (!toolId) continue;
        const previous = active.output.get(toolId);
        if (previous?.type === "toolCall") { const item = completeClaudeTool(previous, { ...block, content: safe(block.content), ...(value.tool_use_result !== undefined ? { structuredContent: safe(value.tool_use_result) } : {}) }); active.output.set(toolId, item); await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id }); }
      }
      return;
    }
    if (message.type === "result") {
      const resultText = message.subtype === "success" ? message.result : undefined;
      const textItems = [...active.output.values()].filter((item) => item.type === "agentMessage" && item.status !== "completed");
      for (let index = 0; index < textItems.length; index++) {
        const item = textItems[index]!; if (item.type !== "agentMessage") continue;
        const completed: Item = { ...item, text: index === textItems.length - 1 && resultText !== undefined ? resultText : item.text, phase: index === textItems.length - 1 ? "final" : "commentary", status: "completed" };
        active.output.set(item.id, completed); await this.sink.emit({ type: "item/completed", payload: { item: completed } }, { turnId: active.id });
      }
      if (!textItems.length && resultText) {
        const item: Item = { id: `${active.userUuid}:final`, type: "agentMessage", phase: "final", text: resultText, status: "completed" };
        await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
      }
      const nativeUsage = record(message.usage);
      const usage = { provider: "claude", scope: "turn" as const, source: "native" as const, ...(typeof nativeUsage.input_tokens === "number" ? { input: nativeUsage.input_tokens } : {}), ...(typeof nativeUsage.output_tokens === "number" ? { output: nativeUsage.output_tokens } : {}), ...(typeof nativeUsage.cache_read_input_tokens === "number" ? { cacheRead: nativeUsage.cache_read_input_tokens } : {}), ...(typeof nativeUsage.cache_creation_input_tokens === "number" ? { cacheWrite: nativeUsage.cache_creation_input_tokens } : {}) };
      await this.sink.emit({ type: "usage/updated", payload: usage }, { turnId: active.id });
      const interrupted = active.interrupted || str(message.stop_reason) === "interrupted" || str(value.terminal_reason) === "interrupted";
      const failed = message.subtype !== "success" || message.is_error;
      for (const pending of active.output.values()) {
        if (pending.type !== "toolCall" || pending.kind !== "fileChange" || pending.status === "completed" || pending.status === "failed") continue;
        const item: Item = { ...pending, status: active.stoppedTools.get(pending.id) ?? (interrupted ? "interrupted" : failed ? "failed" : undefined) };
        active.output.set(item.id, item);
        await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
      }
      this.active = undefined;
      this.trackFastMode(value);
      await this.sink.emit({ type: "turn/completed", payload: { turnId: active.id, status: interrupted ? "interrupted" : failed ? "failed" : "completed", usage, ...(failed && !interrupted ? { error: { code: "CLAUDE_TURN_FAILED", message: "Claude turn failed", retryable: false, outcomeUnknown: false } } : {}) } });
      void this.refreshMetadata();
      // The init snapshot was taken mid-turn ("running"); publish the settled state.
      await this.sink.emit({ type: "session/state", payload: this.snapshot() });
      return;
    }
    if (message.type === "system" && typeof value.subtype === "string") {
      const subtype = value.subtype;
      if (subtype.startsWith("task_")) {
        const id = str(value.task_id); if (!id) return this.notice(value);
        const previous = active.output.get(`task:${id}`); const patch = record(value.patch);
        const status = str(value.status) ?? str(patch.status) ?? (subtype === "task_started" ? "running" : "running");
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
  private async streamEvent(event: Record<string, unknown>): Promise<void> {
    const active = this.active!; const type = event.type;
    if (type === "message_start") { active.streamMessageId = str(record(event.message).id); return; }
    const index = typeof event.index === "number" ? event.index : 0;
    const id = `${active.streamMessageId ?? active.userUuid}:${index}`;
    if (type === "content_block_start") {
      const block = record(event.content_block); const item = this.blockItem(block, str(block.id) ?? id, true);
      active.output.set(item.id, item); await this.sink.emit({ type: "item/started", payload: { item } }, { turnId: active.id });
    } else if (type === "content_block_delta") {
      const delta = record(event.delta); const previous = active.output.get(id);
      if (!previous || (previous.type !== "agentMessage" && previous.type !== "reasoning")) return;
      const text = str(delta.text) ?? str(delta.thinking) ?? "";
      if (previous.type === "agentMessage") previous.text += text; else previous.text = (previous.text ?? "") + text;
      await this.sink.emit({ type: "item/delta", payload: { itemId: id, kind: previous.type === "reasoning" ? "reasoningSummary" : "text", text } }, { turnId: active.id });
    }
  }
  private blockItem(block: Record<string, unknown>, id: string, running: boolean): Item {
    const status = this.active?.stoppedTools.get(id) ?? (running ? "running" as const : "completed" as const);
    if (block.type === "text") return { id, type: "agentMessage", text: str(block.text) ?? "", phase: "commentary", status };
    if (block.type === "thinking") return { id, type: "reasoning", text: str(block.thinking) ?? "", status };
    if (block.type === "tool_use") {
      const name = str(block.name) ?? "unknown";
      return { id, type: "toolCall", kind: name === "Bash" ? "command" : ["Write", "Edit", "MultiEdit"].includes(name) ? "fileChange" : name.startsWith("mcp__") ? "mcp" : "other", title: name, input: safe(block.input), status, nativeType: name, ...(claudeFileChanges(name, block.input) !== undefined ? { fileChanges: claudeFileChanges(name, block.input) } : {}) };
    }
    return { id, type: "toolCall", kind: "other", title: "Unknown Claude content", nativeType: str(block.type) ?? "unknown", raw: safe(block), status };
  }
  private async completeBlock(block: Record<string, unknown>, messageId: string, subagent: boolean): Promise<void> {
    const active = this.active!;
    let id = str(block.id);
    if (!id) id = [...active.output.values()].find((item) => item.id.startsWith(`${messageId}:`) && item.status !== "completed" && (block.type === "text" ? item.type === "agentMessage" : block.type === "thinking" ? item.type === "reasoning" : false))?.id ?? `${messageId}:${active.blockIndex++}`;
    const previous = active.output.get(id); const item = this.blockItem(block, id, block.type === "text" || block.type === "tool_use");
    if (subagent) item.extensions = { ...(item.extensions ?? {}), nativeParentTool: "subagent" };
    active.output.set(id, item);
    if (!previous) await this.sink.emit({ type: "item/started", payload: { item: { ...item, status: "running" } } }, { turnId: active.id });
    else if (block.type === "tool_use") await this.sink.emit({ type: "item/delta", payload: { itemId: item.id, kind: "patch", value: safe(item) } }, { turnId: active.id });
    if (item.type !== "agentMessage" && block.type !== "tool_use") await this.sink.emit({ type: "item/completed", payload: { item } }, { turnId: active.id });
  }
  private async notice(value: Record<string, unknown>): Promise<void> {
    const subtype = str(value.subtype) ?? str(value.type) ?? "unknown";
    await this.sink.emit({ type: "notice", payload: { severity: /error|denied|retry|rate_limit/.test(subtype) ? "warning" : "info", code: `CLAUDE_${subtype.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`, message: str(value.content) ?? str(value.message) ?? subtype, raw: safe(value) } }, this.active ? { turnId: this.active.id } : {});
  }
  private async permissionRequest(toolName: string, input: Record<string, unknown>, details: Parameters<NonNullable<Options["canUseTool"]>>[2]): Promise<PermissionResult> {
    const turnId = this.active?.id;
    if (!turnId) return { behavior: "deny", message: "No active AHP turn" };
    const interactionId = details.toolUseID;
    const rawQuestions = Array.isArray(input.questions) ? input.questions.map(record) : [];
    const questionMode = toolName === "AskUserQuestion" && rawQuestions.length > 0 && rawQuestions.every((question) => typeof question.question === "string");
    const request: InteractionRequested = questionMode ? { interactionId, kind: "userInput", turnId, itemId: details.toolUseID, questions: rawQuestions.map((question, index) => ({ id: `q${index}`, prompt: str(question.question)!, ...(Array.isArray(question.options) ? { options: question.options.map((option) => ({ id: str(record(option).label) ?? String(option), label: str(record(option).label) ?? String(option) })) } : {}), ...(question.secret === true ? { secret: true } : {}) })) } : { interactionId, kind: "approval", turnId, itemId: details.toolUseID, title: details.title ?? toolName, input: safe(input), options: [{ id: "allow-once", label: "Allow once", semantic: "allowOnce" }, ...(details.suggestions?.some((entry) => entry.destination === "session") ? [{ id: "allow-session", label: "Allow for this session", semantic: "allowSession" as const }] : []), { id: "deny", label: "Deny", semantic: "deny" }] };
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
        else if (answer.kind === "userInput") finish({ behavior: "allow", updatedInput: { ...input, answers: Object.fromEntries(rawQuestions.map((question, index) => [str(question.question)!, answer.answers[`q${index}`]])) } });
        else finish({ behavior: "deny", message: "Invalid response" });
      }).catch(() => finish({ behavior: "deny", message: "Interaction unavailable" }));
    });
  }
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
  private async boundaryPoint(nativeId: string, boundary: Boundary): Promise<{ uuid?: string; promptUuid: string; nextPromptUuid?: string }> {
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
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (this.closed || !this.query) throw new HarnessSdkError("SESSION_CLOSED");
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case "turn/start": {
        const start = params as AhpRequestMap["turn/start"];
        if (this.active) throw new HarnessSdkError("SESSION_BUSY");
        const userUuid = randomUUID(); const message: SDKUserMessage = { type: "user", uuid: userUuid, session_id: this.nativeId, message: { role: "user", content: content(start.input) }, parent_tool_use_id: null };
        this.active = { id: start.turnId, userUuid, interrupted: false, output: new Map(), stoppedTools: new Map(), blockIndex: 0 }; this.turns[userUuid] = start.turnId;
        this.adapter.turnMaps.set(this.nativeId, this.turns); await this.fileStore?.saveTurnMap(this.nativeId, this.turns);
        await this.sink.emit({ type: "turn/started", payload: { turnId: start.turnId, nativeTurnId: userUuid } });
        this.input!.push(message); result = { accepted: true, turnId: start.turnId }; break;
      }
      case "turn/interrupt": {
        const request = params as AhpRequestMap["turn/interrupt"];
        if (this.active?.id !== request.turnId) throw new HarnessSdkError("TURN_MISMATCH");
        this.active.interrupted = true; await this.query.interrupt(); result = { accepted: true, turnId: request.turnId }; break;
      }
      case "turn/steer": throw new HarnessSdkError("CAPABILITY_UNSUPPORTED", "Claude queued input is not current-turn steering");
      case "session/config/set": {
        const patch = (params as AhpRequestMap["session/config/set"]).patch;
        try {
          if (patch.model !== undefined) { if (typeof patch.model !== "string") throw new HarnessSdkError("INVALID_PARAMS"); await this.query.setModel(patch.model); this.model = patch.model; }
          if (patch.permissionMode !== undefined) await this.query.setPermissionMode(permission(patch.permissionMode));
          if (patch.fastMode !== undefined) { if (typeof patch.fastMode !== "boolean") throw new HarnessSdkError("INVALID_PARAMS"); await this.query.applyFlagSettings({ fastMode: patch.fastMode }); }
          if (patch.effort !== undefined) { if (patch.effort !== null && !isEffort(patch.effort)) throw new HarnessSdkError("INVALID_PARAMS"); await this.query.applyFlagSettings({ effortLevel: patch.effort }); }
          if (patch.maxThinkingTokens !== undefined) { if (patch.maxThinkingTokens !== null && typeof patch.maxThinkingTokens !== "number") throw new HarnessSdkError("INVALID_PARAMS"); await this.query.setMaxThinkingTokens(patch.maxThinkingTokens); }
        } catch (cause) { throw sdkError(cause, "CLAUDE_CONFIG_FAILED", true); }
        this.config = { ...this.config, ...patch }; this.capabilityRevision++; result = this.snapshot(); await this.sink.emit({ type: "session/state", payload: result }); break;
      }
      case "history/read": {
        const request = params as AhpRequestMap["history/read"]; result = await this.readHistory(request); break;
      }
      case "session/revert": {
        const request = params as AhpRequestMap["session/revert"]; const point = await this.boundaryPoint(this.nativeId, request.boundary);
        let appliedFiles = false;
        if (request.scope === "files" || request.scope === "both") {
          if (!this.adapter.options.enableFileCheckpointing) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
          const checkpoint = request.boundary.relation === "before" ? point.promptUuid : point.nextPromptUuid;
          if (!checkpoint) throw new HarnessSdkError("CAPABILITY_UNSUPPORTED", "No verified post-turn checkpoint exists");
          const preview = await this.query.rewindFiles(checkpoint, { dryRun: true }); if (!preview.canRewind) throw new HarnessSdkError("CHECKPOINT_UNAVAILABLE");
          const rewound = await this.query.rewindFiles(checkpoint); if (!rewound.canRewind || rewound.skippedLinks) throw new HarnessSdkError("REVERT_PARTIAL", "Some files could not be restored", false, true, { appliedScope: "files" }); appliedFiles = true;
        }
        if (request.scope !== "files") {
          try {
            const native = point.uuid ? await (this.adapter.options.forkSession ?? forkSession)(this.nativeId, { dir: this.params.cwd, sessionStore: this.adapter.sessionStore, upToMessageId: point.uuid }) : { sessionId: randomUUID() };
            this.generation++; this.input?.end(); this.query.close();
            this.binding = { ...this.binding, nativeRef: { provider: "claude", value: native.sessionId } };
            this.adapter.turnMaps.set(this.nativeId, this.turns); await this.fileStore?.saveTurnMap(this.nativeId, this.turns);
            await this.startQuery(!point.uuid); await this.sink.emit({ type: "session/state", payload: this.snapshot() });
          } catch (cause) { if (appliedFiles) throw new HarnessSdkError("REVERT_PARTIAL", "Files were restored but conversation restore could not be confirmed", false, true, { appliedScope: "files" }); throw cause; }
        }
        result = { appliedScope: request.scope, boundary: request.boundary, nativeRef: this.binding.nativeRef }; break;
      }
      case "session/close": await this.dispose(); result = { closed: true }; break;
      default: throw new HarnessSdkError("CAPABILITY_UNSUPPORTED");
    }
    return result as AhpResultMap[M];
  }
  private async readHistory(request: AhpRequestMap["history/read"]): Promise<HistoryPage> {
    let snapshotToken = request.snapshotToken;
    if (!snapshotToken) {
      const messages = await this.messages(); const items: HistoryItem[] = []; let currentTurn = "native:session"; let currentNativeTurn: string | undefined;
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
            if (previous?.item.type === "toolCall") { previous.item = completeClaudeTool(previous.item, { ...block, content: safe(block.content), ...(record(message).tool_use_result !== undefined ? { structuredContent: safe(record(message).tool_use_result) } : {}) }); continue; }
          }
          const apiMessageId = str(record(message.message).id); const blockIndex = apiMessageId ? blockCounts.get(apiMessageId) ?? 0 : index;
          if (apiMessageId) blockCounts.set(apiMessageId, blockIndex + 1);
          const item = this.blockItem(block, str(block.id) ?? `${apiMessageId ?? message.uuid}:${blockIndex}`, block.type === "tool_use");
          if (block.type === "tool_use") delete item.status;
          items.push({ turnId: currentTurn, ...(currentNativeTurn ? { nativeTurnId: currentNativeTurn } : {}), nativeItemId: message.uuid, item });
        }
      }
      snapshotToken = randomUUID(); this.historySnapshots.set(snapshotToken, items);
      if (this.historySnapshots.size > 8) this.historySnapshots.delete(this.historySnapshots.keys().next().value!);
    }
    const snapshot = this.historySnapshots.get(snapshotToken); if (!snapshot) throw new HarnessSdkError("CURSOR_EXPIRED");
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.length) throw new HarnessSdkError("CURSOR_INVALID");
    const limit = Math.min(request.limit ?? 200, 1000); const page = snapshot.slice(offset, offset + limit);
    return { items: structuredClone(page), ...(offset + page.length < snapshot.length ? { nextCursor: String(offset + page.length) } : {}), snapshotToken, source: this.binding.nativeRef };
  }
  async dispose(): Promise<void> { if (this.closed) return; this.closed = true; this.generation++; this.input?.end(); this.query?.close(); await (this.query as (ClaudeQuery & Partial<Pick<Query, "return">>) | undefined)?.return?.(); }
}
export function createClaudeAdapter(options?: ClaudeAdapterOptions): ClaudeNativeAdapter { return new ClaudeNativeAdapter(options); }
export { FileSessionStore } from "./store";
