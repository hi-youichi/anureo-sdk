import { expect, test } from "bun:test";
import { createHarnessRuntime, HarnessSdkError, ManagedHarnessSession, type HarnessRuntime, type SessionEventSink } from "@anureo/sdk";
import type { AhpEvent, GoalState, InteractionRequested, InteractionResponse, SessionOpenParams, SessionState } from "@anureo/protocol";
import { createScriptedAdapter, FAKE_CAPABILITIES, type FakeAdapterOptions } from "./fake";

const OPEN: SessionOpenParams = { requestId: "open", mode: "new", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" }, cwd: "/tmp" };
async function setup(options?: FakeAdapterOptions, runtimeOptions?: Parameters<typeof createHarnessRuntime>[1]) {
  const adapter = createScriptedAdapter(options); const runtime = createHarnessRuntime(adapter, runtimeOptions);
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" }, clientCapabilities: { interactions: ["approval", "userInput", "elicitation", "dynamicTool"] } });
  const session = await runtime.openSession(OPEN); return { adapter, runtime, session, sink: adapter.sinks.get("s")! };
}
async function nextType(reader: AsyncIterator<AhpEvent>, type: AhpEvent["type"]): Promise<AhpEvent> {
  for (let i = 0; i < 100; i++) { const event = await reader.next(); if (event.done) throw new Error(`Stream ended before ${type}`); if (event.value.type === type) return event.value; }
  throw new Error(`Missing ${type}`);
}

test("standalone runtime captures immediate events before start returns and authoritative completed text", async () => {
  const { runtime, session, adapter } = await setup();
  const result = await session.startTurn({ requestId: "run", sessionId: "s", turnId: "t", input: [{ type: "text", text: "authority" }] });
  expect(result.turnId).toBe("t");
  const events: AhpEvent[] = []; const reader = session.events()[Symbol.asyncIterator]();
  while (true) { const event = (await reader.next()).value!; events.push(event); if (event.type === "turn/completed") break; }
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(events.filter((event) => event.type === "item/completed").map((event) => event.payload.item)).toMatchObject([{ text: "authority" }]);
  expect(session.binding.nativeRef).toEqual({ provider: "scripted", value: "native:s" });
  await reader.return?.(); await runtime.dispose(); expect(adapter.disposeCount).toBe(1);
});

test("immutable binding and unsupported capabilities never reach the backend", async () => {
  const { runtime, session, adapter } = await setup({ capabilities: {} });
  expect(Object.isFrozen(session.binding)).toBe(true); expect(Object.isFrozen(session.capabilities)).toBe(true);
  await expect(session.revert({ requestId: "rev", sessionId: "s", boundary: { turnId: "t", relation: "before" }, scope: "both" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  expect(adapter.calls).toHaveLength(0);
  await expect(runtime.openSession({ ...OPEN, binding: { ...OPEN.binding, sessionId: "resume", nativeRef: { provider: "scripted", value: "native:s" } }, mode: "resume" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  await runtime.dispose();
});

test("busy rejects rather than queues; steer targets the current turn; interrupt waits for native completion", async () => {
  const { runtime, session, adapter, sink } = await setup({ execute: async (call, events) => {
    if (call.method === "turn/start") { const turnId = (call.params as { turnId: string }).turnId; await events.emit({ type: "turn/started", payload: { turnId } }); return { accepted: true, turnId }; }
  } });
  await session.startTurn({ requestId: "run", sessionId: "s", turnId: "t", input: [{ type: "text", text: "hold" }] });
  await expect(session.startTurn({ requestId: "second", sessionId: "s", turnId: "t2", input: [{ type: "text", text: "hold" }] })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await expect(session.steer({ requestId: "steer", sessionId: "s", expectedTurnId: "wrong", input: [{ type: "text", text: "fix" }] })).rejects.toMatchObject({ code: "TURN_MISMATCH" });
  await session.interrupt({ requestId: "interrupt", sessionId: "s", turnId: "t" });
  const reader = session.events()[Symbol.asyncIterator](); const terminal = await nextType(reader, "turn/completed");
  expect(terminal.payload).toMatchObject({ status: "interrupted" });
  expect(adapter.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  await sink.emit({ type: "turn/completed", payload: { turnId: "t", status: "interrupted" } });
  await reader.return?.(); await runtime.dispose();
});

test("item IDs reused by different turns remain separate and duplicate terminals are suppressed", async () => {
  const { runtime, session, sink } = await setup();
  for (const turnId of ["a", "b"]) await session.startTurn({ requestId: turnId, sessionId: "s", turnId, input: [{ type: "text", text: turnId }] });
  await sink.emit({ type: "turn/completed", payload: { turnId: "a", status: "completed" } });
  const reader = session.events()[Symbol.asyncIterator](); const terminals: string[] = []; const items: string[] = [];
  while (terminals.length < 2) { const event = (await reader.next()).value!; if (event.type === "turn/completed") terminals.push(event.payload.turnId); if (event.type === "item/completed") items.push(`${event.turnId}:${event.payload.item.id}`); }
  expect(terminals).toEqual(["a", "b"]); expect(items).toEqual(["a:native-reused", "b:native-reused"]);
  await reader.return?.(); await runtime.dispose();
});

test("non-pausable overflow emits a failed turn in the reserved slot", async () => {
  const { runtime, session, sink } = await setup({ execute: async (call, events) => {
    if (call.method === "turn/start") { const turnId = (call.params as { turnId: string }).turnId; await events.emit({ type: "turn/started", payload: { turnId } }); return { accepted: true, turnId }; }
  } }, { queue: { maxEvents: 2 } });
  await session.startTurn({ requestId: "run", sessionId: "s", turnId: "t", input: [{ type: "text", text: "hold" }] });
  expect(sink.tryEmit({ type: "notice", payload: { severity: "info", code: "N", message: "overflow" } })).toBe(false);
  const reader = session.events()[Symbol.asyncIterator](); const terminal = await nextType(reader, "turn/completed");
  expect(terminal.payload).toMatchObject({ status: "failed", error: { code: "BACKPRESSURE_EXCEEDED" } });
  expect((await reader.next()).done).toBe(true); await runtime.dispose();
});

test("detach releases the only reader without interrupting a running turn", async () => {
  const { runtime, session, adapter } = await setup(); const reader = session.events()[Symbol.asyncIterator]();
  await reader.next(); await reader.return?.();
  await session.startTurn({ requestId: "run", sessionId: "s", turnId: "t", input: [{ type: "text", text: "after detach" }] });
  expect(adapter.calls.some((call) => call.method === "turn/interrupt")).toBe(false);
  const again = session.events()[Symbol.asyncIterator](); await nextType(again, "turn/completed"); await again.return?.(); await runtime.dispose();
});

const interactions: Array<{ request: InteractionRequested; response: InteractionResponse }> = [
  { request: { interactionId: "approval", kind: "approval", options: [{ id: "yes", label: "Allow once" }, { id: "no", label: "Deny" }] }, response: { kind: "approval", optionId: "yes" } },
  { request: { interactionId: "input", kind: "userInput", questions: [{ id: "q", prompt: "Answer?", secret: true }] }, response: { kind: "userInput", answers: { q: "sensitive" } } },
  { request: { interactionId: "elicitation", kind: "elicitation", mode: "form", schema: { type: "object", required: ["name"] } }, response: { kind: "elicitation", action: "accept", content: { name: "A" } } },
  { request: { interactionId: "dynamic", kind: "dynamicTool", toolName: "test", arguments: {} }, response: { kind: "dynamicTool", content: [{ type: "text", text: "result" }] } },
];
for (const entry of interactions) test(`interaction ${entry.request.kind} waits for the native response and resolves once`, async () => {
  const { runtime, session, sink } = await setup(); let received: InteractionResponse | null | undefined;
  const answer = sink.requestInteraction(entry.request, async (response) => { received = response; });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  const result = await session.respond({ requestId: "response", sessionId: "s", interactionId: entry.request.interactionId, response: entry.response });
  expect(result.outcome).toBe("responded"); expect(await answer).toEqual(entry.response); expect(received).toEqual(entry.response);
  const event = await nextType(reader, "interaction/resolved"); expect(event.payload).toMatchObject({ outcome: "responded" });
  await expect(session.respond({ requestId: "other", sessionId: "s", interactionId: entry.request.interactionId, response: entry.response })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  await reader.return?.(); await runtime.dispose();
});

test("invalid interaction answers keep pending; racing valid replies invoke native once", async () => {
  const { runtime, session, sink } = await setup(); let release!: () => void; let calls = 0;
  const pending = sink.requestInteraction(interactions[0].request, async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await expect(session.respond({ requestId: "invalid", sessionId: "s", interactionId: "approval", response: { kind: "approval", optionId: "invented" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  const first = session.respond({ requestId: "first", sessionId: "s", interactionId: "approval", response: interactions[0].response });
  await expect(session.respond({ requestId: "second", sessionId: "s", interactionId: "approval", response: { kind: "approval", optionId: "no" } })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  expect(calls).toBe(1); release(); await first; await pending; await reader.return?.(); await runtime.dispose();
});

test("timeout cancels a pending native interaction rather than approving it", async () => {
  const { runtime, session, sink } = await setup({}, { interactionTimeoutMs: 15 }); let response: InteractionResponse | null | undefined;
  const pending = sink.requestInteraction(interactions[0].request, async (value) => { response = value; });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await expect(pending).rejects.toMatchObject({ code: "INTERACTION_CANCELLED" });
  expect(response).toBe(null); expect((await nextType(reader, "interaction/resolved")).payload).toMatchObject({ outcome: "expired" });
  await reader.return?.(); await runtime.dispose();
});

test("native response loss is unknown and not automatically retried", async () => {
  const { runtime, session, sink } = await setup(); let calls = 0;
  const pending = sink.requestInteraction(interactions[0].request, async () => { calls++; throw new HarnessSdkError("RESULT_UNKNOWN", "private", false, true); });
  void pending.catch(() => {});
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  const params = { requestId: "response", sessionId: "s", interactionId: "approval", response: interactions[0].response };
  await expect(session.respond(params)).rejects.toMatchObject({ outcomeUnknown: true }); await expect(pending).rejects.toMatchObject({ outcomeUnknown: true });
  expect((await nextType(reader, "interaction/resolved")).payload).toMatchObject({ outcome: "unknown" });
  await expect(session.respond(params)).rejects.toMatchObject({ outcomeUnknown: true }); expect(calls).toBe(1);
  await reader.return?.(); await runtime.dispose();
});

test("request IDs dedupe accepted operations and reject changed payload", async () => {
  const { runtime, session, adapter } = await setup(); const params = { requestId: "same", sessionId: "s", turnId: "t", input: [{ type: "text" as const, text: "one" }] };
  await session.startTurn(params); await session.startTurn(params);
  await expect(session.startTurn({ ...params, input: [{ type: "text", text: "changed" }] })).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
  expect(adapter.calls).toHaveLength(1); await runtime.dispose();
});

test("runtime disposal is idempotent and disposes each backend once", async () => {
  const { runtime, adapter } = await setup(); await Promise.all([runtime.dispose(), runtime.dispose()]);
  expect(adapter.disposeCount).toBe(1); expect(adapter.backends.get("s")?.disposeCount).toBe(1);
});

test("runtime disposal preserves backend stop failure after cleaning every owner", async () => {
  const { runtime, adapter } = await setup();
  await runtime.openSession({ ...OPEN, binding: { ...OPEN.binding, sessionId: "other" } });
  const failure = new HarnessSdkError("PROCESS_DISPOSE_FAILED", "Process termination could not be verified", false, true);
  let attempts = 0;
  adapter.backends.get("s")!.dispose = async () => { attempts++; throw failure; };
  const disposal = runtime.dispose();
  await expect(disposal).rejects.toBe(failure);
  await expect(runtime.dispose()).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(adapter.backends.get("other")?.disposeCount).toBe(1);
  expect(adapter.disposeCount).toBe(1);
});

test("remote resolved events retire the registry without submitting another native response", async () => {
  const { runtime, session, sink } = await setup({}, { interactionTimeoutMs: 20 }); let calls = 0;
  const pending = sink.requestInteraction(interactions[0].request, async () => { calls++; }); void pending.catch(() => {});
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await sink.resolveInteraction({ interactionId: "approval", outcome: "expired" });
  await sink.resolveInteraction({ interactionId: "approval", outcome: "expired" });
  await expect(pending).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  expect((await nextType(reader, "interaction/resolved")).payload).toMatchObject({ outcome: "expired" });
  await expect(session.respond({ requestId: "late", sessionId: "s", interactionId: "approval", response: interactions[0].response })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  await new Promise((resolve) => setTimeout(resolve, 25)); expect(calls).toBe(0);
  await reader.return?.(); await runtime.dispose();
});

test("open configuration and model survive the initial authority snapshot", async () => {
  const adapter = createScriptedAdapter(); const runtime = createHarnessRuntime(adapter);
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" } });
  const session = await runtime.openSession({ ...OPEN, config: { effort: "high" }, model: "configured-model" });
  const reader = session.events()[Symbol.asyncIterator](); const state = await nextType(reader, "session/state");
  expect(state.payload).toMatchObject({ config: { effort: "high" }, model: "configured-model" });
  await reader.return?.(); await session.close(); await runtime.dispose(); expect(adapter.backends.get("s")?.disposeCount).toBe(1);
});

test("a revert result updates the recoverable native reference without changing fixed session identity", async () => {
  const { runtime, session, sink } = await setup({ execute: async (call) => call.method === "session/revert" ? { appliedScope: "conversation", boundary: { turnId: "old", relation: "before" }, nativeRef: { provider: "scripted", value: "native:reverted" } } : undefined });
  await session.revert({ requestId: "revert", sessionId: "s", scope: "conversation", boundary: { turnId: "old", relation: "before" } });
  expect(session.binding).toEqual({ ...OPEN.binding, nativeRef: { provider: "scripted", value: "native:reverted" } });
  expect(Object.isFrozen(session.binding.nativeRef)).toBe(true);
  await sink.emit({ type: "session/state", payload: { binding: { ...session.binding, nativeRef: { provider: "scripted", value: "native:authoritative" } }, capabilities: structuredClone(session.capabilities), config: {}, status: "ready", capabilityRevision: 1 } });
  expect(session.binding.nativeRef).toEqual({ provider: "scripted", value: "native:authoritative" });
  await runtime.dispose();
});

test("a backend failing during open cannot be returned as a successfully opened session", async () => {
  const adapter = createScriptedAdapter({ onOpen: async (_, sink) => { await sink.fail(new HarnessSdkError("HARNESS_UNAVAILABLE")); } });
  const runtime = createHarnessRuntime(adapter); await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" } });
  await expect(runtime.openSession(OPEN)).rejects.toMatchObject({ code: "HARNESS_UNAVAILABLE" });
  expect(adapter.backends.get("s")?.disposeCount).toBe(1); await runtime.dispose();
});

test("an omitted client interaction capability fails closed at the SDK boundary", async () => {
  const adapter = createScriptedAdapter(); const runtime = createHarnessRuntime(adapter);
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "test", version: "1" } });
  await runtime.openSession(OPEN); let response: InteractionResponse | null | undefined;
  await expect(adapter.sinks.get("s")!.requestInteraction(interactions[0].request, async (value) => { response = value; })).rejects.toMatchObject({ code: "INTERACTION_UNSUPPORTED" });
  expect(response).toBeNull(); await runtime.dispose();
});

test("marked secret answers are redacted from native echoes, split deltas and history, but reach the native responder intact", async () => {
  const secret = "PRIVATE_ANSWER_123"; const nativeAnswers: Array<InteractionResponse | null> = [];
  const { runtime, session, sink } = await setup();
  const pending = sink.requestInteraction({ kind: "userInput", interactionId: "secret", questions: [{ id: "password", prompt: "Secret", secret: true }] }, async (answer) => { nativeAnswers.push(answer); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await session.respond({ requestId: "respond", sessionId: "s", interactionId: "secret", response: { kind: "userInput", answers: { password: secret } } }); await pending;
  expect(nativeAnswers).toEqual([{ kind: "userInput", answers: { password: secret } }]);
  await session.startTurn({ requestId: "echo", sessionId: "s", turnId: "echo", input: [{ type: "text", text: `echo ${secret}` }] });
  const events: AhpEvent[] = [];
  while (true) { const event = (await reader.next()).value!; events.push(event); if (event.type === "turn/completed") break; }
  expect(JSON.stringify(events)).not.toContain(secret); expect(JSON.stringify(await session.readHistory({ requestId: "history", sessionId: "s" }))).not.toContain(secret);
  await sink.emit({ type: "turn/started", payload: { turnId: "split" } });
  await sink.emit({ type: "item/started", payload: { item: { id: "split-text", type: "agentMessage", text: "" } } }, { turnId: "split" });
  for (const part of ["PRIVATE_", "ANSWER_", "123"]) await sink.emit({ type: "item/delta", payload: { itemId: "split-text", kind: "text", text: part } }, { turnId: "split" });
  await sink.emit({ type: "item/completed", payload: { item: { id: "split-text", type: "agentMessage", text: secret } } }, { turnId: "split" });
  await sink.emit({ type: "turn/completed", payload: { turnId: "split", status: "completed" } });
  const split: AhpEvent[] = [];
  while (true) { const event = (await reader.next()).value!; split.push(event); if (event.type === "turn/completed") break; }
  expect(split.filter((event) => event.type === "item/delta").map((event) => event.payload.text).join("")).toBe("[redacted]");
  expect(JSON.stringify(split)).not.toContain(secret); await reader.return?.(); await runtime.dispose();
});

test("elicitation writeOnly values are marked before a synchronous native echo", async () => {
  const { runtime, session, sink } = await setup(); const secret = "WRITE_ONLY_SECRET";
  const pending = sink.requestInteraction({ kind: "elicitation", interactionId: "form", mode: "form", schema: { type: "object", properties: { credential: { type: "string", writeOnly: true } }, required: ["credential"] } }, async () => { await sink.emit({ type: "notice", payload: { severity: "info", code: "ECHO", message: secret, raw: { generic: secret } } }); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await session.respond({ requestId: "response", sessionId: "s", interactionId: "form", response: { kind: "elicitation", action: "accept", content: { credential: secret } } }); await pending;
  const echo = await nextType(reader, "notice"); expect(echo.payload).toMatchObject({ message: "[redacted]", raw: { generic: "[redacted]" } });
  await reader.return?.(); await runtime.dispose();
});

test("accepted asynchronous compaction blocks new work until a native ready state confirms completion", async () => {
  const { runtime, session, sink, adapter } = await setup({ execute: async (call) => call.method === "compact/start" ? { maintenanceId: "async", status: "accepted" } : undefined });
  expect(await session.compact({ requestId: "compact", sessionId: "s" })).toMatchObject({ status: "accepted" });
  await sink.emit({ type: "session/metadata", payload: { title: "Title during maintenance" } });
  await expect(session.startTurn({ requestId: "too-early", sessionId: "s", turnId: "t", input: [{ type: "text", text: "wait" }] })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await expect(runtime.openSession({ ...OPEN, binding: { ...OPEN.binding, sessionId: "branch" }, mode: "fork", fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: "old", relation: "through" } } })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await sink.emit({ type: "session/state", payload: { binding: structuredClone(session.binding), capabilities: structuredClone(session.capabilities), config: {}, capabilityRevision: 1, status: "ready" } });
  await session.startTurn({ requestId: "after-ready", sessionId: "s", turnId: "t", input: [{ type: "text", text: "go" }] });
  expect(adapter.calls.filter((call) => call.method === "turn/start")).toHaveLength(1); await runtime.dispose();
});

test("an in-flight fork reserves its live source against concurrent mutation without queuing", async () => {
  let entered!: () => void; const opening = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  const { runtime, session } = await setup({ onOpen: async (params) => { if (params.mode === "fork") { entered(); await hold; } } });
  await session.startTurn({ requestId: "initial", sessionId: "s", turnId: "old", input: [{ type: "text", text: "boundary" }] });
  const branch = runtime.openSession({ ...OPEN, binding: { ...OPEN.binding, sessionId: "branch" }, mode: "fork", fork: { sourceSessionId: "s", nativeRef: session.binding.nativeRef, boundary: { turnId: "old", relation: "through" } } });
  await opening;
  await expect(session.startTurn({ requestId: "during-fork", sessionId: "s", turnId: "next", input: [{ type: "text", text: "wait" }] })).rejects.toMatchObject({ code: "SESSION_BUSY" });
  release(); await branch;
  await session.startTurn({ requestId: "after-fork", sessionId: "s", turnId: "next", input: [{ type: "text", text: "continue" }] });
  await runtime.dispose();
});

test("a compact completion snapshot before acknowledgement cannot leave the session stuck busy", async () => {
  let session!: Awaited<ReturnType<HarnessRuntime["openSession"]>>;
  const fixture = await setup({ execute: async (call, sink) => {
    if (call.method !== "compact/start") return undefined;
    await sink.emit({ type: "session/state", payload: { binding: structuredClone(session.binding), capabilities: structuredClone(session.capabilities), config: {}, capabilityRevision: 1, status: "ready" } });
    return { maintenanceId: "fast", status: "accepted" };
  } });
  session = fixture.session;
  expect(await session.compact({ requestId: "compact", sessionId: "s" })).toMatchObject({ status: "completed" });
  await session.startTurn({ requestId: "after-ready", sessionId: "s", turnId: "t", input: [{ type: "text", text: "go" }] }); await fixture.runtime.dispose();
});

test("privacy metadata ports run before native submission and project restored authoritative history", async () => {
  const remembered: Array<{ sessionId: string; value: string }> = []; let nativeSeen = false;
  const { runtime, session, sink } = await setup({}, {
    onMarkedSecret: (binding, value) => { remembered.push({ sessionId: binding.sessionId, value }); },
    redactHistory: (_binding, page) => ({ ...page, items: page.items.map((entry) => ({ ...entry, item: entry.item.type === "agentMessage" ? { ...entry.item, text: "host-persistent-projection" } : entry.item })) }),
  });
  const pending = sink.requestInteraction({ interactionId: "private", kind: "userInput", questions: [{ id: "q", prompt: "Secret", secret: true }] }, async () => { nativeSeen = true; expect(remembered).toEqual([{ sessionId: "s", value: "secret-port-value" }]); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await session.respond({ requestId: "answer", sessionId: "s", interactionId: "private", response: { kind: "userInput", answers: { q: "secret-port-value" } } }); await pending; expect(nativeSeen).toBe(true);
  await session.startTurn({ requestId: "run", sessionId: "s", turnId: "t", input: [{ type: "text", text: "original" }] });
  expect((await session.readHistory({ requestId: "history", sessionId: "s" })).items[0]?.item).toMatchObject({ text: "host-persistent-projection" });
  await reader.return?.(); await runtime.dispose();
});

test("successful configuration, goal results and state displays redact marked content while preserving protocol identity", async () => {
  const secret = "SUCCESS_RESULT_PRIVATE";
  const marked = { content: secret, status: "ready", scope: "session", schemaType: "string", identifier: "model", revision: 1 };
  const capabilities = { ...structuredClone(FAKE_CAPABILITIES), config: { options: [{ id: "model", scope: "session" as const, title: secret, value: secret, schema: { type: "string", title: secret, description: secret, default: secret, examples: [secret], enum: ["model", "string"], $defs: { choice: { type: "string", description: secret } }, properties: { title: { type: "string", description: secret } } } }] } };
  const activeGoal: GoalState = { goal: { text: secret, numericAnswer: 1 }, status: "active" };
  const clearedGoal: GoalState = { goal: { echo: secret }, status: "cleared" };
  let nativeState!: SessionState;
  const { runtime, session, sink } = await setup({ capabilities, execute: async (call) => {
    if (call.method === "session/config/set") return nativeState;
    if (call.method === "goal/set") return activeGoal;
    if (call.method === "goal/clear") return clearedGoal;
    return undefined;
  } });
  nativeState = { binding: structuredClone(session.binding), status: "ready", config: { model: secret, numericAnswer: 1 }, model: "model", capabilityRevision: 1, capabilities, goal: { goal: { text: secret }, status: "active" } };
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "session/state");
  const pending = sink.requestInteraction({ interactionId: "result-secret", kind: "userInput", questions: Object.keys(marked).map((id) => ({ id, prompt: id, secret: true })) }, async () => {});
  await nextType(reader, "interaction/requested");
  await session.respond({ requestId: "mark", sessionId: "s", interactionId: "result-secret", response: { kind: "userInput", answers: marked } }); await pending;
  const configured = await session.setConfig({ requestId: "configure", sessionId: "s", patch: { model: "model" } });
  expect(configured).toMatchObject({ binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" }, status: "ready", capabilityRevision: 1, model: "model", config: { model: "[redacted]", numericAnswer: "[redacted]" }, goal: { goal: { text: "[redacted]" }, status: "active" } });
  expect(configured.capabilities.config!.options[0]).toEqual({ ...capabilities.config.options[0], title: "[redacted]", value: "[redacted]", schema: { type: "string", title: "[redacted]", description: "[redacted]", default: "[redacted]", examples: ["[redacted]"], enum: ["model", "string"], $defs: { choice: { type: "string", description: "[redacted]" } }, properties: { title: { type: "string", description: "[redacted]" } } } });
  expect(await session.setGoal({ requestId: "goal", sessionId: "s", goal: { text: "ordinary" } })).toEqual({ goal: { text: "[redacted]", numericAnswer: "[redacted]" }, status: "active" });
  expect(await session.clearGoal({ requestId: "clear", sessionId: "s" })).toEqual({ goal: { echo: "[redacted]" }, status: "cleared" });
  await sink.emit({ type: "session/state", payload: nativeState });
  const event = await nextType(reader, "session/state"); expect(event.payload).toEqual(configured);
  expect(JSON.stringify(configured)).not.toContain(secret); expect(JSON.stringify(event)).not.toContain(secret);
  expect(nativeState.config.model).toBe(secret);
  await reader.return?.(); await runtime.dispose();
});
