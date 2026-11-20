import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore, getSessionMessages, forkSession, renameSession, type Options, type SDKMessage, type SDKUserMessage, type SessionMessage, type SessionStore, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { BoundedEventQueue, HarnessSdkError, createClient, type Session, type SessionEventSink } from "@anureo/sdk";
import type { AhpEvent, InteractionRequested, InteractionResponse, SessionOpenParams } from "@anureo/protocol";
import { createClaudeAdapter, type ClaudeAdapterOptions, type ClaudeQuery, type ClaudeQueryFactory } from "./index";
import { FileSessionStore } from "./store";
import { runConformance, type ConformanceScenario } from "@anureo/conformance";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Implement the query created by ClaudeBackendSession.startQuery or ClaudeNativeAdapter.listModels.
 * Each caller closes its own query. Input scripts write SDK messages for the backend pump to consume. */
class FakeQuery implements ClaudeQuery {
  readonly output = new BoundedEventQueue<SDKMessage>();
  readonly calls: Array<{ method: string; value?: unknown }> = [];
  current?: SDKUserMessage;
  closed = false;
  rewindAllowed = true;
  constructor(
    readonly options: Options,
    prompt: string | AsyncIterable<SDKUserMessage>,
    onInput: (input: SDKUserMessage, query: FakeQuery) => Promise<void>,
  ) {
    if (typeof prompt !== "string") void this.consumeInputs(prompt, onInput);
  }
  /** Enqueue a fixture message, including partial native frames used to exercise the adapter's projection. */
  emit(value: Record<string, unknown>): Promise<void> { return this.output.write(value as unknown as SDKMessage); }
  [Symbol.asyncIterator]() { return this.output[Symbol.asyncIterator](); }
  /** Complete the scripted current input as interrupted when the backend requests session interruption. */
  async interrupt() { this.calls.push({ method: "interrupt" }); await this.result("", "interrupted"); return undefined; }
  async setModel(value?: string) { this.calls.push({ method: "model", value }); }
  async setPermissionMode(value: Parameters<ClaudeQuery["setPermissionMode"]>[0]) { this.calls.push({ method: "permission", value }); }
  async setMaxThinkingTokens(value: number | null) { this.calls.push({ method: "thinking", value }); }
  async applyFlagSettings(value: Parameters<ClaudeQuery["applyFlagSettings"]>[0]) { this.calls.push({ method: "flags", value }); }
  /** Report configured checkpoint availability and distinguish previews from attempted rewinds in the call log. */
  async rewindFiles(value: string, options?: { dryRun?: boolean }) {
    this.calls.push({ method: options?.dryRun ? "rewind-preview" : "rewind", value });
    return { canRewind: this.rewindAllowed, filesChanged: [] };
  }
  async supportedModels() { return [{ value: "fake-model", displayName: "Fixture", description: "No network" }]; }
  /** End the output iterator once so the adapter pump can finish on close. */
  close() { if (!this.closed) { this.closed = true; this.calls.push({ method: "close" }); this.output.end(); } }
  /** Emit an authoritative assistant reply, echoing the current input UUID when present. */
  async text(value: string, messageId = "assistant") {
    await this.emit({
      type: "assistant", uuid: `${messageId}-uuid`, session_id: this.current?.session_id ?? this.options.sessionId ?? this.options.resume,
      user_message_uuid: this.current?.uuid, parent_tool_use_id: null,
      message: { id: messageId, role: "assistant", content: [{ type: "text", text: value }] },
    });
  }
  /** Emit a native terminal for the current input with fixed usage and an overridable stop reason. */
  async result(value = "conformance", reason = "end_turn") {
    await this.emit({
      type: "result", subtype: "success", is_error: false, result: value, stop_reason: reason,
      user_message_uuid: this.current?.uuid, uuid: "result", session_id: this.current?.session_id,
      usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    });
  }

  /** Await each script in prompt order so its replies keep the current UUID. End the output with
   * a script failure so ClaudeBackendSession.pump reports it through SDK observation. */
  private async consumeInputs(
    prompt: AsyncIterable<SDKUserMessage>,
    onInput: (input: SDKUserMessage, query: FakeQuery) => Promise<void>,
  ) {
    try {
      for await (const input of prompt) {
        if (this.closed) return;
        this.current = input;
        this.calls.push({ method: "input", value: input });
        await onInput(input, this);
      }
    } catch (cause) {
      this.output.end(cause);
    }
  }
}
/** Supply a fresh query for each launch and retain it for assertions, including discovery and
 * replacement queries. By default each input receives a text reply and a successful terminal. */
function factory(onInput: (input: SDKUserMessage, query: FakeQuery) => Promise<void> = async (_, stream) => {
  await stream.text("conformance");
  await stream.result();
}) {
  const queries: FakeQuery[] = [];
  const queryFactory: ClaudeQueryFactory = ({ prompt, options }) => {
    const stream = new FakeQuery(options ?? {}, prompt, onInput);
    queries.push(stream);
    return stream;
  };
  return { queries, queryFactory };
}

test('native lifecycle sends overlapping inputs into the SDK channel and binds results by user UUID', async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let n = 0;
  const fake = factory(async (_input, stream) => {
    const index = ++n;
    await stream.text(`preview-${index}`);
    if (index === 1) await gate;
    await stream.result(`final-${index}`);
  });
  const client = await createClient({ adapter: createClaudeAdapter({ queryFactory: fake.queryFactory }), identity: { adapterId: 'claude', runtimeConfigId: 'native' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    const one = session.submit({ input: 'one' }), first = await one;
    const two = session.submit({ input: 'two' });
    let bound = false;
    void two.then(() => { bound = true; }, () => {});
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(bound).toBe(false);
    release(); const second = await two;
    expect(first.id).not.toBe(second.id);
    expect((await first.result()).text).toBe('final-1'); expect((await second.result()).text).toBe('final-2');
    expect(fake.queries[0]!.calls.filter(call => call.method === 'input')).toHaveLength(2);
    await session.close();
  } finally { release(); await client.dispose(); }
});

test('native close retains both close and iterator release failures without repeating either release', async () => {
  const fake = factory(); let closes = 0, returns = 0;
  const client = await createClient({ adapter: createClaudeAdapter({ queryFactory: fake.queryFactory }), identity: { adapterId: 'claude', runtimeConfigId: 'release-errors' } });
  const session = await client.sessions.create({ cwd: process.cwd() });
  const query = fake.queries[0]!, original = query.close.bind(query);
  query.close = () => { closes++; original(); throw new Error('private close failure'); };
  Object.assign(query, { return: async () => { returns++; throw new Error('private return failure'); } });
  await expect(session.close()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED' });
  await expect(client.dispose()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED', details: { errors: [{ code: 'CLAUDE_CLOSE_FAILED' }, { code: 'CLAUDE_RETURN_FAILED' }] } });
  expect(closes).toBe(1); expect(returns).toBe(1);
});
const OPEN: SessionOpenParams = { requestId: "open", mode: "new", binding: { sessionId: "s", adapterId: "claude", runtimeConfigId: "r" }, cwd: "/tmp", model: "fake-model" };

test("adapter disposal closes a native query while resume is reading its title", async () => {
  const native = factory();
  const metadataStarted = Promise.withResolvers<void>();
  const metadata = Promise.withResolvers<undefined>();
  const adapter = createClaudeAdapter({ queryFactory: native.queryFactory, getSessionInfo: () => {
    metadataStarted.resolve();
    return metadata.promise;
  } });
  const sink: SessionEventSink = {
    emit: async () => {},
    tryEmit: () => true,
    bindSubmission: async () => {},
    requestInteraction: async () => { throw new Error("Unexpected interaction"); },
    resolveInteraction: async () => {},
    fail: async () => {},
  };
  const opening = adapter.openSession({ ...OPEN, mode: "resume", binding: { ...OPEN.binding, nativeRef: { provider: "claude", value: randomUUID() } } }, sink);
  try {
    await metadataStarted.promise;
    await adapter.dispose();
    expect(native.queries[0]!.closed).toBe(true);
    metadata.resolve(undefined);
    await expect(opening).rejects.toMatchObject({ code: "RUNTIME_DISPOSED" });
  } finally {
    metadata.resolve(undefined);
    await opening.catch(() => {});
    await adapter.dispose();
  }
});

test("idle native EOF fails observation and prevents further dispatch", async () => {
  const { runtime, session, queries } = await setup();
  try {
    queries[0]!.output.end();
    await expect(readerFor(session).next()).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    await expect(session.submit({ input: "after EOF" }, { timeoutMs: 100 })).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(queries[0]!.calls.some(call => call.method === "input")).toBe(false);
  } finally { await runtime.dispose(); }
});

const readers = new WeakMap<Session, AsyncIterator<AhpEvent>>();
/** Subscribe before dispatch and reuse the subscription until collect closes and replaces it. */
function readerFor(session: Session) {
  let reader = readers.get(session);
  if (!reader) {
    reader = session.events()[Symbol.asyncIterator]();
    readers.set(session, reader);
  }
  return reader;
}
/** Open a scripted session with manual interactions and subscribe before dispatch.
 * Tests own runtime disposal. */
async function setup(
  options: ClaudeAdapterOptions = {},
  onInput?: (input: SDKUserMessage, query: FakeQuery) => Promise<void>,
) {
  const fake = factory(onInput);
  const adapter = createClaudeAdapter({ ...options, queryFactory: fake.queryFactory });
  const runtime = await createClient({
    adapter,
    identity: OPEN.binding,
    interactions: { approval: undefined, userInput: undefined, elicitation: undefined, dynamicTool: undefined },
  });
  const session = await runtime.openSession(OPEN);
  readerFor(session);
  return { ...fake, adapter, runtime, session };
}

/** Consume through the next terminal, answering manual interaction requests in stream order.
 * Read and response failures reject. Renew the subscription after releasing it so the next
 * submission cannot publish into a gap between collectors. */
async function collect(session: Session, answer?: (request: InteractionRequested) => InteractionResponse): Promise<AhpEvent[]> {
  const reader = readerFor(session);
  const events: AhpEvent[] = [];
  try {
    for (let i = 0; i < 100; i++) {
      const entry = await reader.next();
      if (entry.done) throw new Error("Missing terminal");
      const event = entry.value;
      events.push(event);
      if (event.type === "interaction/requested" && answer) {
        await session.request("interaction/respond", {
          requestId: `answer:${event.payload.interactionId}`,
          sessionId: session.id,
          interactionId: event.payload.interactionId,
          response: answer(event.payload),
        });
      }
      if (event.type === "turn/completed") return events;
    }
    throw new Error("Event limit");
  } finally {
    await reader.return?.();
    readers.delete(session);
    readerFor(session);
  }
}

/** Subscribe and submit, then yield for dispatch without waiting for binding. A native callback
 * may need the collector to answer an interaction before the query can emit UUID evidence. */
const turnIdsByAlias = new WeakMap<Session, Map<string, string>>();
function requireBoundTurnId(session: Session, alias: string): string {
  const turnId = turnIdsByAlias.get(session)?.get(alias);
  if (!turnId) throw new Error(`Execution ${alias} is not bound`);
  return turnId;
}
async function submitAndYield(session: Session, alias?: string) {
  readerFor(session);
  let turnId: string | undefined;
  void session.submit({ input: "conformance" }).then(turn => {
    turnId = turn.id;
    if (alias) { const sessionTurnIds = turnIdsByAlias.get(session) ?? new Map(); sessionTurnIds.set(alias, turn.id); turnIdsByAlias.set(session, sessionTurnIds); }
  }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  return {
    /** Require binding at the point of assertion, with no extra wait that could hide late binding. */
    requireTurnId() {
      if (!turnId) throw new Error("Execution is not bound");
      return turnId;
    },
  };
}

/** Collect the next scripted terminal while servicing manual interactions. The result includes
 * the collected events and a check for the submission's observed binding. */
async function submitAndCollect(session: Session, answer?: (request: InteractionRequested) => InteractionResponse) {
  const submission = await submitAndYield(session);
  const events = await collect(session, answer);
  return { ...submission, events };
}

test("Claude streams partial text and authoritative final output with native UUID and exact provided usage", async () => {
  const { runtime, session, queries } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "message" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } } });
    await stream.text("authority", "message"); await stream.result("authority");
  });
  const { events, requireTurnId } = await submitAndCollect(session);
  expect(events.find((event) => event.type === "turn/started")?.payload).toMatchObject({ turnId: requireTurnId() });
  expect(events.filter((event) => event.type === "item/completed").map((event) => event.payload.item)).toMatchObject([{ type: "agentMessage", text: "authority", phase: "final" }]);
  expect(events.find((event) => event.type === "usage/updated")?.payload).toMatchObject({ provider: "claude", scope: "turn", input: 7, output: 9, cacheRead: 2, cacheWrite: 1 });
  expect(queries[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined(); expect(queries[0]!.options.settingSources).toEqual([]);
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => events[0]!.seq + index)); await runtime.dispose();
});

test("native tool results, task/hook lifecycle, compaction and unknown blocks remain structured", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "assistant", uuid: "a", parent_tool_use_id: null, message: { id: "tool-message", content: [
      { type: "tool_use", id: "shell", name: "Bash", input: { command: "echo fixture", apiKey: "PRIVATE" } },
      { type: "tool_use", id: "tool", name: "Agent", input: { prompt: "Read a file" } },
    ] } });
    await stream.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "done" }] } });
    await stream.emit({ type: "system", subtype: "task_started", task_id: "shell-task", description: "Shell", tool_use_id: "shell" });
    await stream.emit({ type: "system", subtype: "task_notification", task_id: "shell-task", status: "completed", tool_use_id: "shell" });
    await stream.emit({ type: "assistant", parent_tool_use_id: "tool", message: { id: "child-message", content: [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: "package.json" } }] } });
    await stream.emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "child-read", content: "child result" }] } });
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
  await submitAndYield(session, "t"); const events = await collect(session); const completed = events.filter((event) => event.type === "item/completed").map((event) => event.payload.item);
  expect(completed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "toolCall", kind: "command", output: "done" }), expect.objectContaining({ type: "subagent", subagentId: "child", state: "completed", parentItemId: "tool" }), expect.objectContaining({ type: "hook", name: "PreToolUse", status: "completed" }), expect.objectContaining({ type: "compaction", trigger: "auto" }), expect.objectContaining({ type: "toolCall", kind: "other", nativeType: "futureContent" })]));
  expect(completed).toEqual(expect.arrayContaining([expect.objectContaining({ id: "child-read", parentItemId: "tool", output: "child result" })]));
  expect(events.flatMap(event => event.type === "item/started" && event.payload.item.type === "subagent" ? [event.payload.item.id] : [])).toEqual(["task:child"]);
  expect(JSON.stringify(events)).not.toContain("PRIVATE"); await runtime.dispose();
});

test("background subagents settle on the spawning turn and Claude's replies stream on subsequent turns", async () => {
  const { runtime, session, queries } = await setup({}, async (_, stream) => {
    await stream.text("Launching readers");
    for (const id of ["alpha", "beta"]) {
      await stream.emit({ type: "system", subtype: "task_started", task_type: "local_agent", task_id: id, tool_use_id: `agent-${id}`, description: `Read ${id}`, is_backgrounded: true });
    }
    await stream.result("Both readers are running");
  });
  const reader = readerFor(session);
  try {
    const launch = await session.submit({ input: "Read two files in the background" });
    expect((await launch.result()).text).toBe("Both readers are running");
    const stream = queries[0]!;
    await stream.emit({ type: "system", subtype: "task_updated", task_id: "alpha", patch: { status: "completed" } });
    await stream.emit({ type: "system", subtype: "task_notification", task_id: "alpha", status: "completed", summary: "Value A" });
    await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "follow-up", content: [{ type: "text", text: "Alpha finished" }] } });
    await stream.emit({ type: "system", subtype: "task_updated", task_id: "beta", patch: { status: "completed" } });
    await stream.emit({ type: "system", subtype: "task_notification", task_id: "beta", status: "completed", summary: "Value B" });
    await stream.emit({ type: "result", subtype: "success", origin: { kind: "task-notification" }, is_error: false, result: "Alpha finished" });
    await stream.emit({ type: "result", subtype: "success", origin: { kind: "task-notification" }, is_error: false, result: "Alpha and beta finished" });

    const events: AhpEvent[] = [];
    let turns = 0;
    for (let i = 0; i < 100 && turns < 3; i++) {
      const entry = await reader.next();
      if (entry.done) break;
      events.push(entry.value);
      if (entry.value.type === "turn/completed") turns++;
    }
    const completedTurns = events.filter(event => event.type === "turn/completed").map(event => event.payload.turnId);
    expect(completedTurns).toHaveLength(3);
    expect(new Set(completedTurns).size).toBe(3);
    expect(completedTurns[0]).toBe(launch.id);
    expect(events.filter(event => event.type === "item/completed" && event.payload.item.type === "subagent")).toMatchObject(
      [["alpha", "A"], ["beta", "B"]].map(([id, value]) => ({
        turnId: launch.id,
        payload: { item: { subagentId: id, parentItemId: `agent-${id}`, state: "completed", task: `Read ${id}`, extensions: { native: { summary: `Value ${value}` } } } },
      })),
    );
    expect(events.filter(event => event.type === "item/completed" && event.payload.item.type === "agentMessage" && event.payload.item.phase === "final")).toMatchObject(
      ["Both readers are running", "Alpha finished", "Alpha and beta finished"].map((text, i) => ({
        turnId: completedTurns[i], payload: { item: { text, ...(i > 0 ? { extensions: { native: { origin: { kind: "task-notification" } } } } : {}) } },
      })),
    );
  } finally {
    await reader.return?.();
    await runtime.dispose();
  }
});

test("steer never appends Claude input; interrupt preserves the current turn identity", async () => {
  const { runtime, session, queries } = await setup({}, async (_,stream) => {await stream.text("working");}); const submission = await submitAndYield(session);
  await expect(session.request("turn/steer", { requestId: "steer", sessionId: "s", submissionId:"steer-input", expectedTurnId: submission.requireTurnId(), input: [{ type: "text", text: "do not enqueue" }] })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  await session.interrupt(); const events = await collect(session);
  expect(events.at(-1)?.payload).toMatchObject({ turnId: submission.requireTurnId(), status: "interrupted" }); expect(queries[0]!.calls.filter((call) => call.method === "input")).toHaveLength(1); await runtime.dispose();
});

test("canUseTool requests approval and only selected options enter the native callback", async () => {
  let permission: unknown;
  const { runtime, session } = await setup({}, async (_, stream) => {
    permission = await stream.options.canUseTool!("Bash", { command: "fixture" }, { signal: new AbortController().signal, toolUseID: "approval", requestId: "native-approval" });
    await stream.result();
  });
  const { events } = await submitAndCollect(session, () => ({ kind: "approval", optionId: "deny" }));
  expect(permission).toMatchObject({ behavior: "deny" }); expect(events.some((event) => event.type === "interaction/resolved" && event.payload.outcome === "responded")).toBe(true); await runtime.dispose();
});

test("an aborted permission callback returns without publishing an interaction", async () => {
  let permission: unknown;
  const controller = new AbortController();
  const { runtime, session } = await setup({}, async (_, stream) => {
    const callback = stream.options.canUseTool!("Bash", { command: "fixture" }, { signal: controller.signal, toolUseID: "cancelled-approval", requestId: "native-cancelled" });
    controller.abort();
    permission = await callback;
    await stream.result();
  });
  try {
    const { events } = await submitAndCollect(session, () => ({ kind: "approval", optionId: "deny" }));
    expect(permission).toEqual({ behavior: "deny", message: "Request cancelled" });
    expect(events.some(event => event.type === "interaction/requested")).toBe(false);
  } finally { await runtime.dispose(); }
});

test("AskUserQuestion and URL elicitation use typed interactions with private URLs", async () => {
  const native: unknown[] = [];
  const { runtime, session } = await setup({}, async (_, stream) => {
    native.push(await stream.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Choose", header: "Choice", options: [{ label: "A" }, { label: "B" }] }] }, { signal: new AbortController().signal, toolUseID: "question", requestId: "native-question" }));
    native.push(await stream.options.onElicitation!({ serverName: "mcp", message: "Authenticate", mode: "url", url: "https://example.com/auth?token=PRIVATE" }, { signal: new AbortController().signal, requestId: "url" }));
    await stream.result();
  });
  const { events } = await submitAndCollect(session, (request) => request.kind === "userInput" ? { kind: "userInput", answers: { q0: "A" } } : { kind: "elicitation", action: "cancel" });
  expect(native[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { Choose: "A" } } }); expect(native[1]).toMatchObject({ action: "cancel" });
  expect(events.find((event) => event.type === "interaction/requested" && event.payload.kind === "elicitation")?.payload).toMatchObject({ privatePayloadAvailable: true }); await runtime.dispose();
});

test("form elicitation projects scalar answers; unrepresentable values cancel natively", async () => {
  const good = await setupFormElicitation({ message: "Configure", requestId: "form" });
  try {
    const { events } = await submitAndCollect(good.session, () => ({ kind: "elicitation", action: "accept", content: { name: "Ada", count: 2, enabled: true, tags: ["a", "b"] } }));
    expect(good.native[0]).toMatchObject({ action: "accept", content: { name: "Ada", count: 2, enabled: true, tags: ["a", "b"] } });
    expect(events.filter((event) => event.type === "interaction/resolved" && event.payload.outcome === "responded")).toHaveLength(1);
  } finally { await good.runtime.dispose(); }

  const bad = await setupFormElicitation({ message: "Unsupported", requestId: "unsupported" });
  try {
    await submitAndYield(bad.session);
    const reader = readerFor(bad.session);
    try {
      const request = await readThroughEvent(reader, "interaction/requested");
      await expect(bad.session.request("interaction/respond", {
        requestId: "bad",
        sessionId: bad.session.binding.sessionId,
        interactionId: request.payload.interactionId,
        response: { kind: "elicitation", action: "accept", content: { nested: { deep: true } } },
      })).rejects.toMatchObject({ message: "Elicitation response cannot be represented by MCP" });
      await readThroughEvent(reader, "turn/completed");
      expect(bad.native[0]).toMatchObject({ action: "cancel" });
    } finally { await reader.return?.(); }
  } finally { await bad.runtime.dispose(); }
});

/** Invoke the adapter's native elicitation callback before emitting a terminal. The test answers
 * through the SDK and can inspect the native callback's return after the terminal arrives. */
async function setupFormElicitation({ message, requestId }: { message: string; requestId: string }) {
  const native: unknown[] = [];
  const fixture = await setup({}, async (_, stream) => {
    if (!stream.options.onElicitation) throw new Error("Missing native elicitation callback");
    native.push(await stream.options.onElicitation({ serverName: "mcp", message, mode: "form" }, { signal: new AbortController().signal, requestId }));
    await stream.result();
  });
  return { ...fixture, native };
}

/** Consume through one event on the caller's subscription. End of stream without it is a failure. */
async function readThroughEvent<T extends AhpEvent["type"]>(reader: AsyncIterator<AhpEvent>, type: T) {
  for (;;) {
    const entry = await reader.next();
    if (entry.done) throw new Error(`Missing ${type} event`);
    if (entry.value.type === type) return entry.value as Extract<AhpEvent, { type: T }>;
  }
}

test("unmapped system notices surface as typed warnings without private content", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "system", subtype: "task_started" });
    await stream.emit({ type: "system", subtype: "hook_response", outcome: "success" });
    await stream.emit({ type: "system", subtype: "rate_limit_retry", content: "server busy" });
    await stream.emit({ type: "system", subtype: "future_system" });
    await stream.result();
  });
  const { events } = await submitAndCollect(session);
  const notices = events.filter((event) => event.type === "notice").map((event) => event.payload);
  expect(notices.map((notice) => notice.code)).toEqual(["CLAUDE_TASK_STARTED", "CLAUDE_HOOK_RESPONSE", "CLAUDE_RATE_LIMIT_RETRY", "CLAUDE_FUTURE_SYSTEM"]);
  expect(notices.map((notice) => notice.severity)).toEqual(["info", "info", "warning", "info"]);
  expect(notices.find((notice) => notice.code === "CLAUDE_RATE_LIMIT_RETRY")?.message).toBe("server busy");
  await runtime.dispose();
});

test("configuration uses actual query controls and advertises output schemas", async () => {
  const { runtime, session, adapter, queries } = await setup();
  expect(queries[0]!.options.allowDangerouslySkipPermissions).toBe(true);
  expect(queries[0]!.options.permissionMode).not.toBe('bypassPermissions');
  await session.request("session/config/set", { requestId: "config", sessionId: "s", patch: { model: "different", permissionMode: "plan", maxThinkingTokens: 100 } });
  expect(queries[0]!.calls.map((call) => call.method)).toEqual(["model", "permission", "thinking"]);
  await session.request("session/config/set", { requestId: "bypass", sessionId: "s", patch: { permissionMode: "bypassPermissions" } });
  expect(queries[0]!.calls.at(-1)).toMatchObject({ method: "permission", value: "bypassPermissions" });
  expect(session.capabilities.turn?.outputSchema).toBe(true);
  expect(await adapter.listModels()).toMatchObject([{ value: "fake-model" }]); await runtime.dispose();
});

test("configuration failure preserves earlier native effects without committing the patch or applying later controls", async () => {
  const { runtime, session, queries } = await setup();
  try {
    const query = queries[0]!;
    query.setPermissionMode = async (value) => {
      query.calls.push({ method: "permission", value });
      throw new HarnessSdkError("NATIVE_PERMISSION_REJECTED");
    };
    await expect(session.request("session/config/set", {
      requestId: "partial-config", sessionId: session.id,
      patch: { model: "changed-model", permissionMode: "plan", fastMode: true, maxThinkingTokens: 100 },
    })).rejects.toMatchObject({ code: "NATIVE_PERMISSION_REJECTED", outcomeUnknown: false });
    expect(query.calls).toEqual([{ method: "model", value: "changed-model" }, { method: "permission", value: "plan" }]);

    // A later successful patch publishes the retained native model but cannot commit the failed patch.
    const state = await session.request("session/config/set", {
      requestId: "next-config", sessionId: session.id, patch: { fastMode: false },
    });
    expect(state.model).toBe("changed-model");
    expect(state.config).toEqual({ fastMode: false });
    expect(state.capabilityRevision).toBe(2);
    expect(query.calls.at(-1)).toEqual({ method: "flags", value: { fastMode: false } });
  } finally { await runtime.dispose(); }
});

test("unclassified native configuration failure requires SDK recovery before further changes", async () => {
  const { runtime, session, queries } = await setup();
  try {
    const query = queries[0]!;
    query.setPermissionMode = async () => { throw new Error("Private native failure"); };
    await expect(session.request("session/config/set", {
      requestId: "unknown-config", sessionId: session.id, patch: { model: "changed-model", permissionMode: "plan", fastMode: true },
    })).rejects.toMatchObject({ code: "CLAUDE_CONFIG_FAILED", outcomeUnknown: true });
    await expect(session.request("session/config/set", {
      requestId: "blocked-config", sessionId: session.id, patch: { fastMode: false },
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(query.calls).toEqual([{ method: "model", value: "changed-model" }]);
  } finally { await runtime.dispose(); }
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

/** Supply in-memory history to ClaudeBackendSession.messages and exact inclusive cutoffs to
 * open/revert. Scripted inputs seed the transcript before emitting their native result. */
function historyApi() {
  const histories = new Map<string, SessionMessage[]>();
  /** Return an isolated transcript snapshot. An unknown native session has no recorded history. */
  const sessionMessages: NonNullable<ClaudeAdapterOptions["getSessionMessages"]> = async id => structuredClone(histories.get(id) ?? []);
  /** Copy through a known message UUID so fork/revert assertions can distinguish adjacent cutoffs. */
  const fork: NonNullable<ClaudeAdapterOptions["forkSession"]> = async (source, options) => {
    const messages = histories.get(source);
    const point = options?.upToMessageId;
    const index = messages?.findIndex(message => message.uuid === point) ?? -1;
    if (!messages || index < 0) throw new Error("Unknown exact fork point");
    const sessionId = randomUUID();
    histories.set(sessionId, structuredClone(messages.slice(0, index + 1)));
    return { sessionId };
  };
  /** Seed the native transcript with one prompt/reply pair under the dispatched input's identity. */
  function append(input: SDKUserMessage) {
    const { session_id: id, uuid } = input;
    if (!id || !uuid) throw new Error("History fixture requires a native session ID and input UUID");
    const rows = histories.get(id) ?? [];
    rows.push(
      { type: "user", uuid, session_id: id, message: input.message, parent_tool_use_id: null, parent_agent_id: null },
      { type: "assistant", uuid: `${uuid}:reply`, session_id: id, message: { role: "assistant", content: [{ type: "text", text: "conformance" }] }, parent_tool_use_id: null, parent_agent_id: null },
    );
    histories.set(id, rows);
  }
  /** Seed history before emitting the reply and terminal that make it observable to SDK readers. */
  async function reply(input: SDKUserMessage, stream: FakeQuery) {
    append(input);
    await stream.text("conformance");
    await stream.result();
  }
  return { histories, getSessionMessages: sessionMessages, forkSession: fork, append, reply };
}

test("resume, before/through fork, paged history and conversation revert preserve verified native boundaries", async () => {
  const history = historyApi();
  const { runtime, session, queries } = await setup({ sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession }, history.reply);
  const first = await submitAndCollect(session);
  const firstStart = first.events.find((event) => event.type === "turn/started");
  if (!firstStart) throw new Error("Missing first turn start");
  const second = await submitAndCollect(session);
  const page1 = await session.request("history/read", { requestId: "history", sessionId: "s", limit: 1 });
  expect(page1.items).toHaveLength(1); expect(page1.nextCursor).toBe("1");
  const page2 = await session.request("history/read", { requestId: "history2", sessionId: "s", cursor: page1.nextCursor!, snapshotToken: page1.snapshotToken, limit: 10 });
  expect(page2.items.some((entry) => entry.turnId === second.requireTurnId())).toBe(true);
  const before = await runtime.openSession({ ...OPEN, requestId: "before", mode: "fork", binding: { ...session.binding, sessionId: "before" }, fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: first.requireTurnId(), relation: "before", nativeTurnId: firstStart.payload.nativeTurnId } } });
  expect((await before.request("history/read", { requestId: "before-history", sessionId: "before" })).items).toHaveLength(0); await before.close();
  const through = await runtime.openSession({ ...OPEN, requestId: "through", mode: "fork", binding: { ...session.binding, sessionId: "through" }, fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: first.requireTurnId(), relation: "through" } } });
  const forkHistory = await through.request("history/read", { requestId: "through-history", sessionId: "through" });
  expect(forkHistory.items.some((entry) => entry.turnId === first.requireTurnId())).toBe(true); expect(forkHistory.items.some((entry) => entry.turnId === second.requireTurnId())).toBe(false); await through.close();
  const oldRef = session.binding.nativeRef!.value;
  const reverted = await session.request("session/revert", { requestId: "revert", sessionId: "s", scope: "conversation", boundary: { turnId: second.requireTurnId(), relation: "before" } });
  expect(reverted.nativeRef!.value).not.toBe(oldRef); expect(session.binding.nativeRef).toEqual(reverted.nativeRef);
  const afterRevert = await session.request("history/read", { requestId: "after-revert", sessionId: "s" });
  expect(afterRevert.items.some((entry) => entry.turnId === second.requireTurnId())).toBe(false);
  expect(afterRevert.source).toEqual(reverted.nativeRef);
  expect(await session.request("history/read", { requestId: "continue-after-revert", sessionId: "s", cursor: page1.nextCursor!, snapshotToken: page1.snapshotToken, limit: 10 })).toEqual(page2);
  expect(page2.source?.value).toBe(oldRef);
  const currentBinding = structuredClone(session.binding); await session.close();
  const resumed = await runtime.openSession({ ...OPEN, requestId: "resume", mode: "resume", binding: { ...currentBinding, nativeRef: reverted.nativeRef! } });
  expect(queries.at(-1)!.options.resume).toBe(currentBinding.nativeRef!.value); await resumed.close(); await runtime.dispose();
});

test.each([true, false])("fork and revert resolve merged inputs as a single execution (store: %s)", async (withStore) => {
  const history = historyApi();
  const { runtime, session, queries } = await setup({
    ...(withStore ? { sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession } : {}),
    enableFileCheckpointing: true,
  }, async (input, stream) => {
    history.append(input);
    await stream.text("conformance", input.uuid);
    if (stream.calls.filter(call => call.method === "input").length > 1) await stream.result();
  });
  try {
    const first = await session.submit({ input: "first prompt" });
    const followUp = await session.submit({ input: "follow-up prompt" });
    expect(followUp.id).toBe(first.id);
    await followUp.result();
    const next = await session.submit({ input: "next execution" });
    expect(next.id).not.toBe(first.id);
    await next.result();
    const [initial, alias, later] = queries[0]!.calls.flatMap(call => call.method === "input" ? [(call.value as SDKUserMessage).uuid!] : []);
    const before = { turnId: first.id, nativeTurnId: alias!, relation: "before" } as const;
    const through = { turnId: first.id, relation: "through" } as const;
    await session.request("session/revert", { requestId: "files-before", sessionId: session.id, scope: "files", boundary: before });
    await session.request("session/revert", { requestId: "files-through", sessionId: session.id, scope: "files", boundary: through });
    expect(queries[0]!.calls.filter(call => call.method === "rewind").map(call => call.value)).toEqual([initial, later]);
    if (withStore) {
      const fork = await runtime.openSession({ ...OPEN, requestId: "fork-before-alias", mode: "fork", binding: { ...session.binding, sessionId: "forked" }, fork: { sourceSessionId: session.id, nativeRef: session.binding.nativeRef, boundary: before } });
      expect((await fork.request("history/read", { requestId: "fork-history", sessionId: fork.id })).items).toEqual([]);
      await fork.close();
      await session.request("session/revert", { requestId: "conversation-through-alias", sessionId: session.id, scope: "conversation", boundary: { ...through, nativeTurnId: alias! } });
      const page = await session.request("history/read", { requestId: "history-through-alias", sessionId: session.id });
      expect(page.items.map(entry => [entry.turnId, entry.nativeItemId])).toEqual([
        [first.id, initial], [first.id, `${initial}:reply`], [first.id, alias], [first.id, `${alias}:reply`],
      ]);
    }
  } finally { await runtime.dispose(); }
});

test("fork resolves a host-echoed execution id boundary to its transcript prompt", async () => {
  const history = historyApi();
  const { runtime, session } = await setup({ sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession }, async (input, stream) => { history.append(input); await stream.text("conformance"); await stream.result(); });
  await submitAndYield(session, "t1"); const events = await collect(session);
  const started = events.find((event) => event.type === "turn/started")!;
  const executionId = started.payload.turnId;
  // Hosts round-trip the turn/started identity back as boundary.nativeTurnId, but the
  // transcript prompt keeps its own uuid; the fork must resolve the execution id to it.
  const through = await runtime.openSession({ ...OPEN, requestId: "echoed", mode: "fork", binding: { ...session.binding, sessionId: "echoed" }, fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: executionId, nativeTurnId: executionId, relation: "through" } } });
  const items = await through.request("history/read", { requestId: "echoed-history", sessionId: "echoed" });
  expect(items.items.some((entry) => entry.turnId === requireBoundTurnId(session, "t1"))).toBe(true);
  await through.close(); await runtime.dispose();
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
      { type: "assistant", uuid: "entry-final", session_id: id, message: { id: "msg_api", role: "assistant", content: [{ type: "text", text: "goodbye" }] }, parent_tool_use_id: null, parent_agent_id: null },
    ] as SessionMessage[]);
    await stream.emit({ type: "system", subtype: "init", session_id: id });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_api" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } } });
    await stream.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello" } } });
    await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "msg_api", content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "hello" }] } });
    await stream.text("goodbye", "msg_api"); await stream.result("goodbye");
  });
  const { events } = await submitAndCollect(session);
  const live = events.flatMap((event) => event.type === "item/started" ? [event.payload.item.id] : []);
  expect(live).toEqual(["msg_api:0", "msg_api:1", "msg_api:2"]);
  expect(events.flatMap(event => event.type === "item/completed" && "text" in event.payload.item ? [event.payload.item.text] : [])).toEqual(["plan", "hello", "goodbye"]);
  expect(session.snapshot.status).toBe('ready');
  const page = await session.request("history/read", { requestId: "h", sessionId: "s" });
  expect(page.items.filter((entry) => entry.item.type !== "userMessage").map((entry) => entry.item.id)).toEqual(live);
  await runtime.dispose();
});

test("effort is a session option passed at start and applied live", async () => {
  const fake = factory(); const adapter = createClaudeAdapter({ queryFactory: fake.queryFactory }); const runtime = await createClient({adapter,identity:OPEN.binding,interactions:{approval:undefined,userInput:undefined,elicitation:undefined,dynamicTool:undefined}});
  const init = { capabilities: adapter.capabilities };
  expect(init.capabilities.config?.options.find((option) => option.id === "effort")).toMatchObject({ scope: "session", schema: { enum: ["low", "medium", "high", "xhigh", "max"], default: "high" } });
  const session = await runtime.openSession({ ...OPEN, config: { effort: "low" } });
  await submitAndCollect(session);
  expect(fake.queries[0]!.options.effort).toBe("low");
  await session.request("session/config/set", { requestId: "effort", sessionId: "s", patch: { effort: "max" } });
  expect(fake.queries[0]!.calls).toContainEqual({ method: "flags", value: { effortLevel: "max" } });
  await expect(session.request("session/config/set", { requestId: "bad", sessionId: "s", patch: { effort: "extreme" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await runtime.dispose();
});

test("fast mode is a session option sent as flag settings, switched live, and reports the native outcome", async () => {
  const fake = factory(async (_input, stream) => {
    await stream.emit({ type: "system", subtype: "init", session_id: "s", fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" });
    await stream.text("ok", "m"); await stream.result("ok");
  });
  const adapter = createClaudeAdapter({ queryFactory: fake.queryFactory }); const runtime = await createClient({adapter,identity:OPEN.binding,interactions:{approval:undefined,userInput:undefined,elicitation:undefined,dynamicTool:undefined}});
  const init = { capabilities: adapter.capabilities };
  expect(init.capabilities.config?.options.find((option) => option.id === "fastMode")).toMatchObject({ scope: "session", schema: { type: "boolean", default: false } });
  const session = await runtime.openSession({ ...OPEN, config: { fastMode: true } });
  await submitAndCollect(session);
  expect(fake.queries[0]!.options.settings).toEqual({ fastMode: true });
  expect(session.snapshot.fastMode).toEqual({ state: "off", reason: "extra_usage_disabled" });
  await session.request("session/config/set", { requestId: "fast", sessionId: "s", patch: { fastMode: false } });
  expect(fake.queries[0]!.calls).toContainEqual({ method: "flags", value: { fastMode: false } });
  await expect(session.request("session/config/set", { requestId: "bad", sessionId: "s", patch: { fastMode: "yes" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await runtime.dispose();
});

test("file rollback requires a checkpoint and scope=both reports partial effects on native fork failure", async () => {
  const history = historyApi();
  const fixture = await setup({ sessionStore: new InMemorySessionStore(), enableFileCheckpointing: true, getSessionMessages: history.getSessionMessages, forkSession: async () => { throw new Error("Native fork failed"); } }, history.reply);
  await submitAndCollect(fixture.session);
  const second = await submitAndCollect(fixture.session);
  fixture.queries[0]!.rewindAllowed = false;
  await expect(fixture.session.request("session/revert", { requestId: "no-checkpoint", sessionId: "s", scope: "files", boundary: { turnId: second.requireTurnId(), relation: "before" } })).rejects.toMatchObject({ code: "CHECKPOINT_UNAVAILABLE" });
  expect(fixture.queries[0]!.calls.filter((call) => call.method === "rewind")).toHaveLength(0);
  fixture.queries[0]!.rewindAllowed = true;
  await expect(fixture.session.request("session/revert", { requestId: "partial", sessionId: "s", scope: "both", boundary: { turnId: second.requireTurnId(), relation: "before" } })).rejects.toMatchObject({ code: "REVERT_PARTIAL", outcomeUnknown: true, details: { appliedScope: "files" } });
  expect(fixture.queries[0]!.calls.filter((call) => call.method === "rewind")).toHaveLength(1); await fixture.runtime.dispose();
});

test("Claude adapter passes shared conformance for all declared capabilities", async () => {
  const report = await runConformance((scenario: ConformanceScenario) => {
    const history = historyApi(); const native = factory(async (input, stream) => {
      history.append(input);
      if (["interrupt", "disconnect", "backpressure"].includes(scenario)) {await stream.text("working");return;}
      if (scenario === "approval") await stream.options.canUseTool!("Bash", { command: "fixture" }, { signal: new AbortController().signal, toolUseID: "approval", requestId: "native-approval" });
      if (scenario === "userInput") await stream.options.canUseTool!("AskUserQuestion", { questions: [{ question: "Value", header: "Value" }] }, { signal: new AbortController().signal, toolUseID: "question", requestId: "native-question" });
      if (scenario === "elicitation") await stream.options.onElicitation!({ serverName: "mcp", message: "Value", mode: "form" }, { signal: new AbortController().signal, requestId: "elicitation" });
      if (scenario === "unknown-item") await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "unknown", content: [{ type: "futureContent", safeField: "value" }] } });
      await stream.text("conformance"); await stream.result();
    });
    return { adapter: createClaudeAdapter({ queryFactory: native.queryFactory, sessionStore: new InMemorySessionStore(), getSessionMessages: history.getSessionMessages, forkSession: history.forkSession }), openParams: { ...OPEN, binding: { ...OPEN.binding, sessionId: "conformance-session" } }, ...(scenario === "disconnect" || scenario === "backpressure" ? { afterStart: async () => { native.queries[0]!.output.end(new HarnessSdkError(scenario==="disconnect"?"CONNECTION_CLOSED":"BACKPRESSURE_EXCEEDED")); } } : {}) };
  });
  expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]); expect(report.passed).toBe(true);
  expect(report.cases.filter((entry) => entry.status === "not-applicable").map((entry) => entry.scenario)).toEqual(["dynamicTool", "steer"]);
}, 20_000);

test("the real pinned SDK drives an external fake executable through the native adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude sdk actual "));
  const runtime = await createClient({identity:OPEN.binding,adapter:createClaudeAdapter({ command: fileURLToPath(new URL("../tests/fixtures/fake-claude.mjs", import.meta.url)), executableRuntime: "node", stateDir: join(directory, "state") })});
  try {
    const session = await runtime.openSession({ ...OPEN, cwd: directory }); const { events } = await submitAndCollect(session);
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
  const { events } = await submitAndCollect(session);
  expect(events.find(event => event.type === "item/delta" && event.payload.itemId === "edit")).toMatchObject({ payload: { kind: "patch", value: { fileChanges: [{ materials: [{ scope: "fragment" }] }] } } });
  expect(events.find(event => event.type === "item/completed" && event.payload.item.id === "edit")).toMatchObject({ payload: { item: { status: "completed", fileChanges: [{ completeness: "complete", materials: [{ format: "unified", patch: "@@ -57,1 +57,1 @@\n-old\n+new\n" }] }] } } });
  await runtime.dispose();
});

test("an interrupted turn cannot leave an unresolved file edit running or count it as applied", async () => {
  const { runtime, session } = await setup({}, async (_, stream) => {
    await stream.emit({ type: "assistant", parent_tool_use_id: null, message: { id: "message", content: [{ type: "tool_use", id: "edit", name: "Write", input: { file_path: "index.ts", content: "attempt" } }] } });
    await stream.emit({ type: "result", subtype: "success", result: "", stop_reason: "interrupted", usage: {} });
  });
  const { events } = await submitAndCollect(session);
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
  const { events } = await submitAndCollect(session, () => ({ kind: "approval", optionId: "deny" }));
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
  const pump = (async () => { for await (const event of f.session.events()) events.push(event); })().catch(cause=>{if(cause.code!=='OBSERVATION_CLOSED')throw cause;});
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


test("interleaved child streams keep ownership and never replace the parent final answer", async () => {
  const { runtime, session, queries } = await setup({}, async (_, stream) => {
    for (const [parent, id] of [[null, "parent"], ["agent-a", "child-a"], ["agent-b", "child-b"]]) {
      await stream.emit({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: { id } } });
      await stream.emit({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    }
    for (const [parent, id, text] of [["agent-a", "child-a", "A"], [null, "parent", "P"], ["agent-b", "child-b", "B"]]) {
      await stream.emit({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
      await stream.emit({ type: "assistant", parent_tool_use_id: parent, message: { id, content: [{ type: "text", text }] } });
    }
    await stream.result("parent final");
  });
  await submitAndYield(session, "t"); const events = await collect(session);
  const completed = events.filter(e => e.type === "item/completed").map(e => e.payload.item);
  expect(completed).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "child-a:0", parentItemId: "agent-a", text: "A", phase: "commentary" }),
    expect.objectContaining({ id: "child-b:0", parentItemId: "agent-b", text: "B", phase: "commentary" }),
    expect.objectContaining({ id: "parent:0", text: "parent final", phase: "final" }),
  ]));
  expect(queries[0]!.options.forwardSubagentText).toBe(true);
  await runtime.dispose();
});

test('native lifecycle also correlates through the pinned official SDK and an actual child executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude native actual '));
  const client = await createClient({ adapter: createClaudeAdapter({ command: fileURLToPath(new URL('../tests/fixtures/fake-claude.mjs', import.meta.url)), executableRuntime: 'node', stateDir: join(directory, 'state') }), identity: { adapterId: 'claude', runtimeConfigId: 'native' } });
  try {
    const session = await client.sessions.create({ cwd: directory });
    const turn = await session.submit({ input: 'probe' }, { timeoutMs: 3000 });
    expect((await turn.result({ timeoutMs: 3000 })).text).toBe('external executable probe passed');
    await session.close();
  } finally { await client.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}, 15_000);

/** Run a scripted native goal loop: `/goal <condition>` acknowledges, works and finishes like the CLI does. */
function goalFactory(hold?: Promise<void>) {
  return factory(async (input, stream) => {
    const text = typeof input.message.content === 'string' ? input.message.content : '';
    if (text === '/goal clear') { await stream.text('No goal set'); await stream.result('No goal set'); return; }
    if (text.startsWith('/goal ')) {
      await stream.text(`Goal set: ${text.slice(6)}`);
      if (hold) await hold;
      await stream.text('done', 'work');
      await stream.result('done');
      return;
    }
    await stream.text('ok'); await stream.result('ok');
  });
}
const goalInputs = (fake: ReturnType<typeof factory>) => fake.queries.flatMap(query => query.calls)
  .flatMap(call => call.method === 'input' ? [(call.value as SDKUserMessage).message.content] : []);

test('goal set runs the native /goal command and the goal ends with its execution', async () => {
  const fake = goalFactory();
  const client = await createClient({ adapter: createClaudeAdapter({ queryFactory: fake.queryFactory }), identity: { adapterId: 'claude', runtimeConfigId: 'goal' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    expect(session.capabilities.goal).toEqual({ actions: ['set', 'clear'] });
    const events: AhpEvent[] = [];
    const pump = (async () => { for await (const event of session.events()) events.push(event); })().catch(() => {});
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(predicate()).toBe(true); };

    expect(await session.request('goal/set', { requestId: 'set', sessionId: session.id, goal: { objective: '  all tests pass  ' } })).toEqual({ goal: { objective: 'all tests pass' }, status: 'active' });
    expect(goalInputs(fake)).toEqual(['/goal all tests pass']);
    // The loop runs as an unbound native execution; its completion ends the goal and publishes the settled state.
    await until(() => events.some(event => event.type === 'turn/completed'));
    await until(() => session.snapshot.goal?.status === 'cleared');
    expect(session.snapshot.goal).toEqual({ goal: { objective: 'all tests pass' }, status: 'cleared' });
    const states = events.flatMap(event => event.type === 'session/state' && event.payload.goal ? [event.payload.goal.status] : []);
    expect(states[0]).toBe('active'); expect(states.at(-1)).toBe('cleared');
    await session.close(); await pump;
  } finally { await client.dispose(); }
});

test('goal set rejects invalid objectives and busy sessions before reaching the CLI', async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const fake = factory(async (_input, stream) => { await stream.text('working'); await gate; await stream.result('finished'); });
  const client = await createClient({ adapter: createClaudeAdapter({ queryFactory: fake.queryFactory }), identity: { adapterId: 'claude', runtimeConfigId: 'goal-invalid' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    let n = 0;
    for (const objective of ['', '   ', 'clear', ' OFF ', 'x'.repeat(4001), 7, undefined]) {
      await expect(session.request('goal/set', { requestId: `bad-${n++}`, sessionId: session.id, goal: { objective } as never })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(goalInputs(fake)).toEqual([]);
    const turn = await session.submit({ input: 'work' });
    await expect(session.request('goal/set', { requestId: 'busy', sessionId: session.id, goal: { objective: 'finish' } })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(goalInputs(fake)).toHaveLength(1);
    release(); await turn.result(); await session.close();
  } finally { release(); await client.dispose(); }
});

test('goal clear sends /goal clear, also while a goal loop is running', async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const fake = goalFactory(gate);
  const client = await createClient({ adapter: createClaudeAdapter({ queryFactory: fake.queryFactory }), identity: { adapterId: 'claude', runtimeConfigId: 'goal-clear' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    await session.request('goal/set', { requestId: 'set', sessionId: session.id, goal: { objective: 'finish' } });
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(predicate()).toBe(true); };
    await until(() => session.snapshot.status === 'running');
    expect(await session.request('goal/clear', { requestId: 'clear', sessionId: session.id })).toEqual({ goal: null, status: 'cleared' });
    expect(session.snapshot.goal).toEqual({ goal: null, status: 'cleared' });
    release();
    await until(() => session.snapshot.status === 'ready');
    // The finished loop must not resurrect or re-clear anything.
    expect(session.snapshot.goal).toEqual({ goal: null, status: 'cleared' });
    await session.close();
  } finally { release(); await client.dispose(); }
});

test('an interrupted goal execution leaves the goal set for the user to clear', async () => {
  const { promise: gate } = Promise.withResolvers<void>();
  const fake = goalFactory(gate);
  const client = await createClient({ adapter: createClaudeAdapter({ queryFactory: fake.queryFactory }), identity: { adapterId: 'claude', runtimeConfigId: 'goal-interrupt' } });
  try {
    const session = await client.sessions.create({ cwd: process.cwd() });
    await session.request('goal/set', { requestId: 'set', sessionId: session.id, goal: { objective: 'finish' } });
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(predicate()).toBe(true); };
    await until(() => session.snapshot.status === 'running');
    await session.interrupt();
    await until(() => session.snapshot.status === 'ready');
    expect(session.snapshot.goal).toEqual({ goal: { objective: 'finish' }, status: 'active' });
    await session.close();
  } finally { await client.dispose(); }
});
