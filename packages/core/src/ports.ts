import type {
  Capabilities, AhpEvent, AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap,
  InitializeParams, InitializeResult, InteractionRequested, InteractionResponse,
  SessionBinding, SessionOpenParams,
} from "@anureo/protocol";
import type { RequestOptions } from "./errors";
import type { QueueLimits } from "./queue";

export type SessionMethod = Exclude<AhpMethod, "initialize" | "session/open">;
export interface EventScope { turnId?: string; itemId?: string }
export type NativeInteractionResponder = (response: InteractionResponse | null, reason?: string) => Promise<void>;
export interface SessionEventSink {
  emit(event: AhpEventPayload, scope?: EventScope): Promise<void>;
  /** Non-pausable callback: false means the source must stop and the stream has failed. */
  tryEmit(event: AhpEventPayload, scope?: EventScope): boolean;
  requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse>;
  /** A remote peer resolved/expired an existing request. Never sends a second native response. */
  resolveInteraction(result: AhpResultMap["interaction/respond"]): Promise<void>;
  fail(cause: unknown): Promise<void>;
}
export interface BackendSession {
  readonly binding: SessionBinding;
  readonly capabilities: Capabilities;
  execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]>;
  dispose(): Promise<void>;
}
export interface HarnessAdapter {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  openSession(params: SessionOpenParams, sink: SessionEventSink): Promise<BackendSession>;
  dispose(): Promise<void>;
}
export interface RuntimeOptions {
  createId?: () => string;
  now?: () => string;
  requestTimeoutMs?: number;
  openTimeoutMs?: number;
  interactionTimeoutMs?: number;
  maxPendingInteractions?: number;
  requestCacheSize?: number;
  queue?: QueueLimits;
  /** Runs synchronously before native submission; persist only irreversible privacy metadata. */
  onMarkedSecret?: (binding: Readonly<SessionBinding>, value: string) => void;
  /** Host-owned cross-process privacy projection for authoritative native history. */
  redactHistory?: (binding: Readonly<SessionBinding>, page: AhpResultMap["history/read"]) => AhpResultMap["history/read"] | Promise<AhpResultMap["history/read"]>;
}
export interface HarnessSession {
  readonly binding: Readonly<SessionBinding>;
  readonly capabilities: Readonly<Capabilities>;
  events(): AsyncIterable<AhpEvent>;
  startTurn(params: AhpRequestMap["turn/start"], options?: RequestOptions): Promise<AhpResultMap["turn/start"]>;
  steer(params: AhpRequestMap["turn/steer"], options?: RequestOptions): Promise<AhpResultMap["turn/steer"]>;
  interrupt(params: AhpRequestMap["turn/interrupt"], options?: RequestOptions): Promise<AhpResultMap["turn/interrupt"]>;
  respond(params: AhpRequestMap["interaction/respond"], options?: RequestOptions): Promise<AhpResultMap["interaction/respond"]>;
  cancelInteraction(params: AhpRequestMap["interaction/cancel"], options?: RequestOptions): Promise<AhpResultMap["interaction/cancel"]>;
  setConfig(params: AhpRequestMap["session/config/set"], options?: RequestOptions): Promise<AhpResultMap["session/config/set"]>;
  revert(params: AhpRequestMap["session/revert"], options?: RequestOptions): Promise<AhpResultMap["session/revert"]>;
  readHistory(params: AhpRequestMap["history/read"], options?: RequestOptions): Promise<AhpResultMap["history/read"]>;
  setGoal(params: AhpRequestMap["goal/set"], options?: RequestOptions): Promise<AhpResultMap["goal/set"]>;
  clearGoal(params: AhpRequestMap["goal/clear"], options?: RequestOptions): Promise<AhpResultMap["goal/clear"]>;
  compact(params: AhpRequestMap["compact/start"], options?: RequestOptions): Promise<AhpResultMap["compact/start"]>;
  review(params: AhpRequestMap["review/start"], options?: RequestOptions): Promise<AhpResultMap["review/start"]>;
  close(options?: RequestOptions): Promise<void>;
}
export interface HarnessRuntime {
  initialize(params: InitializeParams, options?: RequestOptions): Promise<InitializeResult>;
  openSession(params: SessionOpenParams, options?: RequestOptions): Promise<HarnessSession>;
  dispose(): Promise<void>;
}
