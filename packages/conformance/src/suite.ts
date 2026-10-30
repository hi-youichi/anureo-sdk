import { createHarnessRuntime, type HarnessAdapter, type HarnessRuntime, type HarnessSession, type RuntimeOptions } from "@anureo/sdk";
import { supportsCapability, type Capabilities, type AhpEvent, type InteractionRequested, type InteractionResponse, type SessionOpenParams } from "@anureo/protocol";

export const CONFORMANCE_SCENARIOS = ["lifecycle", "immediate", "identity", "approval", "userInput", "elicitation", "dynamicTool", "interrupt", "steer", "fork", "revert", "history", "unknown-item", "disconnect", "backpressure"] as const;
export type ConformanceScenario = typeof CONFORMANCE_SCENARIOS[number];
export interface ConformanceDriver {
  adapter: HarnessAdapter;
  openParams: SessionOpenParams;
  runtimeOptions?: RuntimeOptions;
  /** Deterministic fake-source trigger, called after a turn has been accepted. */
  afterStart?: (session: HarnessSession) => Promise<void>;
  expectedText?: string;
  answer?: (request: InteractionRequested) => InteractionResponse;
}
export type ConformanceFactory = (scenario: ConformanceScenario) => Promise<ConformanceDriver> | ConformanceDriver;
export interface ConformanceCaseResult { scenario: ConformanceScenario; status: "passed" | "failed" | "not-applicable"; message?: string }
export interface ConformanceReport { passed: boolean; cases: ConformanceCaseResult[] }
function requireCondition(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Conformance timed out")), timeoutMs); promise.then((result) => { clearTimeout(timer); resolve(result); }, (cause) => { clearTimeout(timer); reject(cause); }); });
}
function applicable(scenario: ConformanceScenario, capabilities: Capabilities): boolean {
  if (["approval", "userInput", "elicitation", "dynamicTool"].includes(scenario)) return capabilities.interactions?.includes(scenario as InteractionRequested["kind"]) ?? false;
  if (scenario === "interrupt" || scenario === "steer") return supportsCapability(capabilities, `turn.${scenario}`);
  if (scenario === "fork") return !!capabilities.session?.fork?.length;
  if (scenario === "revert") return !!capabilities.session?.revert?.length;
  if (scenario === "history") return !!capabilities.session?.history;
  return true;
}
function defaultAnswer(request: InteractionRequested): InteractionResponse {
  switch (request.kind) {
    case "approval": return { kind: "approval", optionId: request.options[0]!.id };
    case "userInput": return { kind: "userInput", answers: Object.fromEntries(request.questions.map((question) => [question.id, question.options?.[0]?.id ?? "conformance"])) };
    case "elicitation": return { kind: "elicitation", action: "decline" };
    case "dynamicTool": return { kind: "dynamicTool", content: [{ type: "text", text: "conformance" }] };
  }
}

/** Every declared optional capability must pass its scenario; missing fixtures are failures. */
export async function runConformance(factory: ConformanceFactory, options: { timeoutMs?: number; scenarios?: readonly ConformanceScenario[] } = {}): Promise<ConformanceReport> {
  const cases: ConformanceCaseResult[] = [];
  for (const scenario of options.scenarios ?? CONFORMANCE_SCENARIOS) {
    let runtime: HarnessRuntime | undefined;
    let reader: AsyncIterator<AhpEvent> | undefined;
    try {
      const fixture = await factory(scenario);
      runtime = createHarnessRuntime(fixture.adapter, fixture.runtimeOptions);
      const initialized = await runtime.initialize({ protocolVersions: [1], clientInfo: { name: "harness-conformance", version: "0.1.0" }, clientCapabilities: { interactions: ["approval", "userInput", "elicitation", "dynamicTool"] } });
      if (!applicable(scenario, initialized.capabilities)) { cases.push({ scenario, status: "not-applicable" }); continue; }
      const session = await runtime.openSession(fixture.openParams); const sessionId = session.binding.sessionId;
      reader = session.events()[Symbol.asyncIterator]();
      const events: AhpEvent[] = [];
      let interactionSeen = false;
      const collect = async (turnId: string) => {
        for (let count = 0; count < 10_000; count++) {
          const entry = await reader!.next(); requireCondition(!entry.done, "Source ended before a terminal event");
          const event = entry.value; events.push(event);
          if (event.type === "interaction/requested") {
            interactionSeen = true;
            await session.respond({ requestId: `respond:${event.payload.interactionId}`, sessionId, interactionId: event.payload.interactionId, response: (fixture.answer ?? defaultAnswer)(event.payload) });
          }
          if (event.type === "turn/completed" && event.payload.turnId === turnId) return event;
        }
        throw new Error("Too many events without completion");
      };
      const run = async (turnId: string) => {
        const request = session.startTurn({ requestId: `start:${turnId}`, sessionId, turnId, input: [{ type: "text", text: "conformance" }] });
        // Observe rejection immediately even when the producer fails before collection has begun.
        void request.catch(() => {});
        if (scenario === "backpressure") { await request; await fixture.afterStart?.(session); }
        else if (scenario === "interrupt" || scenario === "steer" || scenario === "disconnect") {
          await request;
          if (scenario === "steer") await session.steer({ requestId: "steer", sessionId, expectedTurnId: turnId, input: [{ type: "text", text: "redirect" }] });
          if (scenario !== "disconnect") await session.interrupt({ requestId: "interrupt", sessionId, turnId });
          await fixture.afterStart?.(session);
        }
        const terminal = await collect(turnId); await request; return terminal;
      };
      const terminal = await deadline(run("conformance-turn-1"), options.timeoutMs ?? 3000);
      requireCondition(events.filter((event) => event.type === "turn/started").length === 1, "Turn must start once");
      requireCondition(events.filter((event) => event.type === "turn/completed").length === 1, "Turn must end once");
      requireCondition(events.every((event, index) => event.seq === index + 1 && event.sessionId === sessionId && event.streamId === events[0]!.streamId), "Source identity/sequence must be contiguous");
      if (["approval", "userInput", "elicitation", "dynamicTool"].includes(scenario)) requireCondition(interactionSeen && events.some((event) => event.type === "interaction/resolved"), "Declared interaction was not exercised");
      if (scenario === "disconnect" || scenario === "backpressure") requireCondition(terminal.payload.status === "failed", "Lost/overflowed source must fail explicitly");
      else if (scenario === "interrupt" || scenario === "steer") requireCondition(terminal.payload.status === "interrupted", "Interrupt must produce interrupted status");
      else requireCondition(terminal.payload.status === "completed", "Unexpected failed turn");
      if (scenario === "lifecycle" || scenario === "immediate") requireCondition(events.some((event) => event.type === "item/completed" && event.payload.item.type === "agentMessage" && event.payload.item.text === (fixture.expectedText ?? "conformance")), "Missing authoritative completed text");
      if (scenario === "unknown-item") requireCondition(events.some((event) => event.type === "item/completed" && event.payload.item.type === "toolCall" && event.payload.item.kind === "other" && !!event.payload.item.nativeType), "Unknown native item was discarded");
      if (scenario === "identity") { await deadline(run("conformance-turn-2"), options.timeoutMs ?? 3000); const items = events.filter((event) => event.type === "item/completed"); requireCondition(items.some((event) => event.turnId === "conformance-turn-1") && items.some((event) => event.turnId === "conformance-turn-2"), "Turn-scoped item identities were lost"); }
      if (scenario === "history") { const history = await session.readHistory({ requestId: "history", sessionId }); requireCondition(history.items.length > 0 && history.items.every((entry) => !!entry.turnId && !!entry.item.id), "Declared history did not return the completed turn"); }
      if (scenario === "fork") {
        for (const relation of initialized.capabilities.session!.fork!) {
          const fork = await runtime.openSession({ ...fixture.openParams, requestId: `fork:${relation}`, mode: "fork", binding: { ...session.binding, sessionId: `${sessionId}:fork:${relation}` }, fork: { sourceSessionId: sessionId, nativeRef: session.binding.nativeRef, boundary: { turnId: "conformance-turn-1", relation } } });
          requireCondition(fork.binding.sessionId !== sessionId && fork.binding.adapterId === session.binding.adapterId, "Fork must create an independent same-adapter session");
          if (initialized.capabilities.session?.history) {
            const history = await fork.readHistory({ requestId: "fork-history", sessionId: fork.binding.sessionId });
            requireCondition(relation === "before" ? !history.items.some((entry) => entry.turnId === "conformance-turn-1") : history.items.some((entry) => entry.turnId === "conformance-turn-1"), "Fork boundary was not preserved");
          }
          await fork.close();
        }
      }
      if (scenario === "revert") {
        const scope = initialized.capabilities.session!.revert![0]!;
        const result = await session.revert({ requestId: "revert", sessionId, scope, boundary: { turnId: "conformance-turn-1", relation: "before" } });
        requireCondition(result.appliedScope === scope && result.boundary.turnId === "conformance-turn-1", "Revert did not report the actual requested scope/boundary");
        if (scope !== "files" && initialized.capabilities.session?.history) { const history = await session.readHistory({ requestId: "reverted-history", sessionId }); requireCondition(!history.items.some((entry) => entry.turnId === "conformance-turn-1"), "Conversation boundary was not reverted"); }
      }
      cases.push({ scenario, status: "passed" });
    } catch (cause) { cases.push({ scenario, status: "failed", message: cause instanceof Error ? cause.message : "Conformance failure" }); }
    finally { await reader?.return?.(); await runtime?.dispose().catch(() => {}); }
  }
  return { passed: cases.every((entry) => entry.status !== "failed"), cases };
}
