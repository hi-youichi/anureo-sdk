import { expect, test } from "bun:test";
import { createClient, HarnessSdkError, type RuntimeOptions } from "@anureo/sdk";
import type { AhpEvent, GoalState, InputSubmitParams, InteractionRequested, InteractionResponse, SessionOpenParams, SessionState, TurnSteerParams } from "@anureo/protocol";
import { createScriptedAdapter, FAKE_CAPABILITIES, type FakeAdapterOptions } from "./fake";

const OPEN: SessionOpenParams = { requestId: "open", mode: "new", binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" }, cwd: "/tmp" };
/**
 * Open a scripted session with manual responses enabled for every interaction kind. Setup failures
 * reject. Each test owns its event readers and must dispose the returned client.
 */
async function setup({ adapterOptions, runtimeOptions }: {
  adapterOptions?: FakeAdapterOptions;
  runtimeOptions?: RuntimeOptions;
} = {}) {
  const adapter = createScriptedAdapter(adapterOptions);
  const runtime = await createClient({
    adapter, identity: OPEN.binding, runtime: runtimeOptions,
    interactions: { approval: undefined, userInput: undefined, elicitation: undefined, dynamicTool: undefined },
  });
  const session = await runtime.openSession(OPEN);
  const sink = adapter.sinks.get(OPEN.binding.sessionId);
  if (!sink) throw new Error("Scripted session opened without recording its event sink");
  return { adapter, runtime, session, sink };
}
/** Consume at most 100 events through a matching publication. Reject on early stream closure or no match. */
async function nextType(reader: AsyncIterator<AhpEvent>, type: AhpEvent["type"]): Promise<AhpEvent> {
  for (let i = 0; i < 100; i++) {
    const event = await reader.next();
    if (event.done) throw new Error(`Stream ended before ${type}`);
    if (event.value.type === type) return event.value;
  }
  throw new Error(`Missing ${type}`);
}

/**
 * Collect from the current reader position through the next terminal, inclusive, for sequence and
 * redaction assertions. Reject if observation ends early. The test retains reader ownership.
 */
async function readThroughTurnCompletion(reader: AsyncIterator<AhpEvent>): Promise<AhpEvent[]> {
  const events: AhpEvent[] = [];
  for (;;) {
    const event = await reader.next();
    if (event.done) throw new Error("Stream ended before turn/completed");
    events.push(event.value);
    if (event.value.type === "turn/completed") return events;
  }
}

test("root client retains immediate results and emits authoritative completed text", async () => {
  const { runtime, session, adapter } = await setup();
  const reader = session.events()[Symbol.asyncIterator]();
  const turn = await session.submit({ input: 'authority' });
  expect((await turn.result()).text).toBe('authority');
  const events = await readThroughTurnCompletion(reader);
  expect(events.every((event, index) => event.seq === events[0]!.seq + index)).toBe(true);
  expect(events.filter(event => event.type === 'item/completed').map(event => event.payload.item)).toMatchObject([{ text: 'authority' }]);
  expect(session.binding.nativeRef).toEqual({ provider: 'scripted', value: 'native:s' });
  await reader.return?.(); await runtime.dispose(); expect(adapter.disposeCount).toBe(1);
});

test("immutable binding and unsupported capabilities never reach the backend", async () => {
  const { runtime, session, adapter } = await setup({ adapterOptions: { capabilities: {} } });
  expect(Object.isFrozen(session.binding)).toBe(true); expect(Object.isFrozen(session.capabilities)).toBe(true);
  await expect(session.request("session/revert", { requestId: "rev", sessionId: "s", boundary: { turnId: "t", relation: "before" }, scope: "both" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  expect(adapter.calls).toHaveLength(0);
  await expect(runtime.openSession({ ...OPEN, binding: { ...OPEN.binding, sessionId: "resume", nativeRef: { provider: "scripted", value: "native:s" } }, mode: "resume" })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  await runtime.dispose();
});

test("native admission owns overlap; exact steer and interrupt use the observed execution", async () => {
  const { runtime, session, adapter } = await setup({
    adapterOptions: {
      /** Keep admitted turns active so each control can target the observed native ID. */
      async execute(call, sink) {
        if (call.method === 'input/submit') {
          const { submissionId } = call.params as InputSubmitParams;
          const turnId = `native:${submissionId}`;
          await sink.emit({ type: 'turn/started', payload: { turnId } });
          return { submissionId, accepted: true, disposition: 'started', turnId };
        }
        if (call.method === 'turn/steer') {
          const { submissionId, expectedTurnId } = call.params as TurnSteerParams;
          return { submissionId, accepted: true, turnId: expectedTurnId };
        }
      },
    },
  });
  const first = await session.submit({ input: 'first' });
  const second = await session.submit({ input: 'second' });
  expect(first.id).not.toBe(second.id);
  expect(session.snapshot.activeTurnIds).toEqual([first.id, second.id]);
  await first.steer({ input: 'guide first' });
  expect(adapter.calls.find(call => call.method === 'turn/steer')?.params).toMatchObject({ expectedTurnId: first.id });
  await first.interrupt(); expect((await first.result()).status).toBe('interrupted');
  expect(session.snapshot.activeTurnIds).toEqual([second.id]);
  await runtime.dispose();
});

test("item IDs reused by different executions remain separate; duplicate native terminals are suppressed", async () => {
  const { runtime, session, sink } = await setup();
  const reader = session.events()[Symbol.asyncIterator]();
  const first = await session.submit({ input: 'a' }), second = await session.submit({ input: 'b' });
  await sink.emit({ type: 'turn/completed', payload: { turnId: first.id, status: 'completed' } });
  const terminals: string[] = [], items: string[] = [];
  while (terminals.length < 2) { const event = (await reader.next()).value!; if(event.type === 'turn/completed') terminals.push(event.payload.turnId); if(event.type === 'item/completed') items.push(`${event.turnId}:${event.payload.item.id}`); }
  expect(terminals).toEqual([first.id, second.id]);
  expect(items).toEqual([`${first.id}:native-reused`, `${second.id}:native-reused`]);
  expect((await first.result()).text).toBe('a'); expect((await second.result()).text).toBe('b');
  await reader.return?.(); await runtime.dispose();
});

test("non-pausable source overflow fails observation without inventing a native terminal", async () => {
  const { runtime, session, sink } = await setup({
    adapterOptions: {
      /** Leave the accepted turn active so overflow must fail observation of live work. */
      async execute(call, events) {
        if (call.method !== 'input/submit') return undefined;
        const { submissionId } = call.params as InputSubmitParams;
        await events.emit({ type: 'turn/started', payload: { turnId: 'active' } });
        return { submissionId, accepted: true, disposition: 'started', turnId: 'active' };
      },
    },
    runtimeOptions: { queue: { maxFrameBytes: 4096 } },
  });
  const turn = await session.submit({ input:'hold' }), reader = session.events()[Symbol.asyncIterator]();
  expect(sink.tryEmit({type:'notice',payload:{severity:'info',code:'FLOOD',message:'x'.repeat(8192)}})).toBe(false);
  await expect(turn.result()).rejects.toMatchObject({code:'BACKPRESSURE_EXCEEDED',details:{source:'sdk'}});
  await expect(reader.next()).rejects.toMatchObject({code:'BACKPRESSURE_EXCEEDED'});
  await reader.return?.(); await runtime.dispose();
});

test("detaching an event reader does not interrupt execution or replay old events", async () => {
  const { runtime, session, adapter } = await setup();
  const reader = session.events()[Symbol.asyncIterator](); await reader.return?.();
  const again = session.events()[Symbol.asyncIterator]();
  const turn = await session.submit({ input:'after detach' }); await nextType(again,'turn/completed');
  expect((await turn.result()).text).toBe('after detach');
  expect(adapter.calls.some(call=>call.method==='turn/interrupt'||call.method==='session/interrupt')).toBe(false);
  await again.return?.(); await runtime.dispose();
});

const approvalInteraction = {
  request: { interactionId: "approval", kind: "approval", options: [{ id: "yes", label: "Allow once" }, { id: "no", label: "Deny" }] },
  response: { kind: "approval", optionId: "yes" },
} satisfies { request: InteractionRequested; response: InteractionResponse };

const interactions: Array<{ request: InteractionRequested; response: InteractionResponse }> = [
  approvalInteraction,
  { request: { interactionId: "input", kind: "userInput", questions: [{ id: "q", prompt: "Answer?", secret: true }] }, response: { kind: "userInput", answers: { q: "sensitive" } } },
  { request: { interactionId: "elicitation", kind: "elicitation", mode: "form", schema: { type: "object", required: ["name"] } }, response: { kind: "elicitation", action: "accept", content: { name: "A" } } },
  { request: { interactionId: "dynamic", kind: "dynamicTool", toolName: "test", arguments: {} }, response: { kind: "dynamicTool", content: [{ type: "text", text: "result" }] } },
];
for (const entry of interactions) test(`interaction ${entry.request.kind} waits for the native response and resolves once`, async () => {
  const { runtime, session, sink } = await setup(); let received: InteractionResponse | null | undefined;
  const answer = sink.requestInteraction(entry.request, async (response) => { received = response; });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  const result = await session.request("interaction/respond", { requestId: "response", sessionId: "s", interactionId: entry.request.interactionId, response: entry.response });
  expect(result.outcome).toBe("responded"); expect(await answer).toEqual(entry.response); expect(received).toEqual(entry.response);
  const event = await nextType(reader, "interaction/resolved"); expect(event.payload).toMatchObject({ outcome: "responded" });
  await expect(session.request("interaction/respond", { requestId: "other", sessionId: "s", interactionId: entry.request.interactionId, response: entry.response })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  await reader.return?.(); await runtime.dispose();
});

test("invalid interaction answers keep pending; racing valid replies invoke native once", async () => {
  const { runtime, session, sink } = await setup();
  const responseGate = Promise.withResolvers<void>();
  let calls = 0;
  const pending = sink.requestInteraction(approvalInteraction.request, async () => {
    calls++;
    await responseGate.promise;
  });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await expect(session.request("interaction/respond", { requestId: "invalid", sessionId: "s", interactionId: approvalInteraction.request.interactionId, response: { kind: "approval", optionId: "invented" } })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  const first = session.request("interaction/respond", { requestId: "first", sessionId: "s", interactionId: approvalInteraction.request.interactionId, response: approvalInteraction.response });
  await expect(session.request("interaction/respond", { requestId: "second", sessionId: "s", interactionId: approvalInteraction.request.interactionId, response: { kind: "approval", optionId: "no" } })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  expect(calls).toBe(1); responseGate.resolve(); await first; await pending; await reader.return?.(); await runtime.dispose();
});

test("timeout cancels a pending native interaction rather than approving it", async () => {
  const { runtime, session, sink } = await setup({ runtimeOptions: { interactionTimeoutMs: 15 } }); let response: InteractionResponse | null | undefined;
  const pending = sink.requestInteraction(approvalInteraction.request, async (value) => { response = value; });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await expect(pending).rejects.toMatchObject({ code: "INTERACTION_CANCELLED" });
  expect(response).toBe(null); expect((await nextType(reader, "interaction/resolved")).payload).toMatchObject({ outcome: "expired" });
  await reader.return?.(); await runtime.dispose();
});

test("native response loss is unknown and not automatically retried", async () => {
  const { runtime, session, sink } = await setup(); let calls = 0;
  const pending = sink.requestInteraction(approvalInteraction.request, async () => { calls++; throw new HarnessSdkError("RESULT_UNKNOWN", "private", false, true); });
  void pending.catch(() => {});
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  const params = { requestId: "response", sessionId: "s", interactionId: approvalInteraction.request.interactionId, response: approvalInteraction.response };
  await expect(session.request("interaction/respond", params)).rejects.toMatchObject({ outcomeUnknown: true }); await expect(pending).rejects.toMatchObject({ outcomeUnknown: true });
  expect((await nextType(reader, "interaction/resolved")).payload).toMatchObject({ outcome: "unknown" });
  await expect(session.request("interaction/respond", params)).rejects.toMatchObject({ outcomeUnknown: true }); expect(calls).toBe(1);
  await reader.return?.(); await runtime.dispose();
});

test("raw request IDs dedupe dispatched inputs and reject changed payload", async () => {
  const {runtime,session,adapter}=await setup();
  const params={requestId:'same',sessionId:'s',submissionId:'input',delivery:'native' as const,input:[{type:'text' as const,text:'one'}]};
  await session.request('input/submit',params);await session.request('input/submit',params);
  await expect(session.request('input/submit',{...params,input:[{type:'text',text:'changed'}]})).rejects.toMatchObject({code:'REQUEST_ID_CONFLICT'});
  expect(adapter.calls).toHaveLength(1);await runtime.dispose();
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
  await expect(disposal).rejects.toMatchObject({ code: "RESOURCE_RELEASE_FAILED", details: { errors: [{ code: "PROCESS_DISPOSE_FAILED", outcomeUnknown: true }] } });
  await expect(runtime.dispose()).rejects.toMatchObject({ code: "RESOURCE_RELEASE_FAILED", details: { errors: [{ code: "PROCESS_DISPOSE_FAILED", outcomeUnknown: true }] } });
  expect(attempts).toBe(1);
  expect(adapter.backends.get("other")?.disposeCount).toBe(1);
  expect(adapter.disposeCount).toBe(1);
});

test("remote resolved events retire the registry without submitting another native response", async () => {
  const { runtime, session, sink } = await setup({ runtimeOptions: { interactionTimeoutMs: 20 } }); let calls = 0;
  const pending = sink.requestInteraction(approvalInteraction.request, async () => { calls++; }); void pending.catch(() => {});
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await sink.resolveInteraction({ interactionId: approvalInteraction.request.interactionId, outcome: "expired" });
  await sink.resolveInteraction({ interactionId: approvalInteraction.request.interactionId, outcome: "expired" });
  await expect(pending).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  expect((await nextType(reader, "interaction/resolved")).payload).toMatchObject({ outcome: "expired" });
  await expect(session.request("interaction/respond", { requestId: "late", sessionId: "s", interactionId: approvalInteraction.request.interactionId, response: approvalInteraction.response })).rejects.toMatchObject({ code: "INTERACTION_ALREADY_RESOLVED" });
  await new Promise((resolve) => setTimeout(resolve, 25)); expect(calls).toBe(0);
  await reader.return?.(); await runtime.dispose();
});

test("open configuration and model survive the initial authority snapshot", async () => {
  const adapter = createScriptedAdapter(); const runtime = await createClient({ adapter, identity: OPEN.binding });
  const session = await runtime.openSession({ ...OPEN, config: { effort: "high" }, model: "configured-model" });
  const reader = session.events()[Symbol.asyncIterator](); const state = session.snapshot;
  expect(state).toMatchObject({ config: { effort: "high" }, model: "configured-model" });
  await reader.return?.(); await session.close(); await runtime.dispose(); expect(adapter.backends.get("s")?.disposeCount).toBe(1);
});

test("a revert result updates the recoverable native reference without changing fixed session identity", async () => {
  const { runtime, session, sink } = await setup({
    adapterOptions: {
      /** Return a replacement native reference so the test can compare receipt and event updates. */
      async execute(call) {
        if (call.method !== "session/revert") return undefined;
        return { appliedScope: "conversation", boundary: { turnId: "old", relation: "before" }, nativeRef: { provider: "scripted", value: "native:reverted" } };
      },
    },
  });
  await session.request("session/revert", { requestId: "revert", sessionId: "s", scope: "conversation", boundary: { turnId: "old", relation: "before" } });
  expect(session.binding).toEqual({ ...OPEN.binding, nativeRef: { provider: "scripted", value: "native:reverted" } });
  expect(Object.isFrozen(session.binding.nativeRef)).toBe(true);
  await sink.emit({ type: "session/state", payload: { binding: { ...session.binding, nativeRef: { provider: "scripted", value: "native:authoritative" } }, capabilities: structuredClone(session.capabilities), config: {}, status: "ready", activeTurnIds: [], capabilityRevision: 1 } });
  expect(session.binding.nativeRef).toEqual({ provider: "scripted", value: "native:authoritative" });
  await runtime.dispose();
});

test("a backend failing during open cannot be returned as a successfully opened session", async () => {
  const adapter = createScriptedAdapter({ onOpen: async (_, sink) => { await sink.fail(new HarnessSdkError("HARNESS_UNAVAILABLE")); } });
  const runtime = await createClient({ adapter, identity: OPEN.binding });
  await expect(runtime.openSession(OPEN)).rejects.toMatchObject({ code: "HARNESS_UNAVAILABLE" });
  expect(adapter.backends.get("s")?.disposeCount).toBe(1); await runtime.dispose();
});

test("an omitted client interaction capability fails closed at the SDK boundary", async () => {
  const adapter = createScriptedAdapter(); const runtime = await createClient({ adapter, identity: OPEN.binding });
  await runtime.openSession(OPEN); let response: InteractionResponse | null | undefined;
  await expect(adapter.sinks.get("s")!.requestInteraction(approvalInteraction.request, async (value) => { response = value; })).rejects.toMatchObject({ code: "INTERACTION_UNSUPPORTED" });
  expect(response).toBeNull(); await runtime.dispose();
});

test("marked secret answers are redacted from native echoes, split deltas and history, but reach the native responder intact", async () => {
  const secret = "PRIVATE_ANSWER_123"; const nativeAnswers: Array<InteractionResponse | null> = [];
  const { runtime, session, sink } = await setup();
  const pending = sink.requestInteraction({ kind: "userInput", interactionId: "secret", questions: [{ id: "password", prompt: "Secret", secret: true }] }, async (answer) => { nativeAnswers.push(answer); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await session.request("interaction/respond", { requestId: "respond", sessionId: "s", interactionId: "secret", response: { kind: "userInput", answers: { password: secret } } }); await pending;
  expect(nativeAnswers).toEqual([{ kind: "userInput", answers: { password: secret } }]);
  await session.submit({ input: [{ type: "text", text: `echo ${secret}` }] });
  const events = await readThroughTurnCompletion(reader);
  expect(JSON.stringify(events)).not.toContain(secret); expect(JSON.stringify(await session.request("history/read", { requestId: "history", sessionId: "s" }))).not.toContain(secret);
  await sink.emit({ type: "turn/started", payload: { turnId: "split" } });
  await sink.emit({ type: "item/started", payload: { item: { id: "split-text", type: "agentMessage", text: "" } } }, { turnId: "split" });
  for (const part of ["PRIVATE_", "ANSWER_", "123"]) await sink.emit({ type: "item/delta", payload: { itemId: "split-text", kind: "text", text: part } }, { turnId: "split" });
  await sink.emit({ type: "item/completed", payload: { item: { id: "split-text", type: "agentMessage", text: secret } } }, { turnId: "split" });
  await sink.emit({ type: "turn/completed", payload: { turnId: "split", status: "completed" } });
  const split = await readThroughTurnCompletion(reader);
  expect(split.filter((event) => event.type === "item/delta").map((event) => event.payload.text).join("")).toBe("[redacted]");
  expect(JSON.stringify(split)).not.toContain(secret); await reader.return?.(); await runtime.dispose();
});

test("elicitation writeOnly values are marked before a synchronous native echo", async () => {
  const { runtime, session, sink } = await setup(); const secret = "WRITE_ONLY_SECRET";
  const pending = sink.requestInteraction({ kind: "elicitation", interactionId: "form", mode: "form", schema: { type: "object", properties: { credential: { type: "string", writeOnly: true } }, required: ["credential"] } }, async () => { await sink.emit({ type: "notice", payload: { severity: "info", code: "ECHO", message: secret, raw: { generic: secret } } }); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await session.request("interaction/respond", { requestId: "response", sessionId: "s", interactionId: "form", response: { kind: "elicitation", action: "accept", content: { credential: secret } } }); await pending;
  const echo = await nextType(reader, "notice"); expect(echo.payload).toMatchObject({ message: "[redacted]", raw: { generic: "[redacted]" } });
  await reader.return?.(); await runtime.dispose();
});

test("accepted compaction does not impose a universal Core busy scheduler", async () => {
  const { runtime, session, sink, adapter } = await setup({
    adapterOptions: {
      async execute(call) {
        if (call.method === 'compact/start') return { maintenanceId: 'async', status: 'accepted' };
      },
    },
  });
  expect(await session.request('compact/start', { requestId: 'compact', sessionId: 's' })).toMatchObject({ status: 'accepted' });
  await sink.emit({ type: 'session/metadata', payload: { title: 'Maintenance' } });
  const turn = await session.submit({ input: 'native admission' });
  expect((await turn.result()).status).toBe('completed');
  expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1);
  await runtime.dispose();
});

test("an in-flight fork does not add a universal Core mutation lock", async () => {
  const forkEntered = Promise.withResolvers<void>();
  const allowForkToFinish = Promise.withResolvers<void>();
  const { runtime, session } = await setup({
    adapterOptions: {
      /** Hold native fork acquisition until the source session has accepted another submission. */
      async onOpen(params) {
        if (params.mode === 'fork') {
          forkEntered.resolve();
          await allowForkToFinish.promise;
        }
      },
    },
  });
  const original = await session.submit({ input: 'boundary' });
  await original.result();
  const branch = runtime.sessions.fork(session.reference, { boundary: { turnId: original.id, relation: 'through' } });

  await forkEntered.promise;
  const during = await session.submit({ input: 'during fork' });
  expect((await during.result()).status).toBe('completed');

  allowForkToFinish.resolve();
  await branch;
  await runtime.dispose();
});

test("a compact completion snapshot before acknowledgement cannot leave the session stuck busy", async () => {
  const { runtime, session } = await setup({
    adapterOptions: {
      /** Publish the ready state before resolving the compaction admission receipt. */
      async execute(call, sink) {
        if (call.method !== "compact/start") return undefined;
        await sink.emit({
          type: "session/state",
          payload: {
            binding: structuredClone(session.binding),
            capabilities: structuredClone(session.capabilities),
            config: {},
            capabilityRevision: 1,
            activeTurnIds: [],
            status: "ready",
          },
        });
        return { maintenanceId: "fast", status: "accepted" };
      },
    },
  });
  expect(await session.request("compact/start", { requestId: "compact", sessionId: "s" })).toMatchObject({ status: "accepted" });
  await session.submit({ input: [{ type: "text", text: "go" }] });
  await runtime.dispose();
});

test("privacy metadata ports run before native submission and project restored authoritative history", async () => {
  const remembered: Array<{ sessionId: string; value: string }> = []; let nativeSeen = false;
  const { runtime, session, sink } = await setup({
    runtimeOptions: {
      onMarkedSecret: (binding, value) => { remembered.push({ sessionId: binding.sessionId, value }); },
      redactHistory: (_binding, page) => ({
        ...page,
        items: page.items.map(entry => entry.item.type === "agentMessage"
          ? { ...entry, item: { ...entry.item, text: "host-persistent-projection" } }
          : { ...entry }),
      }),
    },
  });
  const pending = sink.requestInteraction({ interactionId: "private", kind: "userInput", questions: [{ id: "q", prompt: "Secret", secret: true }] }, async () => { nativeSeen = true; expect(remembered).toEqual([{ sessionId: "s", value: "secret-port-value" }]); });
  const reader = session.events()[Symbol.asyncIterator](); await nextType(reader, "interaction/requested");
  await session.request("interaction/respond", { requestId: "answer", sessionId: "s", interactionId: "private", response: { kind: "userInput", answers: { q: "secret-port-value" } } }); await pending; expect(nativeSeen).toBe(true);
  await session.submit({ input: [{ type: "text", text: "original" }] });
  expect((await session.request("history/read", { requestId: "history", sessionId: "s" })).items[0]?.item).toMatchObject({ text: "host-persistent-projection" });
  await reader.return?.(); await runtime.dispose();
});

test("successful configuration, goal results and state displays redact marked content while preserving protocol identity", async () => {
  const secret = "SUCCESS_RESULT_PRIVATE";
  // Deliberately mark values matching protocol enums, identifiers and version numbers to verify redaction follows field semantics.
  const secretAnswersIncludingProtocolValues = { content: secret, status: "ready", scope: "session", schemaType: "string", identifier: "model", revision: 1 };
  const capabilities = { ...structuredClone(FAKE_CAPABILITIES), config: { options: [{ id: "model", scope: "session" as const, title: secret, value: secret, schema: { type: "string", title: secret, description: secret, default: secret, examples: [secret], enum: ["model", "string"], $defs: { choice: { type: "string", description: secret } }, properties: { title: { type: "string", description: secret } } } }] } };
  const activeGoal: GoalState = { goal: { text: secret, numericAnswer: 1 }, status: "active" };
  const clearedGoal: GoalState = { goal: { echo: secret }, status: "cleared" };
  const { runtime, session, sink } = await setup({
    adapterOptions: {
      capabilities,
      /** Supply retained native results so the test can compare their SDK projections. */
      async execute(call) {
        if (call.method === "session/config/set") return nativeState;
        if (call.method === "goal/set") return activeGoal;
        if (call.method === "goal/clear") return clearedGoal;
        return undefined;
      },
    },
  });
  const nativeState: SessionState = {
    binding: structuredClone(session.binding),
    status: "ready",
    activeTurnIds: [],
    config: { model: secret, numericAnswer: 1 },
    model: "model",
    capabilityRevision: 1,
    capabilities,
    goal: { goal: { text: secret }, status: "active" },
  };
  const reader = session.events()[Symbol.asyncIterator]();
  const pending = sink.requestInteraction({ interactionId: "result-secret", kind: "userInput", questions: Object.keys(secretAnswersIncludingProtocolValues).map((id) => ({ id, prompt: id, secret: true })) }, async () => {});
  await nextType(reader, "interaction/requested");
  await session.request("interaction/respond", { requestId: "mark", sessionId: "s", interactionId: "result-secret", response: { kind: "userInput", answers: secretAnswersIncludingProtocolValues } }); await pending;
  const configured = await session.request("session/config/set", { requestId: "configure", sessionId: "s", patch: { model: "model" } });
  expect(configured).toMatchObject({ binding: { sessionId: "s", adapterId: "fake", runtimeConfigId: "r" }, status: "ready", activeTurnIds: [], capabilityRevision: 1, model: "model", config: { model: "[redacted]", numericAnswer: "[redacted]" }, goal: { goal: { text: "[redacted]" }, status: "active" } });
  expect(configured.capabilities.config!.options[0]).toEqual({ ...capabilities.config.options[0], title: "[redacted]", value: "[redacted]", schema: { type: "string", title: "[redacted]", description: "[redacted]", default: "[redacted]", examples: ["[redacted]"], enum: ["model", "string"], $defs: { choice: { type: "string", description: "[redacted]" } }, properties: { title: { type: "string", description: "[redacted]" } } } });
  expect(await session.request("goal/set", { requestId: "goal", sessionId: "s", goal: { text: "ordinary" } })).toEqual({ goal: { text: "[redacted]", numericAnswer: "[redacted]" }, status: "active" });
  expect(await session.request("goal/clear", { requestId: "clear", sessionId: "s" })).toEqual({ goal: { echo: "[redacted]" }, status: "cleared" });
  await sink.emit({ type: "session/state", payload: nativeState });
  const event = await nextType(reader, "session/state"); expect(event.payload).toEqual(configured);
  expect(JSON.stringify(configured)).not.toContain(secret); expect(JSON.stringify(event)).not.toContain(secret);
  expect(nativeState.config.model).toBe(secret);
  await reader.return?.(); await runtime.dispose();
});
