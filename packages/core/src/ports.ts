import type { AhpEventPayload, AhpMethod, AhpRequestMap, AhpResultMap, Capabilities, InitializeParams, InitializeResult, InteractionRequested, InteractionResponse, SessionBinding, SessionOpenParams } from '@anureo/protocol';
import type { RequestOptions } from './errors';
import type { QueueLimits } from './queue';
export type NativeInteractionResponder = (response: InteractionResponse | null, reason?: string) => Promise<void>;
export type SessionMethod = Exclude<AhpMethod, 'initialize' | 'session/open'>;
export interface EventScope { turnId?: string; itemId?: string }
export interface SessionEventSink {
  bindSubmission(submissionId: string, turnId: string): Promise<void>;
  emit(event: AhpEventPayload, scope?: EventScope): Promise<void>;
  tryEmit(event: AhpEventPayload, scope?: EventScope): boolean;
  requestInteraction(request: InteractionRequested, responder: NativeInteractionResponder): Promise<InteractionResponse>;
  resolveInteraction(result: AhpResultMap['interaction/respond']): Promise<void>;
  fail(cause: unknown): Promise<void>;
}
export interface BackendSession {
  readonly state?: import('@anureo/protocol').SessionState;
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
