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
import type { ConformanceDriver, ConformanceFactory, ConformanceScenario } from "./suite";

/** One backend dispatch recorded before any custom hook runs; params is the dispatched object, not a clone. */
export interface FakeCall { method: SessionMethod; params: AhpRequestMap[SessionMethod] }
/** Configure an injectable in-memory backend for SDK, workflow and application fixtures. */
export interface FakeAdapterOptions {
  /** Replaces the complete default capability set; each capabilities read returns a detached clone. */
  capabilities?: Capabilities;
  /**
   * Hook can publish events, pause a response, or throw at a chosen dispatch point.
   * Return undefined to continue with the default implementation. Returning a result
   * bypasses the default implementation; the hook is responsible for all required
   * events and side effects for that call. Thrown errors propagate to the caller.
   */
  execute?: (call: FakeCall, sink: SessionEventSink) => Promise<AhpResultMap[SessionMethod] | undefined>;
  /** Awaited after recording/creating the backend and copying fork history; may emit setup events or reject open. */
  onOpen?: (params: SessionOpenParams, sink: SessionEventSink) => Promise<void>;
}
/** Default advertised abilities for scripted fixtures; this is a mutable template cloned by adapter reads. */
export const FAKE_CAPABILITIES: Capabilities = {
  session: { resume: true, fork: ["before", "through"], revert: ["conversation", "files", "both"], history: true },
  input: { delivery: ['native','afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn','session'], reportsPendingInputs: true } },
  turn: { outputSchema: true, inputModalities: ["text", "image", "file"], overrides: ["model"] },
  goal: { actions: ["set", "clear"] }, compact: true, review: true,
  interactions: ["approval", "userInput", "elicitation", "dynamicTool"],
  config: { options: [{ id: "model", scope: "session", schema: { type: "string" } }] },
};

/**
 * Inject a recorded in-memory adapter into createClient without a native process or model service.
 * The default submission echoes text and publishes its terminal before returning the receipt.
 * Custom hooks supply other native behavior. Dispose the SDK client to release its adapter/backends;
 * disposal counters record calls without clearing fixture state.
 */
export class ScriptedHarnessAdapter implements HarnessAdapter {
  /** Backend dispatches in arrival order, including calls intercepted by execute. */
  readonly calls: FakeCall[] = [];
  /** Detached open attempts, including attempts whose hook or fork validation fails. */
  readonly opened: SessionOpenParams[] = [];
  /** Latest supplied event sink per session ID, retained for fixture-controlled publication/failure. */
  readonly sinks = new Map<string, SessionEventSink>();
  /** Latest created backend per session ID, recorded before fork validation and onOpen. */
  readonly backends = new Map<string, ScriptedBackendSession>();
  /** Number of direct disposal calls; the SDK supplies idempotent ownership around this counter. */
  disposeCount = 0;
  /** Retain options for subsequent reads/dispatches; construction does not initialize a client. */
  constructor(readonly options: FakeAdapterOptions = {}) {}
  /** Return detached declared capabilities, using FAKE_CAPABILITIES when omitted. */
  get capabilities(): Capabilities { return structuredClone(this.options.capabilities ?? FAKE_CAPABILITIES); }
  /** Validate the SDK initialization request and negotiate v1; invalid requests/versions reject. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest("initialize",params);
    negotiateVersion(params.protocolVersions);
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: "scripted", version: "1.0.0", adapter: "conformance/0.1.0" }, capabilities: this.capabilities };
  }
  /**
   * The SDK output wrapper calls this during client session acquisition. Record the backend, copy
   * fork history, then await onOpen before returning it. Missing source/boundary rejects with
   * SESSION_NOT_FOUND/TURN_NOT_FOUND; hook failures reject without removing recorded fixture state.
   */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    this.opened.push(structuredClone(params)); this.sinks.set(params.binding.sessionId, sink);
    const backend = new ScriptedBackendSession(this, params, sink); this.backends.set(params.binding.sessionId, backend);
    const fork = params.fork;
    if (params.mode === "fork" && fork) {
      const source = this.backends.get(fork.sourceSessionId);
      if (!source) throw new HarnessSdkError("SESSION_NOT_FOUND");
      const retained = historyBoundaryIndex(source.history, fork.boundary);
      backend.history.push(...structuredClone(source.history.slice(0, retained)));
    }
    await this.options.onOpen?.(params, sink); return backend;
  }
  /** Record one adapter release attempt; retained fixture state remains available for assertions. */
  async dispose(): Promise<void> { this.disposeCount++; }
}
/**
 * Backend returned by ScriptedHarnessAdapter.openSession and invoked through the SDK output wrapper.
 * Exposes mutable state/history for fixtures; direct calls bypass SDK validation and capability guards.
 */
export class ScriptedBackendSession implements BackendSession {
  /** Requested identity with a deterministic scripted nativeRef, adopted by the SDK at attachment. */
  readonly binding: SessionBinding;
  /** Detached capabilities captured at backend construction. */
  readonly capabilities: Capabilities;
  /** Native history retained by submit, fork and revert; history/read returns this same array. */
  readonly history: HistoryItem[] = [];
  /** Number of direct disposal calls; the SDK supplies idempotent ownership around this counter. */
  disposeCount = 0;
  /** Attachment snapshot, updated by session/config/set; event publication is separately controlled. */
  state: SessionState;
  /** Create a ready attachment snapshot from the open request; the adapter records and returns this backend. */
  constructor(private readonly adapter: ScriptedHarnessAdapter, params: SessionOpenParams, readonly sink: SessionEventSink) {
    this.binding = { ...params.binding, nativeRef: { provider: "scripted", value: `native:${params.binding.sessionId}` } };
    this.capabilities = adapter.capabilities;
    this.state = { binding: this.binding, capabilities: this.capabilities, status: "ready", activeTurnIds: [], config: params.config ?? {}, ...(params.model ? { model: params.model } : {}), capabilityRevision: 1 };
  }
  /** Await ordered sink publication; item events need their owning turnId and publication failures reject. */
  async emit(payload: AhpEventPayload, turnId?: string): Promise<void> { await this.sink.emit(payload, { turnId }); }
  /**
   * Record dispatch, await the custom execute hook, then use the default only for undefined results.
   * Event-producing defaults publish native events before their receipts; sink/hook failures reject. Interaction
   * dispatch rejects because the SDK registry must handle it before reaching the backend.
   */
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    const call: FakeCall = { method, params }; this.adapter.calls.push(call);
    const custom = await this.adapter.options.execute?.(call, this.sink);
    if (custom !== undefined) return custom as AhpResultMap[M];
    let result: AhpResultMap[SessionMethod];
    switch (method) {
      case "input/submit": {
        result = await this.submitInput(params as InputSubmitParams); break;
      }
      case "turn/steer": {
        const request = params as AhpRequestMap["turn/steer"];
        await this.emit({ type: "turn/completed", payload: { turnId: request.expectedTurnId, status: "completed" } });
        result = { submissionId: request.submissionId, turnId: request.expectedTurnId, accepted: true }; break;
      }
      case "turn/interrupt": {
        const id = (params as AhpRequestMap["turn/interrupt"]).turnId;
        await this.emit({ type: "turn/completed", payload: { turnId: id, status: "interrupted" } }); result = { accepted: true, turnId: id }; break;
      }
      case "session/config/set": this.state = { ...this.state, config: { ...this.state.config, ...(params as AhpRequestMap["session/config/set"]).patch }, capabilityRevision: this.state.capabilityRevision + 1 }; result = this.state; break;
      case "session/revert": {
        const request = params as AhpRequestMap["session/revert"];
        if (request.scope !== "files") {
          this.history.splice(historyBoundaryIndex(this.history, request.boundary));
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
  /** Record one backend release attempt without erasing state or claiming native execution was stopped. */
  async dispose(): Promise<void> { this.disposeCount++; }

  /** Publish the deliberately reused item ID and authoritative final text before acknowledging admission. */
  private async submitInput(start: InputSubmitParams): Promise<AhpResultMap["input/submit"]> {
    const turnId = randomUUID();
    await this.emit({ type: "turn/started", payload: { turnId } });
    const item = { id: "native-reused", type: "agentMessage" as const, text: start.input.filter(part => part.type === "text").map(part => part.text).join("\n"), phase: "final" as const };
    await this.emit({ type: "item/started", payload: { item: { ...item, text: "" } } }, turnId);
    await this.emit({ type: "item/delta", payload: { itemId: item.id, kind: "text", text: "preview " } }, turnId);
    await this.emit({ type: "item/completed", payload: { item } }, turnId);
    this.history.push({ turnId, item });
    await this.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
    return { submissionId: start.submissionId, turnId, accepted: true, disposition: "started" };
  }
}

/** Create a fresh injectable adapter; createClient initializes it and its caller must dispose that client. */
export function createScriptedAdapter(options?: FakeAdapterOptions): ScriptedHarnessAdapter { return new ScriptedHarnessAdapter(options); }

/**
 * Supply isolated deterministic drivers for runConformance, including held turns and deliberate source
 * faults. An optional capability set replaces the defaults so the runner can check applicability.
 * No external resources are acquired; the runner owns each created client and adapter.
 */
export function createScriptedConformanceFactory(capabilities?: Capabilities): ConformanceFactory {
  return (scenario: ConformanceScenario) => {
    const adapter = createScriptedAdapter({ capabilities, execute: scenarioExecutor(scenario) });
    const driver: ConformanceDriver = {
      adapter,
      openParams: { requestId: "conformance-open", mode: "new", binding: { sessionId: "conformance-session", adapterId: "scripted", runtimeConfigId: "conformance-runtime" }, cwd: "/tmp" },
    };
    // afterStart runs only after opening this session, so its retained sink is available.
    if (scenario === "backpressure") {
      driver.afterStart = async () => {
        adapter.sinks.get("conformance-session")!.tryEmit({ type: "notice", payload: { severity: "info", code: "FLOOD", message: "x".repeat(8192) } });
      };
      driver.runtimeOptions = { queue: { maxFrameBytes: 4096 } };
    }
    if (scenario === "disconnect") {
      driver.afterStart = async () => {
        await adapter.sinks.get("conformance-session")!.fail(new HarnessSdkError("CONNECTION_CLOSED", "Conformance disconnection", false, true));
      };
    }
    return driver;
  };
}

/** Resolve a retained history boundary once for fork/revert; missing native turns reject consistently. */
function historyBoundaryIndex(history: HistoryItem[], boundary: AhpRequestMap["session/revert"]["boundary"]): number {
  const index = history.findIndex(entry => entry.turnId === boundary.turnId);
  if (index < 0) throw new HarnessSdkError("TURN_NOT_FOUND");
  return boundary.relation === "before" ? index : index + 1;
}

/** Install the scenario's input hook; the backend invokes it before default dispatch and awaits its events/receipt. */
function scenarioExecutor(scenario: ConformanceScenario): NonNullable<FakeAdapterOptions["execute"]> {
  return async (call, sink) => {
    if (call.method !== "input/submit") return undefined;
    const { submissionId } = call.params as InputSubmitParams; const turnId = randomUUID();
    if (["interrupt", "steer", "disconnect", "backpressure"].includes(scenario)) {
      await sink.emit({ type: "turn/started", payload: { turnId } });

      return { submissionId, accepted: true, disposition: "started", turnId };
    }
    const interactionsByScenario: Partial<Record<ConformanceScenario, Parameters<SessionEventSink["requestInteraction"]>[0]>> = {
      approval: { interactionId: "conformance-approval", kind: "approval", turnId, options: [{ id: "deny", label: "Deny", semantic: "deny" }] },
      userInput: { interactionId: "conformance-input", kind: "userInput", turnId, questions: [{ id: "q", prompt: "Value" }] },
      elicitation: { interactionId: "conformance-elicitation", kind: "elicitation", turnId, mode: "form" },
      dynamicTool: { interactionId: "conformance-tool", kind: "dynamicTool", turnId, toolName: "conformance", arguments: {} },
    };
    const interaction = interactionsByScenario[scenario];
    if (interaction || scenario === "unknown-item") {
      await sink.emit({ type: "turn/started", payload: { turnId } });
      if (interaction) await sink.requestInteraction(interaction, async () => {});
      else await sink.emit({ type: "item/completed", payload: { item: { id: "unknown", type: "toolCall", kind: "other", title: "Unknown", nativeType: "futureNativeType", raw: { safe: "value" } } } }, { turnId });
      await sink.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
      return { submissionId, accepted: true, disposition: "started", turnId };
    }
    return undefined;
  };
}
