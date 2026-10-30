import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore, getSessionMessages, forkSession, renameSession, type Options, type SDKMessage, type SDKUserMessage, type SessionMessage, type SessionStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { BoundedEventQueue, createHarnessRuntime, type SessionEventSink } from "@anureo/sdk";
import type { AhpEvent, InteractionRequested, InteractionResponse, SessionOpenParams } from "@anureo/protocol";
import { createClaudeAdapter, type ClaudeAdapterOptions, type ClaudeQuery, type ClaudeQueryFactory } from "./index";
import { FileSessionStore } from "./store";
import { runConformance, type ConformanceScenario } from "@anureo/conformance";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

class FakeQuery implements ClaudeQuery {
  readonly output = new BoundedEventQueue<SDKMessage>();
  readonly calls: Array<{ method: string; value?: unknown }> = [];
  current?: SDKUserMessage;
  closed = false;
  rewindAllowed = true;
  constructor(readonly options: Options, prompt: string | AsyncIterable<SDKUserMessage>, onInput: (input: SDKUserMessage, query: FakeQuery) => Promise<void>) {
    if (typeof prompt !== "string") void (async () => { try { for await (const input of prompt) { if (this.closed) return; this.current = input; this.calls.push({ method: "input", value: input }); await onInput(input, this); } } catch (cause) { this.output.end(cause); } })();
  }
  emit(value: Record<string, unknown>): Promise<void> { return this.output.write(value as unknown as SDKMessage); }
  [Symbol.asyncIterator]() { return this.output[Symbol.asyncIterator](); }
  async interrupt() { this.calls.push({ method: "interrupt" }); await this.result("", "interrupted"); return undefined; }
  async setModel(value?: string) { this.calls.push({ method: "model", value }); }
  async setPermissionMode(value: Parameters<ClaudeQuery["setPermissionMode"]>[0]) { this.calls.push({ method: "permission", value }); }
  async setMaxThinkingTokens(value: number | null) { this.calls.push({ method: "thinking", value }); }
  async applyFlagSettings(value: Parameters<ClaudeQuery["applyFlagSettings"]>[0]) { this.calls.push({ method: "flags", value }); }
  async rewindFiles(value: string, options?: { dryRun?: boolean }) { this.calls.push({ method: options?.dryRun ? "rewind-preview" : "rewind", value }); return { canRewind: this.rewindAllowed, filesChanged: [] }; }
  async supportedModels() { return [{ value: "fake-model", displayName: "Fixture", description: "No network" }]; }
  close() { if (!this.closed) { this.closed = true; this.calls.push({ method: "close" }); this.output.end(); } }
  async text(value: string, messageId = "assistant") { await this.emit({ type: "assistant", uuid: `${messageId}-uuid`, session_id: this.current?.session_id ?? this.options.sessionId ?? this.options.resume, user_message_uuid: this.current?.uuid, parent_tool_use_id: null, message: { id: messageId, role: "assistant", content: [{ type: "text", text: value }] } }); }
  async result(value = "conformance", reason = "end_turn") { await this.emit({ type: "result", subtype: "success", is_error: false, result: value, stop_reason: reason, user_message_uuid: this.current?.uuid, uuid: "result", session_id: this.current?.session_id, usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }); }
}
function factory(onInput: (input: SDKUserMessage, query: FakeQuery) => Promise<void> = async (_, stream) => { await stream.text("conformance"); await stream.result(); }) {
  const queries: FakeQuery[] = [];
  const queryFactory: ClaudeQueryFactory = ({ prompt, options }) => { const stream = new FakeQuery(options ?? {}, prompt, onInput); queries.push(stream); return stream; };
  return { queries, queryFactory };
}
const OPEN: SessionOpenParams = { requestId: "open", mode: "new", binding: { sessionId: "s", adapterId: "claude", runtimeConfigId: "r" }, cwd: "/tmp", model: "fake-model" };
async function setup(options: ClaudeAdapterOptions = {}, onInput?: (input: SDKUserMessage, query: FakeQuery) => Promise<void>) {
  const fake = factory(onInput); const adapter = createClaudeAdapter({ ...options, queryFactory: fake.queryFactory }); const runtime = createHarnessRuntime(adapter);
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" }, clientCapabilities: { interactions: ["approval", "userInput", "elicitation", "dynamicTool"] } });
  const session = await runtime.openSession(OPEN); return { ...fake, adapter, runtime, session };
}
async function collect(session: Awaited<ReturnType<ReturnType<typeof createHarnessRuntime>["openSession"]>>, answer?: (request: InteractionRequested) => InteractionResponse): Promise<AhpEvent[]> {
  const reader = session.events()[Symbol.asyncIterator](); const events: AhpEvent[] = [];
  try {
    for (let i = 0; i < 100; i++) {
      const entry = await reader.next(); if (entry.done) throw new Error("Missing terminal"); const event = entry.value; events.push(event);
      if (event.type === "interaction/requested" && answer) await session.respond({ requestId: `answer:${event.payload.interactionId}`, sessionId: session.binding.sessionId, interactionId: event.payload.interactionId, response: answer(event.payload) });
      if (event.type === "turn/completed") return events;
    }
    throw new Error("Event limit");
  } finally { await reader.return?.(); }
}
async function run(session: Awaited<ReturnType<ReturnType<typeof createHarnessRuntime>["openSession"]>>, turnId: string) { await session.startTurn({ requestId: `start:${turnId}`, sessionId: session.binding.sessionId, turnId, input: [{ type: "text", text: "conformance" }] }); }

test("Claude streams partial text and authoritative final output with native UUID and exact provided usage", async () => {
  const { runtime, session, queries } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "message" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } });
    await stream.text("authority", "message"); await stream.result("authority");
  });
  await run(session, "t"); const events = await collect(session);
  expect(events.find((event) => event.type === "turn/started")?.payload).toMatchObject({ turnId: "t", nativeTurnId: expect.any(String) });
  expect(events.filter((event) => event.type === "item/completed").map((event) => event.payload.item)).toMatchObject([{ type: "agentMessage", text: "authority", phase: "final" }]);
  expect(events.find((event) => event.type === "usage/updated")?.payload).toMatchObject({ provider: "claude", scope: "turn", input: 7, output: 9, cacheRead: 2, cacheWrite: 1 });
  expect(queries[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined(); expect(queries[0]!.options.settingSources).toEqual([]);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1)); await runtime.dispose();
});

test("native tool results, task/hook lifecycle, compaction and unknown blocks remain structured", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "assistant", uuid: "a", parent_tool_use_id: null, message: { id: "tool-message", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "echo fixture", apiKey: "PRIVATE" } }] } });
    await stream.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] } });
    await stream.emit({ type: "system", subtype: "task_started", task_id: "child", description: "Work", tool_use_id: "tool" });
    await stream.emit({ type: "system", subtype: "task_progress", task_id: "child", description: "Working" });
    await stream.emit({ type: "system", subtype: "task_notification", task_id: "child", status: "completed", summary: "Finished" });
    await stream.emit({ type: "system", subtype: "hook_started", hook_id: "hook", hook_name: "PreToolUse" });
    await stream.emit({ type: "system", subtype: "hook_progress", hook_id: "hook", hook_name: "PreToolUse", output: "running" });
    await stream.emit({ type: "system", subtype: "hook_response", hook_id: "hook", hook_name: "PreToolUse", outcome: "success", output: "done" });
    await stream.emit({ type: "system", subtype: "compact_boundary", uuid: "compact", compact_metadata: { trigger: "auto" } });
    await stream.emit({ type: "assistant", uuid: "unknown", parent_tool_use_id: null, message: { id: "future", content: [{ type: "futureContent", safeField: "preserved" }] } });
    await stream.result();
  });
  await run(session, "t"); const events = await collect(session); const completed = events.filter((event) => event.type === "item/completed").map((event) => event.payload.item);
  expect(completed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "toolCall", kind: "command", output: "done" }), expect.objectContaining({ type: "subagent", subagentId: "child", state: "completed" }), expect.objectContaining({ type: "hook", name: "PreToolUse", status: "completed" }), expect.objectContaining({ type: "compaction", trigger: "auto" }), expect.objectContaining({ type: "toolCall", kind: "other", nativeType: "futureContent" })]));
  expect(JSON.stringify(events)).not.toContain("PRIVATE"); await runtime.dispose();
});

test("steer never appends Claude input; interrupt preserves the current turn identity", async () => {
  const { runtime, session, queries } = await setup({}, async () => {}); await run(session, "t");
  await expect(session.steer({ requestId: "steer", sessionId: "s", expectedTurnId: "t", input: [{ type: "text", text: "do not enqueue" }] })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  await session.interrupt({ requestId: "interrupt", sessionId: "s", turnId: "t" }); const events = await collect(session);
  expect(events.at(-1)?.payload).toMatchObject({ turnId: "t", status: "interrupted" }); expect(queries[0]!.calls.filter((call) => call.method === "input")).toHaveLength(1); await runtime.dispose();
});

test("canUseTool requests approval and only selected options enter the native callback", async () => {
  let permission: unknown;
  const { runtime, session } = await setup({}, async (_, stream) => {
    permission = await stream.options.canUseTool!("Bash", { command: "fixture" }, { signal: new AbortController().signal, toolUseID: "approval", requestId: "native-approval" });
    await stream.result();
  });
  await run(session, "t"); const events = await collect(session, () => ({ kind: "approval", optionId: "deny" }));
  expect(permission).toMatchObject({ behavior: "deny" }); expect(events.some((event) => event.type === "interaction/resolved" && event.payload.outcome === "responded")).toBe(true); await runtime.dispose();
});

test("AskUserQuestion and URL elicitation use typed interactions with private URLs", async () => {
  const native: unknown[] = [];
  const { runtime, session } = await setup({}, async (_, stream) => {
    native.push(await stream.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Choose", header: "Choice", options: [{ label: "A" }, { label: "B" }] }] }, { signal: new AbortController().signal, toolUseID: "question", requestId: "native-question" }));
    native.push(await stream.options.onElicitation!({ serverName: "mcp", message: "Authenticate", mode: "url", url: "https://example.com/auth?token=PRIVATE" }, { signal: new AbortController().signal, requestId: "url" }));
    await stream.result();
  });
  await run(session, "t"); const events = await collect(session, (request) => request.kind === "userInput" ? { kind: "userInput", answers: { q0: "A" } } : { kind: "elicitation", action: "cancel" });
  expect(native[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { Choose: "A" } } }); expect(native[1]).toMatchObject({ action: "cancel" });
  expect(events.find((event) => event.type === "interaction/requested" && event.payload.kind === "elicitation")?.payload).toMatchObject({ privatePayload: { url: "https://example.com/auth?token=PRIVATE" } }); await runtime.dispose();
});

test("form elicitation projects scalar answers; unrepresentable values cancel natively", async () => {
  const native: unknown[] = [];
  const good = await setup({}, async (_, stream) => {
    native.push(await stream.options.onElicitation!({ serverName: "mcp", message: "Configure", mode: "form" }, { signal: new AbortController().signal, requestId: "form" }));
    await stream.result();
  });
  try {
    await run(good.session, "t");
    const events = await collect(good.session, () => ({ kind: "elicitation", action: "accept", content: { name: "Ada", count: 2, enabled: true, tags: ["a", "b"] } }));
    expect(native[0]).toMatchObject({ action: "accept", content: { name: "Ada", count: 2, enabled: true, tags: ["a", "b"] } });
    expect(events.filter((event) => event.type === "interaction/resolved" && event.payload.outcome === "responded")).toHaveLength(1);
  } finally { await good.runtime.dispose(); }
  const bad = await setup({}, async (_, stream) => {
    native.push(await stream.options.onElicitation!({ serverName: "mcp", message: "Unsupported", mode: "form" }, { signal: new AbortController().signal, requestId: "unsupported" }));
    await stream.result();
  });
  try {
    await run(bad.session, "t");
    const reader = bad.session.events()[Symbol.asyncIterator]();
    let interactionId = "";
    while (true) {
      const entry = await reader.next(); if (entry.done) throw new Error("Missing interaction");
      if (entry.value.type === "interaction/requested") { interactionId = entry.value.payload.interactionId; break; }
    }
    await expect(bad.session.respond({ requestId: "bad", sessionId: bad.session.binding.sessionId, interactionId, response: { kind: "elicitation", action: "accept", content: { nested: { deep: true } } } })).rejects.toMatchObject({ message: "Elicitation response cannot be represented by MCP" });
    let completed = false;
    while (!completed) {
      const entry = await reader.next(); if (entry.done) throw new Error("Missing terminal");
      completed = entry.value.type === "turn/completed";
    }
    await reader.return?.();
    expect(native[1]).toMatchObject({ action: "cancel" });
  } finally { await bad.runtime.dispose(); }
});

test("unmapped system notices surface as typed warnings without private content", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "system", subtype: "task_started" });
    await stream.emit({ type: "system", subtype: "hook_response", outcome: "success" });
    await stream.emit({ type: "system", subtype: "rate_limit_retry", content: "server busy" });
    await stream.emit({ type: "system", subtype: "future_system" });
    await stream.result();
  });
  await run(session, "t"); const events = await collect(session);
  const notices = events.filter((event) => event.type === "notice").map((event) => event.payload);
  expect(notices.map((notice) => notice.code)).toEqual(["CLAUDE_TASK_STARTED", "CLAUDE_HOOK_RESPONSE", "CLAUDE_RATE_LIMIT_RETRY", "CLAUDE_FUTURE_SYSTEM"]);
  expect(notices.map((notice) => notice.severity)).toEqual(["info", "info", "warning", "info"]);
  expect(notices.find((notice) => notice.code === "CLAUDE_RATE_LIMIT_RETRY")?.message).toBe("server busy");
  await runtime.dispose();
});

test("configuration uses actual query controls and refuses unsupported per-turn output schemas", async () => {
  const { runtime, session, adapter, queries } = await setup();
  expect(queries[0]!.options.allowDangerouslySkipPermissions).toBe(true);
  expect(queries[0]!.options.permissionMode).not.toBe('bypassPermissions');
  await session.setConfig({ requestId: "config", sessionId: "s", patch: { model: "different", permissionMode: "plan", maxThinkingTokens: 100 } });
  expect(queries[0]!.calls.map((call) => call.method)).toEqual(["model", "permission", "thinking"]);
  await session.setConfig({ requestId: "bypass", sessionId: "s", patch: { permissionMode: "bypassPermissions" } });
  expect(queries[0]!.calls.at(-1)).toMatchObject({ method: "permission", value: "bypassPermissions" });
  await expect(session.startTurn({ requestId: "schema", sessionId: "s", turnId: "t", input: [{ type: "text", text: "x" }], outputSchema: { type: "object" } })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  expect(await adapter.listModels()).toMatchObject([{ value: "fake-model" }]); await runtime.dispose();
});

test("FileSessionStore atomically preserves opaque entries, dedupes UUIDs, and isolates project/subpaths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-store ")); const store = new FileSessionStore(directory); const key = { projectKey: "project", sessionId: "session" };
  try {
    await Promise.all([store.append(key, [{ type: "opaque", uuid: "1", payload: { nested: [1, true] } }]), store.append(key, [{ type: "opaque", uuid: "2", value: "two" }])]);
    await store.append(key, [{ type: "opaque", uuid: "1", changed: true }]); await store.append({ ...key, subpath: "subagents/child" }, [{ type: "user", uuid: "child" }]);
    expect(await store.load(key)).toHaveLength(2); expect((await store.load(key))!.find((entry) => entry.uuid === "1")).toMatchObject({ changed: true });
    expect(await store.load({ ...key, projectKey: "other" })).toBeNull(); expect(await store.listSubkeys(key)).toEqual(["subagents/child"]); expect(await store.listSessions("project")).toHaveLength(1);
    await store.delete({ ...key, subpath: "subagents/child" });
    expect(await store.listSubkeys(key)).toEqual([]);
    await store.delete(key); expect(await store.load(key)).toBeNull();
    const missing = new FileSessionStore(join(directory, "does-not-exist"));
    expect(await missing.listSessions("project")).toEqual([]);
    expect(await missing.listSubkeys({ projectKey: "project", sessionId: "session" })).toEqual([]);
    await store.saveTurnMap("session", { "native-turn": "ahp-turn" }); expect(await new FileSessionStore(directory).loadTurnMap("session")).toEqual({ "native-turn": "ahp-turn" });
    const filenames = await readdir(directory); expect(filenames.some((file) => file.endsWith(".lock") || file.endsWith(".tmp"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function historyApi() {
  const histories = new Map<string, SessionMessage[]>(); const forks: Array<{ source: string; point?: string }> = [];
  const sessionMessages: NonNullable<ClaudeAdapterOptions["getSessionMessages"]> = async (id) => structuredClone(histories.get(id) ?? []);
  const fork: NonNullable<ClaudeAdapterOptions["forkSession"]> = async (source, options) => {
    const messages = histories.get(source); const index = messages?.findIndex((message) => message.uuid === options?.upToMessageId) ?? -1;
    if (!messages || index < 0) throw new Error("Unknown exact fork point");
    const sessionId = randomUUID(); histories.set(sessionId, structuredClone(messages.slice(0, index + 1))); forks.push({ source, point: options?.upToMessageId }); return { sessionId };
  };
  const append = (input: SDKUserMessage) => {
    const id = input.session_id!; const rows = histories.get(id) ?? [];
    rows.push({ type: "user", uuid: input.uuid!, session_id: id, message: input.message, parent_tool_use_id: null, parent_agent_id: null }, { type: "assistant", uuid: `${input.uuid}:reply`, session_id: id, message: { role: "assistant", content: [{ type: "text", text: "conformance" }] }, parent_tool_use_id: null, parent_agent_id: null });
    histories.set(id, rows);
  };
  return { histories, forks, getSessionMessages: sessionMessages, forkSession: fork, append };
}

test("resume, before/through fork, paged history and conversation revert preserve verified native boundaries", async () => {
  const history = historyApi();
  const { runtime, session, queries } = await setup({ sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession }, async (input, stream) => { history.append(input); await stream.text("conformance"); await stream.result(); });
  await run(session, "t1"); const first = await collect(session); const firstStart = first.find((event) => event.type === "turn/started")!;
  await run(session, "t2"); await collect(session);
  const page1 = await session.readHistory({ requestId: "history", sessionId: "s", limit: 1 });
  expect(page1.items).toHaveLength(1); expect(page1.nextCursor).toBe("1");
  const page2 = await session.readHistory({ requestId: "history2", sessionId: "s", cursor: page1.nextCursor!, snapshotToken: page1.snapshotToken, limit: 10 });
  expect(page2.items.some((entry) => entry.turnId === "t2")).toBe(true);
  const before = await runtime.openSession({ ...OPEN, requestId: "before", mode: "fork", binding: { ...session.binding, sessionId: "before" }, fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: "t1", relation: "before", nativeTurnId: firstStart.type === "turn/started" ? firstStart.payload.nativeTurnId : undefined } } });
  expect((await before.readHistory({ requestId: "before-history", sessionId: "before" })).items).toHaveLength(0); await before.close();
  const through = await runtime.openSession({ ...OPEN, requestId: "through", mode: "fork", binding: { ...session.binding, sessionId: "through" }, fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: "t1", relation: "through" } } });
  const forkHistory = await through.readHistory({ requestId: "through-history", sessionId: "through" });
  expect(forkHistory.items.some((entry) => entry.turnId === "t1")).toBe(true); expect(forkHistory.items.some((entry) => entry.turnId === "t2")).toBe(false); await through.close();
  const oldRef = session.binding.nativeRef!.value;
  const reverted = await session.revert({ requestId: "revert", sessionId: "s", scope: "conversation", boundary: { turnId: "t2", relation: "before" } });
  expect(reverted.nativeRef!.value).not.toBe(oldRef); expect(session.binding.nativeRef).toEqual(reverted.nativeRef);
  expect((await session.readHistory({ requestId: "after-revert", sessionId: "s" })).items.some((entry) => entry.turnId === "t2")).toBe(false);
  const currentBinding = structuredClone(session.binding); await session.close();
  const resumed = await runtime.openSession({ ...OPEN, requestId: "resume", mode: "resume", binding: currentBinding });
  expect(queries.at(-1)!.options.resume).toBe(currentBinding.nativeRef!.value); await resumed.close(); await runtime.dispose();
});

test("history items reuse live streamed ids and the session settles to ready after the turn", async () => {
  const history = historyApi();
  const { runtime, session } = await setup({ sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession }, async (input, stream) => {
    const id = input.session_id!;
    // Real transcripts split one API message (msg_api) into one entry per content block.
    history.histories.set(id, [...history.histories.get(id) ?? [],
      { type: "user", uuid: input.uuid!, session_id: id, message: input.message, parent_tool_use_id: null, parent_agent_id: null },
      { type: "assistant", uuid: "entry-thinking", session_id: id, message: { id: "msg_api", role: "assistant", content: [{ type: "thinking", thinking: "plan" }] }, parent_tool_use_id: null, parent_agent_id: null },
      { type: "assistant", uuid: "entry-text", session_id: id, message: { id: "msg_api", role: "assistant", content: [{ type: "text", text: "hello" }] }, parent_tool_use_id: null, parent_agent_id: null },
    ] as SessionMessage[]);
    await stream.emit({ type: "system", subtype: "init", session_id: id });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_api" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } } });
    await stream.text("hello", "msg_api"); await stream.result("hello");
  });
  await run(session, "t"); const events = await collect(session);
  const live = events.flatMap((event) => event.type === "item/started" ? [event.payload.item.id] : []);
  expect(live).toEqual(["msg_api:0", "msg_api:1"]);
  const states: AhpEvent[] = []; const reader = session.events()[Symbol.asyncIterator]();
  for (;;) { const next = await Promise.race([reader.next(), new Promise<undefined>((done) => setTimeout(done, 50))]); if (!next || next.done) break; states.push(next.value); }
  await reader.return?.();
  expect(states.filter((event) => event.type === "session/state").map((event) => event.type === "session/state" && event.payload.status).at(-1)).toBe("ready");
  const page = await session.readHistory({ requestId: "h", sessionId: "s" });
  expect(page.items.filter((entry) => entry.item.type !== "userMessage").map((entry) => entry.item.id)).toEqual(live);
  await runtime.dispose();
});

test("effort is a session option passed at start and applied live", async () => {
  const fake = factory(); const adapter = createClaudeAdapter({ queryFactory: fake.queryFactory }); const runtime = createHarnessRuntime(adapter);
  const init = await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" } });
  expect(init.capabilities.config?.options.find((option) => option.id === "effort")).toMatchObject({ scope: "session", schema: { enum: ["low", "medium", "high", "xhigh", "max"], default: "high" } });
  const session = await runtime.openSession({ ...OPEN, config: { effort: "low" } });
  await run(session, "t"); await collect(session);
  expect(fake.queries[0]!.options.effort).toBe("low");
  await session.setConfig({ requestId: "effort", sessionId: "s", patch: { effort: "max" } });
  expect(fake.queries[0]!.calls).toContainEqual({ method: "flags", value: { effortLevel: "max" } });
  await expect(session.setConfig({ requestId: "bad", sessionId: "s", patch: { effort: "extreme" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await runtime.dispose();
});

test("fast mode is a session option sent as flag settings, switched live, and reports the native outcome", async () => {
  const fake = factory(async (_input, stream) => {
    await stream.emit({ type: "system", subtype: "init", session_id: "s", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" });
    await stream.text("ok", "m"); await stream.result("ok");
  });
  const adapter = createClaudeAdapter({ queryFactory: fake.queryFactory }); const runtime = createHarnessRuntime(adapter);
  const init = await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" } });
  expect(init.capabilities.config?.options.find((option) => option.id === "fastMode")).toMatchObject({ scope: "session", schema: { type: "boolean", default: false } });
  const session = await runtime.openSession({ ...OPEN, config: { fastMode: true } });
  await run(session, "t"); const events = await collect(session);
  expect(fake.queries[0]!.options.settings).toEqual({ fastMode: true });
  const settled = events.filter((event) => event.type === "session/state").at(-1);
  expect(settled?.type === "session/state" && settled.payload.fastMode).toEqual({ state: "off", reason: "extra_usage_disabled" });
  await session.setConfig({ requestId: "fast", sessionId: "s", patch: { fastMode: false } });
  expect(fake.queries[0]!.calls).toContainEqual({ method: "flags", value: { fastMode: false } });
  await expect(session.setConfig({ requestId: "bad", sessionId: "s", patch: { fastMode: "yes" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await runtime.dispose();
});

test("file rollback requires a checkpoint and scope=both reports partial effects on native fork failure", async () => {
  const history = historyApi();
  const fixture = await setup({ sessionStore: new InMemorySessionStore(), enableFileCheckpointing: true, getSessionMessages: history.getSessionMessages, forkSession: async () => { throw new Error("Native fork failed"); } }, async (input, stream) => { history.append(input); await stream.text("conformance"); await stream.result(); });
  await run(fixture.session, "t1"); await collect(fixture.session); await run(fixture.session, "t2"); await collect(fixture.session);
  fixture.queries[0]!.rewindAllowed = false;
  await expect(fixture.session.revert({ requestId: "no-checkpoint", sessionId: "s", scope: "files", boundary: { turnId: "t2", relation: "before" } })).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
  expect(fixture.queries[0]!.calls.filter((call) => call.method === "rewind")).toHaveLength(0);
  fixture.queries[0]!.rewindAllowed = true;
  await expect(fixture.session.revert({ requestId: "partial", sessionId: "s", scope: "both", boundary: { turnId: "t2", relation: "before" } })).rejects.toMatchObject({ code: "REVERT_PARTIAL", outcomeUnknown: true, details: { appliedScope: "files" } });
  expect(fixture.queries[0]!.calls.filter((call) => call.method === "rewind")).toHaveLength(1); await fixture.runtime.dispose();
});

test("Claude adapter passes shared conformance for all declared capabilities", async () => {
  const report = await runConformance((scenario: ConformanceScenario) => {
    const history = historyApi(); const native = factory(async (input, stream) => {
      history.append(input);
      if (["interrupt", "disconnect", "backpressure"].includes(scenario)) return;
      if (scenario === "approval") await stream.options.canUseTool!("Bash", { command: "fixture" }, { signal: new AbortController().signal, toolUseID: "approval", requestId: "native-approval" });
      if (scenario === "userInput") await stream.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Value", header: "Value" }] }, { signal: new AbortController().signal, toolUseID: "question", requestId: "native-question" });
      if (scenario === "elicitation") await stream.options.onElicitation!({ serverName: "mcp", message: "Value", mode: "form" }, { signal: new AbortController().signal, requestId: "elicitation" });
      if (scenario === "unknown-item") await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "unknown", content: [{ type: "futureContent", safeField: "value" }] } });
      await stream.text("conformance"); await stream.result();
    });
    return { adapter: createClaudeAdapter({ queryFactory: native.queryFactory, sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession }), openParams: { ...OPEN, binding: { ...OPEN.binding, sessionId: "conformance-session" } }, ...(scenario === "disconnect" || scenario === "backpressure" ? { afterStart: async () => { native.queries[0]!.output.end(new Error("Injected native source failure")); } } : {}) };
  });
  expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]); expect(report.passed).toBe(true);
  expect(report.cases.filter((entry) => entry.status === "not-applicable").map((entry) => entry.scenario)).toEqual(["dynamicTool", "steer"]);
});

test("the real pinned SDK drives an external fake executable through the native adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude sdk actual "));
  const runtime = createHarnessRuntime(createClaudeAdapter({ command: fileURLToPath(new URL("../../../scripts/harness-sdk/fixtures/fake-claude.mjs", import.meta.url)), executableRuntime: "node", stateDir: join(directory, "state") }));
  try {
    await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "official-sdk-adapter-test", version: "1" } });
    const session = await runtime.openSession({ ...OPEN, cwd: directory }); await run(session, "t"); const events = await collect(session);
    expect(events.find((event) => event.type === "item/completed" && event.payload.item.type === "agentMessage")?.payload).toMatchObject({ item: { text: "external executable probe passed", phase: "final" } });
    expect(events.at(-1)?.payload).toMatchObject({ status: "completed" });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}, 15_000);

test("official history and fork helpers consume the opaque SessionStore contract", async () => {
  const sessionId = randomUUID(); const userId = randomUUID(); const replyId = randomUUID();
  const entries: SessionStoreEntry[] = [
    { type: "user", uuid: userId, parentUuid: null, sessionId, message: { role: "user", content: "question" }, isSidechain: false },
    { type: "assistant", uuid: replyId, parentUuid: userId, sessionId, message: { role: "assistant", content: [{ type: "text", text: "answer" }] }, isSidechain: false },
  ];
  const writes: Array<{ key: unknown; entries: SessionStoreEntry[] }> = [];
  const store: SessionStore = { load: async (key) => key.sessionId === sessionId ? structuredClone(entries) : null, append: async (key, value) => { writes.push({ key, entries: structuredClone(value) }); } };
  const messages = await getSessionMessages(sessionId, { dir: tmpdir(), sessionStore: store, includeSystemMessages: true });
  expect(messages.map((message) => message.uuid)).toEqual([userId, replyId]);
  const forked = await forkSession(sessionId, { dir: tmpdir(), sessionStore: store, upToMessageId: userId });
  expect(forked.sessionId).not.toBe(sessionId); expect(writes).toHaveLength(1); expect(writes[0]!.entries.some((entry) => entry.uuid === replyId)).toBe(false);
});

test("streamed edit inputs become full source snapshots and typed native results supply actual hunks", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "edit", name: "Edit", input: {} } } });
    await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "message", content: [{ type: "tool_use", id: "edit", name: "Edit", input: { file_path: "index.ts", old_string: "old", new_string: "new" } }] } });
    await stream.emit({ type: "user", tool_use_result: { filePath: "index.ts", structuredPatch: [{ oldStart: 57, oldLines: 1, newStart: 57, newLines: 1, lines: ["-old", "+new"] }] }, message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "File updated" }] } });
    await stream.result();
  });
  await run(session, "t"); const events = await collect(session);
  expect(events.find(event => event.type === "item/delta" && event.payload.itemId === "edit")).toMatchObject({ payload: { kind: "patch", value: { fileChanges: [{ materials: [{ scope: "fragment" }] }] } } });
  expect(events.find(event => event.type === "item/completed" && event.payload.item.id === "edit")).toMatchObject({ payload: { item: { status: "completed", fileChanges: [{ completeness: "complete", materials: [{ format: "unified", patch: "@@ -57,1 +57,1 @@\n-old\n+new\n" }] }] } } });
  await runtime.dispose();
});

test("an interrupted turn cannot leave an unresolved file edit running or count it as applied", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "message", content: [{ type: "tool_use", id: "edit", name: "Write", input: { file_path: "index.ts", content: "attempt" } }] } });
    await stream.emit({ type: "result", subtype: "success", result: "", stop_reason: "interrupted", usage: {} });
  });
  await run(session, "t"); const events = await collect(session);
  expect(events.find(event => event.type === "item/completed" && event.payload.item.id === "edit")).toMatchObject({ payload: { item: { status: "interrupted", fileChanges: [{ operation: "unknown" }] } } });
  await runtime.dispose();
});

test("explicit edit approval denial remains declined after an error tool result", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    const input = { file_path: "index.ts", old_string: "old", new_string: "new" };
    await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "message", content: [{ type: "tool_use", id: "edit", name: "Edit", input }] } });
    await stream.options.canUseTool!("Edit", input, { signal: new AbortController().signal, toolUseID: "edit", requestId: "native-edit" });
    await stream.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "edit", content: "Denied", is_error: true }] } });
    await stream.result();
  });
  await run(session, "t"); const events = await collect(session, () => ({ kind: "approval", optionId: "deny" }));
  expect(events.find(event => event.type === "item/completed" && event.payload.item.id === "edit")).toMatchObject({ payload: { item: { status: "declined" } } });
  await runtime.dispose();
});


test("Claude titles observe committed store appends while idle, isolate subpaths and survive refresh errors", async () => {
  let title = 'Generated title', fail = false, reads = 0;
  const store = new InMemorySessionStore();
  const f = await setup({ sessionStore: store, getSessionInfo: async (id) => {
    reads++;
    if (fail) throw new Error('Private provider error');
    return { sessionId: id, summary: title, lastModified: Date.now() };
  } });
  const events: AhpEvent[] = [];
  const pump = (async () => { for await (const event of f.session.events()) events.push(event); })();
  const until = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw new Error('Metadata timeout'); };
  try {
    const observed = f.queries[0]!.options.sessionStore!;
    const key = { projectKey: 'fixture', sessionId: f.session.binding.nativeRef!.value };
    await observed.append({ ...key, subpath: 'agent/child' }, []);
    await observed.append({ ...key, sessionId: 'other' }, []);
    expect(reads).toBe(0);
    await observed.append(key, []);
    await until(() => events.some(e => e.type === 'session/metadata'));
    expect(events.filter(e => e.type === 'session/metadata').map(e => e.payload)).toEqual([{ title }]);
    await observed.append(key, []);
    await until(() => reads === 2);
    title = 'Renamed later';
    await observed.append(key, []);
    await until(() => events.some(e => e.type === 'session/metadata' && e.payload.title === title));
    fail = true;
    await observed.append(key, []);
    await until(() => events.some(e => e.type === 'notice' && e.payload.code === 'SESSION_METADATA_UNAVAILABLE'));
    expect(JSON.stringify(events)).not.toContain('Private provider error');
    expect(events.filter(e => e.type === 'session/metadata')).toHaveLength(2);
    expect(events.some(e => e.type === 'turn/started')).toBe(false);
    await f.runtime.dispose();
    const before = reads;
    await observed.append(key, []);
    expect(reads).toBe(before);
  } finally { await f.runtime.dispose(); await pump; }
});


test("official Claude rename and info helpers deliver titles through the observed opaque store", async () => {
  let nativeId = '';
  const entries: SessionStoreEntry[] = [];
  const store: SessionStore = {
    load: async key => key.sessionId === nativeId ? structuredClone(entries) : null,
    append: async (key, batch) => { if (key.sessionId === nativeId) entries.push(...structuredClone(batch)); },
  };
  const f = await setup({ sessionStore: store });
  nativeId = f.session.binding.nativeRef!.value;
  entries.push({ type: 'user', uuid: randomUUID(), parentUuid: null, sessionId: nativeId, message: { role: 'user', content: 'Original prompt' }, isSidechain: false });
  const reader = f.session.events()[Symbol.asyncIterator]();
  try {
    await renameSession(nativeId, 'Official renamed title', { dir: OPEN.cwd, sessionStore: f.queries[0]!.options.sessionStore });
    let title: string | null | undefined;
    for (let i = 0; i < 10; i++) {
      const event = (await reader.next()).value!;
      if (event.type === 'session/metadata') { title = event.payload.title; break; }
    }
    expect(title).toBe('Official renamed title');
  } finally { await reader.return?.(); await f.runtime.dispose(); }
});
