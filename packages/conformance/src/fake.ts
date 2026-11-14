import { randomUUID } from "node:crypto";
import {
  HarnessSdkError, type BackendSession, type HarnessAdapter, type SessionEventSink, type SessionMethod,
} from "@anureo/sdk";
import {
  AHP_PROTOCOL_CONTRACT, assertRequest, negotiateVersion, type Capabilities, type AhpRequestMap, type AhpResultMap,
  type HistoryItem, type InitializeParams, type InitializeResult, type InteractionRequested, type SessionBinding,
  type SessionOpenParams, type SessionState, type InputSubmitParams, type AhpEventPayload,
} from "@anureo/protocol";
import type { ConformanceDriver, ConformanceFactory, ConformanceScenario } from "./suite";

/** One backend dispatch, recorded before any custom hook runs. */
export interface FakeCall {
  method: SessionMethod;
  /** The dispatched object also used by the default handler if the hook returns undefined. */
  params: AhpRequestMap[SessionMethod];
}
/** Configure an injectable in-memory backend for SDK, workflow and application fixtures. */
export interface FakeAdapterOptions {
  /** Replaces the complete default capability set. Adapter capability reads clone it. */
  capabilities?: Capabilities;
  /**
   * ScriptedBackendSession.execute awaits this hook after recording a call. Return undefined to
   * continue with default dispatch, or return a method-matching result to supply the entire
   * response. In the latter case the hook owns the call's events and state changes. A throw or
   * rejection rejects backend dispatch.
   */
  execute?: (call: FakeCall, sink: SessionEventSink) => Promise<AhpResultMap[SessionMethod] | undefined>;
  /**
   * Publish setup events or hold session acquisition. ScriptedHarnessAdapter.openSession awaits
   * this hook after recording the backend and copying any fork history. A throw or rejection
   * rejects acquisition and leaves the recorded fixture state available.
   */
  onOpen?: (params: SessionOpenParams, sink: SessionEventSink) => Promise<void>;
}
/** Default advertised capabilities. Adapter reads clone the current contents of this mutable template. */
export const FAKE_CAPABILITIES: Capabilities = {
  session: { resume: true, fork: ["before", "through"], revert: ["conversation", "files", "both"], history: true },
  input: { delivery: ['native','afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn','session'], reportsPendingInputs: true } },
  turn: { outputSchema: true, inputModalities: ["text", "image", "file"], overrides: ["model"] },
  goal: { actions: ["set", "clear"] }, compact: true, review: true,
  interactions: ["approval", "userInput", "elicitation", "dynamicTool"],
  config: { options: [{ id: "model", scope: "session", schema: { type: "string" } }] },
};

/** Create a fresh adapter to pass to createClient. Await disposal of the client when the fixture is done. */
export function createScriptedAdapter(options?: FakeAdapterOptions): ScriptedHarnessAdapter {
  return new ScriptedHarnessAdapter(options);
}

/**
 * Supply runConformance with a fresh in-memory adapter per case, including held turns and
 * observation faults. A supplied capability set replaces the defaults for applicability checks.
 * The runner owns each client and its adapter.
 */
export function createScriptedConformanceFactory(capabilities?: Capabilities): ConformanceFactory {
  return (scenario: ConformanceScenario) => {
    const adapter = createScriptedAdapter({ capabilities, execute: scenarioExecutor(scenario) });
    const sessionId = "conformance-session";
    const driver: ConformanceDriver = {
      adapter,
      openParams: { requestId: "conformance-open", mode: "new", binding: { sessionId, adapterId: "scripted", runtimeConfigId: "conformance-runtime" }, cwd: "/tmp" },
    };
    // executeScenarioTurn calls afterStart after admission, when openSession has recorded the sink.
    if (scenario === "backpressure") {
      driver.afterStart = async () => {
        adapter.sinks.get(sessionId)!.tryEmit({ type: "notice", payload: { severity: "info", code: "FLOOD", message: "x".repeat(8192) } });
      };
      driver.runtimeOptions = { queue: { maxFrameBytes: 4096 } };
    }
    if (scenario === "disconnect") {
      driver.afterStart = async () => {
        await adapter.sinks.get(sessionId)!.fail(new HarnessSdkError("CONNECTION_CLOSED", "Conformance disconnection", false, true));
      };
    }
    return driver;
  };
}

/**
 * Exercise the SDK with an in-memory adapter that records opens and backend dispatches. By default
 * a submission echoes text and publishes completion before acknowledging it. Hooks can supply
 * other behavior. Await Client.dispose to release SDK ownership while retaining fixture records
 * for assertions.
 */
export class ScriptedHarnessAdapter implements HarnessAdapter {
  /** Retain fixture options by reference for subsequent capability reads, opens and dispatches. */
  constructor(readonly options: FakeAdapterOptions = {}) {}
  /** Backend dispatches in arrival order, including calls intercepted by execute. */
  readonly calls: FakeCall[] = [];
  /** Detached open attempts, including attempts whose hook or fork validation fails. */
  readonly opened: SessionOpenParams[] = [];
  /** Latest supplied event sink per session ID, retained for fixture-controlled publication/failure. */
  readonly sinks = new Map<string, SessionEventSink>();
  /** Latest created backend per session ID, recorded before fork validation and onOpen. */
  readonly backends = new Map<string, ScriptedBackendSession>();
  /** Number of disposal calls received, including any repeated direct calls. */
  disposeCount = 0;
  /** Return detached declared capabilities, using FAKE_CAPABILITIES when omitted. */
  get capabilities(): Capabilities { return structuredClone(this.options.capabilities ?? FAKE_CAPABILITIES); }
  /**
   * Return scripted runtime metadata and cloned capabilities after negotiating AHP v1. The SDK
   * adapter wrapper forwards the result to Client.initialize for validation and storage. Malformed
   * requests and unsupported versions reject.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    assertRequest("initialize", params);
    negotiateVersion(params.protocolVersions);
    return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: "scripted", version: "1.0.0", adapter: "conformance/0.1.0" }, capabilities: this.capabilities };
  }
  /**
   * Supply OutputSession.open with a backend for SDK attachment. Record the backend and sink
   * before copying fork history so a failed setup is observable. Missing source or boundary
   * rejects with SESSION_NOT_FOUND or TURN_NOT_FOUND, respectively. Await onOpen before returning
   * the backend. Hook failures reject and leave the recorded fixture state available.
   */
  async openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession> {
    this.opened.push(structuredClone(params));
    this.sinks.set(params.binding.sessionId, sink);
    const backend = new ScriptedBackendSession(this, params, sink);
    this.backends.set(params.binding.sessionId, backend);
    const fork = params.fork;
    if (params.mode === "fork" && fork) this.copyForkHistory(fork, backend);
    await this.options.onOpen?.(params, sink);
    return backend;
  }
  /** Count adapter release. The SDK wrapper calls this after session cleanup attempts. */
  async dispose(): Promise<void> { this.disposeCount++; }

  /**
   * Give openSession a detached prefix of the source history before setup hooks run. A missing
   * source or boundary throws so open rejects with the fork's fixture records still available.
   */
  private copyForkHistory(fork: NonNullable<SessionOpenParams["fork"]>, backend: ScriptedBackendSession): void {
    const source = this.backends.get(fork.sourceSessionId);
    if (!source) throw new HarnessSdkError("SESSION_NOT_FOUND");
    const retained = historyBoundaryIndex(source.history, fork.boundary);
    backend.history.push(...structuredClone(source.history.slice(0, retained)));
  }
}
/**
 * Inspect or customize the in-memory session recorded by ScriptedHarnessAdapter.openSession.
 * OutputSession dispatches validated SDK requests to this backend. Direct fixture calls to execute
 * bypass those SDK guards.
 */
export class ScriptedBackendSession implements BackendSession {
  /** Requested identity with a deterministic scripted nativeRef, adopted by the SDK at attachment. */
  readonly binding: SessionBinding;
  /** Capabilities cloned from the adapter at construction and shared with the fixture state. */
  readonly capabilities: Capabilities;
  /** Mutable native history. Default backend history/read returns this array by reference. */
  readonly history: HistoryItem[] = [];
  /** Number of disposal calls received, including any repeated direct calls. */
  disposeCount = 0;
  /** Initial attachment snapshot. Default configuration dispatch replaces it without publishing a state event. */
  state: SessionState;
  /** Build a ready attachment snapshot and retain the adapter and event sink for dispatch. */
  constructor(
    private readonly adapter: ScriptedHarnessAdapter,
    params: SessionOpenParams,
    /** Callbacks supplied at open for event publication, interactions and source faults. */
    readonly sink: SessionEventSink,
  ) {
    this.binding = { ...params.binding, nativeRef: { provider: "scripted", value: `native:${params.binding.sessionId}` } };
    this.capabilities = adapter.capabilities;
    this.state = {
      binding: this.binding,
      capabilities: this.capabilities,
      status: "ready",
      activeTurnIds: [],
      config: params.config ?? {},
      ...(params.model ? { model: params.model } : {}),
      capabilityRevision: 1,
    };
  }
  /** Await ordered sink publication. Supply the owning turn ID for item events. Sink failures reject. */
  async emit(payload: AhpEventPayload, turnId?: string): Promise<void> { await this.sink.emit(payload, { turnId }); }
  /**
   * Resolve a scripted result for OutputSession.execute, which uses receipts to bind submissions
   * before returning to Session for request-result validation. Record the call and await the
   * custom hook before using defaults. Defaults that publish events await them before returning
   * a receipt. Sink and hook failures reject dispatch. Default interaction dispatch rejects
   * because Session handles it in its registry.
   */
  execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]>;
  async execute(method: SessionMethod, params: AhpRequestMap[SessionMethod]): Promise<AhpResultMap[SessionMethod] | undefined> {
    const call: FakeCall = { method, params };
    this.adapter.calls.push(call);
    const custom = await this.adapter.options.execute?.(call, this.sink);
    if (custom !== undefined) return custom;

    switch (method) {
      case "input/submit":
        return await this.submitInput(params as InputSubmitParams);
      case "turn/steer": {
        const request = params as AhpRequestMap["turn/steer"];
        await this.emit({ type: "turn/completed", payload: { turnId: request.expectedTurnId, status: "completed" } });
        return { submissionId: request.submissionId, turnId: request.expectedTurnId, accepted: true };
      }
      case "turn/interrupt": {
        const { turnId } = params as AhpRequestMap["turn/interrupt"];
        await this.emit({ type: "turn/completed", payload: { turnId, status: "interrupted" } });
        return { accepted: true, turnId };
      }
      case "session/config/set": {
        this.state = {
          ...this.state,
          config: { ...this.state.config, ...(params as AhpRequestMap["session/config/set"]).patch },
          capabilityRevision: this.state.capabilityRevision + 1,
        };
        return this.state;
      }
      case "session/revert": {
        const request = params as AhpRequestMap["session/revert"];
        if (request.scope !== "files") {
          this.history.splice(historyBoundaryIndex(this.history, request.boundary));
        }
        return { appliedScope: request.scope, boundary: request.boundary };
      }
      case "history/read":
        return { items: this.history, snapshotToken: "fake-snapshot", source: this.binding.nativeRef };
      case "goal/set":
        return { goal: (params as AhpRequestMap["goal/set"]).goal, status: "active" };
      case "goal/clear":
        return { goal: null, status: "cleared" };
      case "compact/start":
        return { maintenanceId: "fake-maintenance", status: "completed" };
      case "review/start": {
        const turnId = randomUUID();
        await this.emit({ type: "turn/started", payload: { turnId } });
        await this.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
        return startedReceipt((params as AhpRequestMap["review/start"]).submissionId, turnId);
      }
      case "session/interrupt":
        return { accepted: true, stillQueued: [] };
      case "session/close":
        return { closed: true, observationClosed: true, executionStopped: "unconfirmed" };
      case "interaction/respond":
      case "interaction/cancel":
        throw new Error("Interactions must be handled by the SDK registry");
    }
  }
  /** Count backend release calls from the SDK or direct fixture callers and retain state for assertions. */
  async dispose(): Promise<void> { this.disposeCount++; }

  /**
   * Produce the default submission receipt after publishing start, preview, final item and terminal.
   * Reuse an item ID across turns to exercise SDK scoping. Store the completed item before terminal
   * publication, where a sink failure can still reject the dispatch.
   */
  private async submitInput(request: InputSubmitParams): Promise<AhpResultMap["input/submit"]> {
    const turnId = randomUUID();
    await this.emit({ type: "turn/started", payload: { turnId } });
    const text = request.input.filter(part => part.type === "text").map(part => part.text).join("\n");
    const item = { id: "native-reused", type: "agentMessage" as const, text, phase: "final" as const };
    await this.emit({ type: "item/started", payload: { item: { ...item, text: "" } } }, turnId);
    await this.emit({ type: "item/delta", payload: { itemId: item.id, kind: "text", text: "preview " } }, turnId);
    await this.emit({ type: "item/completed", payload: { item } }, turnId);
    this.history.push({ turnId, item });
    await this.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
    return { submissionId: request.submissionId, turnId, accepted: true, disposition: "started" };
  }
}

/** Associate an accepted submission with its started turn. Terminal publication is independent. */
function startedReceipt(submissionId: string, turnId: string) {
  return { submissionId, accepted: true, disposition: "started", turnId } as const;
}

/**
 * Find the end of the retained prefix shared by fork and revert. Use the first matching history
 * entry as the boundary. Throw TURN_NOT_FOUND before either caller changes history if it is absent.
 */
function historyBoundaryIndex(history: HistoryItem[], boundary: AhpRequestMap["session/revert"]["boundary"]): number {
  const index = history.findIndex(entry => entry.turnId === boundary.turnId);
  if (index < 0) throw new HarnessSdkError("TURN_NOT_FOUND");
  return boundary.relation === "before" ? index : index + 1;
}

/**
 * Create the hook that ScriptedBackendSession.execute awaits. Only special submissions supply a
 * receipt here. Held cases stop after start so the suite can drive control or observation loss.
 * Interaction cases await SDK settlement before completion. Sink failures reject dispatch.
 */
function scenarioExecutor(scenario: ConformanceScenario): NonNullable<FakeAdapterOptions["execute"]> {
  return async (call, sink) => {
    if (call.method !== "input/submit") return undefined;
    const { submissionId } = call.params as InputSubmitParams;
    const turnId = randomUUID();
    const hold = ["interrupt", "steer", "disconnect", "backpressure"].includes(scenario);
    const interaction = hold ? undefined : scenarioInteraction(scenario, turnId);
    if (!hold && !interaction && scenario !== "unknown-item") return undefined;

    await sink.emit({ type: "turn/started", payload: { turnId } });
    if (hold) return startedReceipt(submissionId, turnId);
    if (interaction) {
      // The SDK registry calls this responder when it settles the request. The fixture has no
      // native peer to notify, but it still waits for the registry before completing the turn.
      await sink.requestInteraction(interaction, async () => {});
    } else {
      await sink.emit({
        type: "item/completed",
        payload: { item: { id: "unknown", type: "toolCall", kind: "other", title: "Unknown", nativeType: "futureNativeType", raw: { safe: "value" } } },
      }, { turnId });
    }
    await sink.emit({ type: "turn/completed", payload: { turnId, status: "completed" } });
    return startedReceipt(submissionId, turnId);
  };
}

/** Supply the SDK's automatic conformance handler with the native request for an interaction case. */
function scenarioInteraction(scenario: ConformanceScenario, turnId: string): InteractionRequested | undefined {
  switch (scenario) {
    case "approval":
      return { interactionId: "conformance-approval", kind: "approval", turnId, options: [{ id: "deny", label: "Deny", semantic: "deny" }] };
    case "userInput":
      return { interactionId: "conformance-input", kind: "userInput", turnId, questions: [{ id: "q", prompt: "Value" }] };
    case "elicitation":
      return { interactionId: "conformance-elicitation", kind: "elicitation", turnId, mode: "form" };
    case "dynamicTool":
      return { interactionId: "conformance-tool", kind: "dynamicTool", turnId, toolName: "conformance", arguments: {} };
  }
}
