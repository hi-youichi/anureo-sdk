import { randomUUID } from 'node:crypto';
import {
  type BackendSession, type HarnessAdapter, type SessionEventSink, type SessionMethod,
} from "@anureo/sdk";
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, type Capabilities, type AhpRequestMap, type AhpResultMap,
  type HistoryItem, type InitializeParams, type InitializeResult, type SessionBinding,
  type SessionOpenParams, type SessionState, type InputSubmitParams, type AhpEventPayload,
} from "@anureo/protocol";
import { HarnessSdkError } from "@anureo/sdk";
import type { ConformanceFactory, ConformanceScenario } from "./suite";

export interface FakeCall { method: SessionMethod; params: AhpRequestMap[SessionMethod] }
export interface FakeAdapterOptions {
  capabilities?: Capabilities;
  /** Hook can publish events, pause a response, or throw exactly at a chosen dispatch point. */
  execute?: (call: FakeCall, sink: SessionEventSink) => Promise<AhpResultMap[SessionMethod] | undefined>;
  onOpen?: (params: SessionOpenParams, sink: SessionEventSink) => Promise<void>;
}
export const FAKE_CAPABILITIES: Capabilities = {
  session: { resume: true, fork: ["before", "through"], revert: ["conversation", "files", "both"], history: true },
  input: { delivery: ['native','afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn','session'], reportsPendingInputs: true } },
  turn: { outputSchema: true, inputModalities: ["text", "image", "file"], overrides: ["model"] },
  goal: { actions: ["set", "clear"] }, compact: true, review: true,
  interactions: ["approval", "userInput", "elicitation", "dynamicTool"],
  config: { options: [{ id: "model", scope: "session", schema: { type: "string" } }] },
};

/** In-memory official-API-shaped fake. It is test-only and never registered in the production Host. */
export class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly calls: FakeCall[] = [];
  readonly opened: SessionOpenParams[] = [];
  readonly sinks = new Map<string, SessionEventSink>();
  readonly backends = new Map<string, ScriptedBackendSession>();
  disposeCount = 0;
  constructor(readonly options: FakeAdapterOptions = {}) {}
  get capabilities(): Capabilities { return structuredClone(this.options.capabilities ?? FAKE_CAPABILITIES); }
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest("initialize",params);
    negotiateVersion(params.protocolVersions);
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: "scripted", version: "1.0.0", adapter: "conformance/0.1.0" }, capabilities: this.capabilities };
  }
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    this.opened.push(structuredClone(params)); this.sinks.set(params.binding.sessionId, sink);
    const backend = new ScriptedBackendSession(this, params, sink); this.backends.set(params.binding.sessionId, backend);
    if (params.mode === "fork" && params.fork) {
      const source = this.backends.get(params.fork.sourceSessionId);
      if (!source) throw new HarnessSdkError("SESSION_NOT_FOUND");
      const boundaryIndex = source.history.findIndex((entry) => entry.turnId === params.fork!.boundary.turnId);
      if (boundaryIndex < 0) throw new HarnessSdkError("TURN_NOT_FOUND");
      const retained = params.fork.boundary.relation === "before" ? boundaryIndex : boundaryIndex + 1;
      backend.history.push(...structuredClone(source.history.slice(0, retained)));
    }
    await this.options.onOpen?.(params, sink); return backend;
  }
  async dispose(): Promise<void> { this.disposeCount++; }
}
export class ScriptedBackendSession implements BackendSession {
  readonly binding: SessionBinding;
  readonly capabilities: Capabilities;
  readonly history: HistoryItem[] = [];
  disposeCount = 0;
  state: SessionState;
  constructor(private readonly adapter: ScriptedHarnessAdapter, params: SessionOpenParams, readonly sink: SessionEventSink) {
    this.binding = { ...params.binding, nativeRef: { provider: "scripted", value: `native:${params.binding.sessionId}` } };
    this.capabilities = adapter.capabilities;
    this.state = { binding: this.binding, capabilities: this.capabilities, status: "ready", activeTurnIds: [], config: params.config ?? {}, ...(params.model ? { model: params.model } : {}), capabilityRevision: 1 };
  }
  async emit(payload: AhpEventPayload, turnId?: string): Promise<void> { await this.sink.emit(payload, { turnId }); }
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    const call: FakeCall = { method, params }; this.adapter.calls.push(call);
    const custom = await this.adapter.options.execute?.(call, this.sink);
    if (custom !== undefined) return custom as AhpResultMap[M];
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case "input/submit": {
        const start = params as InputSubmitParams;
        const turnId = randomUUID();
        await this.emit({ type: "turn/started", payload: { turnId: turnId } });
        const item = { id: "native-reused", type: "agentMessage" as const, text: start.input.filter((part) => part.type === "text").map((part) => part.text).join("\n"), phase: "final" as const };
        await this.emit({ type: "item/started", payload: { item: { ...item, text: "" } } }, turnId);
        await this.emit({ type: "item/delta", payload: { itemId: item.id, kind: "text", text: "preview " } }, turnId);
        await this.emit({ type: "item/completed", payload: { item } }, turnId);
        this.history.push({ turnId: turnId, item });
        await this.emit({ type: "turn/completed", payload: { turnId: turnId, status: "completed" } });
        result = { submissionId: start.submissionId, turnId, accepted: true, disposition: "started" }; break;
      }
      case "turn/steer":
        await this.emit({ type: "turn/completed", payload: { turnId: (params as AhpRequestMap["turn/steer"]).expectedTurnId, status: "completed" } });
        result = { submissionId: (params as AhpRequestMap["turn/steer"]).submissionId, turnId: (params as AhpRequestMap["turn/steer"]).expectedTurnId, accepted: true }; break;
      case "turn/interrupt": {
        const id = (params as AhpRequestMap["turn/interrupt"]).turnId;
        await this.emit({ type: "turn/completed", payload: { turnId: id, status: "interrupted" } }); result = { accepted: true, turnId: id }; break;
      }
      case "session/config/set": this.state = { ...this.state, config: { ...this.state.config, ...(params as AhpRequestMap["session/config/set"]).patch }, capabilityRevision: this.state.capabilityRevision + 1 }; result = this.state; break;
      case "session/revert": {
        const request = params as AhpRequestMap["session/revert"];
        if (request.scope !== "files") {
          const index = this.history.findIndex((entry) => entry.turnId === request.boundary.turnId);
          if (index < 0) throw new HarnessSdkError("TURN_NOT_FOUND");
          this.history.splice(request.boundary.relation === "before" ? index : index + 1);
        }
        result = { appliedScope: request.scope, boundary: request.boundary }; break;
      }
      case "history/read": result = { items: this.history, snapshotToken: "fake-snapshot", source: this.binding.nativeRef }; break;
      case "goal/set": result = { goal: (params as AhpRequestMap["goal/set"]).goal, status: "active" }; break;
      case "goal/clear": result = { goal: null, status: "cleared" }; break;
      case "compact/start": result = { maintenanceId: "fake-maintenance", status: "completed" }; break;
      case "review/start": {
        const id = randomUUID();
        await this.emit({ type: "turn/started", payload: { turnId: id } });
        await this.emit({ type: "turn/completed", payload: { turnId: id, status: "completed" } }); result = { submissionId: (params as AhpRequestMap["review/start"]).submissionId, accepted: true, disposition: "started", turnId: id }; break;
      }
      case "session/interrupt": result = { accepted: true, stillQueued: [] }; break;
      case "session/close": result = { closed: true, observationClosed: true, executionStopped: "unconfirmed" }; break;
      case "interaction/respond": case "interaction/cancel": throw new Error("Interactions must be handled by the SDK registry");
    }
    return result as AhpResultMap[M];
  }
  async dispose(): Promise<void> { this.disposeCount++; }
}
export function createScriptedAdapter(options?: FakeAdapterOptions): ScriptedHarnessAdapter { return new ScriptedHarnessAdapter(options); }

/** Reusable deterministic fixtures for the public runner, including deliberate source faults. */
export function createScriptedConformanceFactory(capabilities?: Capabilities): ConformanceFactory {
  return (scenario: ConformanceScenario) => {
    const adapter = createScriptedAdapter({ capabilities, execute: async (call, sink) => {
      if (call.method !== "input/submit") return undefined;
      const { submissionId } = call.params as InputSubmitParams; const turnId = randomUUID();
      if (["interrupt", "steer", "disconnect", "backpressure"].includes(scenario)) {
        await sink.emit({ type: "turn/started", payload: { turnId } });

        return { submissionId, accepted: true, disposition: "started", turnId };
      }
      const interaction: Record<string, Parameters<SessionEventSink["requestInteraction"]>[0]> = {
        approval: { interactionId: "conformance-approval", kind: "approval", turnId, options: [{ id: "deny", label: "Deny", semantic: "deny" }] },
        userInput: { interactionId: "conformance-input", kind: "userInput", turnId, questions: [{ id: "q", prompt: "Value" }] },
        elicitation: { interactionId: "conformance-elicitation", kind: "elicitation", turnId, mode: "form" },
        dynamicTool: { interactionId: "conformance-tool", kind: "dynamicTool", turnId, toolName: "conformance", arguments: {} },
      };
      if (interaction[scenario] || scenario === "unknown-item") {
        await sink.emit({ type: "turn/started", payload: { turnId } });
        if (interaction[scenario]) await sink.requestInteraction(interaction[scenario], async () => {});
        else await sink.emit({ type: "item/completed", payload: { item: { id: "unknown", type: "toolCall", kind: "other", title: "Unknown", nativeType: "futureNativeType", raw: { safe: "value" } } } }, { turnId });
        await sink.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
        return { submissionId, accepted: true, disposition: "started", turnId };
      }
      return undefined;
    } });
    return {
      adapter,
      openParams: { requestId: "conformance-open", mode: "new", binding: { sessionId: "conformance-session", adapterId: "scripted", runtimeConfigId: "conformance-runtime" }, cwd: "/tmp" },
      ...(scenario === "backpressure" ? { afterStart: async () => { adapter.sinks.get("conformance-session")!.tryEmit({ type: "notice", payload: { severity: "info", code: "FLOOD", message: "x".repeat(8192) } }); }, runtimeOptions: { queue: { maxFrameBytes: 4096 } } } : {}),
      ...(scenario === "disconnect" ? { afterStart: async () => { await adapter.sinks.get("conformance-session")!.fail(new HarnessSdkError("CONNECTION_CLOSED", "Conformance disconnection", false, true)); } } : {}),
    };
  };
}
