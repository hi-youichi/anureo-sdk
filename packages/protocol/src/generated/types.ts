// Generated from schema/v1/ahp.schema.json. Run bun run generate; do not edit.
export type JsonValue = (null) | (string) | (number) | (boolean) | (Array<JsonValue>) | ({ [key: string]: JsonValue });
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = (boolean) | (JsonObject);
export type InteractionKind = "approval" | "userInput" | "elicitation" | "dynamicTool";
export type RevertScope = "conversation" | "files" | "both";
export type Boundary = { "turnId": string; "relation": "before" | "through"; "nativeTurnId"?: string };
export type ExtensionDescriptor = { "name": string; "version": string };
export type ConfigOption = { "id": string; "title"?: string; "schema": JsonSchema; "scope": "session" | "turn"; "value"?: JsonValue };
export type Capabilities = { "session"?: { "resume"?: boolean; "fork"?: Array<"before" | "through">; "revert"?: Array<RevertScope>; "history"?: boolean }; "turn"?: { "outputSchema"?: boolean; "overrides"?: Array<string>; "inputModalities"?: Array<"text" | "image" | "file"> }; "goal"?: { "actions"?: Array<"set" | "clear"> }; "review"?: boolean; "compact"?: boolean; "subagents"?: { "events": "nested" | "none" }; "mcp"?: { "stdio"?: boolean; "http"?: boolean; "elicitation"?: Array<"form" | "url"> }; "interactions"?: Array<InteractionKind>; "config"?: { "options": Array<ConfigOption> }; "extensions"?: Array<ExtensionDescriptor>; "input"?: { "delivery": Array<"native" | "afterTurn">; "steer"?: { "target": "turn"; "atomicMatch": true }; "interrupt"?: { "targets": Array<"turn" | "session">; "reportsPendingInputs": boolean; "cancelQueued"?: boolean } } };
export type ClientInfo = { "name": string; "version": string; "title"?: string };
export type RuntimeInfo = { "name": string; "version": string; "adapter": string };
export type InitializeParams = { "protocolVersions": Array<number>; "clientInfo": ClientInfo; "clientCapabilities"?: Capabilities; "protocolContract": "native-lifecycle" };
export type InitializeResult = { "protocolVersion": 1; "runtime": RuntimeInfo; "capabilities": Capabilities; "protocolContract": "native-lifecycle" };
export type NativeRef = { "provider": string; "value": string };
export type SessionBinding = { "sessionId": string; "adapterId": string; "runtimeConfigId": string; "nativeRef"?: NativeRef };
export type HarnessError = { "code": string; "message": string; "retryable": boolean; "outcomeUnknown": boolean; "details"?: JsonObject };
export type Usage = { "provider": string; "scope": "turn" | "session"; "source": "native"; "input"?: number; "output"?: number; "cacheRead"?: number; "cacheWrite"?: number; "total"?: number; "contextWindow"?: number; "contextUsed"?: number };
export type TextBlock = { "type": "text"; "text": string };
export type ImageBlock = { "type": "image"; "url"?: string; "data"?: string; "mimeType"?: string };
export type FileBlock = { "type": "file"; "uri": string; "name"?: string; "mimeType"?: string };
export type InputBlock = (TextBlock) | (ImageBlock) | (FileBlock);
export type McpServer = ({ "type": "stdio"; "name": string; "command": string; "args"?: Array<string>; "env"?: { [key: string]: string } }) | ({ "type": "http"; "name": string; "url": string; "headers"?: { [key: string]: string } });
export type SessionState = { "binding": SessionBinding; "status": "opening" | "ready" | "running" | "closed" | "recoveryRequired" | "closing"; "config": JsonObject; "capabilities": Capabilities; "capabilityRevision": number; "model"?: string; "goal"?: GoalState; "fastMode"?: { "state": "off" | "cooldown" | "on"; "reason"?: string }; "metadata"?: SessionMetadata; "activeTurnIds": Array<string> };
export type SessionOpenParams = { "requestId": string; "mode": "new" | "resume" | "fork"; "binding": SessionBinding; "cwd": string; "model"?: string; "instructions"?: string; "mcpServers"?: Array<McpServer>; "permissionMode"?: string; "config"?: JsonObject; "fork"?: { "sourceSessionId": string; "nativeRef"?: NativeRef; "boundary": Boundary } };
export type SessionOpenResult = { "binding": SessionBinding; "streamId": string; "state": SessionState; "capabilities": Capabilities };
export type SessionCloseParams = { "requestId": string; "sessionId": string };
export type SessionCloseResult = { "closed": true; "observationClosed": true; "executionStopped": "confirmed" | "unconfirmed" };
export type SessionConfigParams = { "requestId": string; "sessionId": string; "patch": JsonObject };
export type SessionRevertParams = { "requestId": string; "sessionId": string; "boundary": Boundary; "scope": RevertScope };
export type RevertResult = { "appliedScope": RevertScope; "boundary": Boundary; "nativeRef"?: NativeRef };
export type HistoryReadParams = { "requestId": string; "sessionId": string; "cursor"?: string; "limit"?: number; "snapshotToken"?: string };
export type HistoryItem = { "turnId": string; "item": Item; "nativeTurnId"?: string; "nativeItemId"?: string };
export type HistoryPage = { "items": Array<HistoryItem>; "nextCursor"?: (string) | (null); "snapshotToken"?: string; "source"?: NativeRef };
export type InputSubmitParams = { "requestId": string; "sessionId": string; "input": Array<InputBlock>; "overrides"?: JsonObject; "outputSchema"?: JsonSchema; "submissionId": string; "delivery": "native" | "afterTurn" };
export type InputSubmitResult = (SubmissionDispatch) | (SubmissionAcceptance);
export type TurnSteerParams = { "requestId": string; "sessionId": string; "expectedTurnId": string; "input": Array<InputBlock>; "submissionId": string };
export type TurnSteerResult = { "submissionId": string; "turnId": string; "accepted": true };
export type TurnInterruptParams = { "requestId": string; "sessionId": string; "turnId": string };
export type TurnInterruptResult = { "accepted": true; "turnId"?: string };
export type GoalState = { "goal": (JsonObject) | (null); "status"?: "active" | "cleared" };
export type GoalSetParams = { "requestId": string; "sessionId": string; "goal": JsonObject };
export type GoalClearParams = { "requestId": string; "sessionId": string };
export type CompactStartParams = { "requestId": string; "sessionId": string };
export type MaintenanceResult = { "maintenanceId": string; "status": "accepted" | "completed" };
export type ReviewStartParams = { "requestId": string; "sessionId": string; "target": JsonObject; "submissionId": string };
export type UserMessageItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "userMessage"; "content": Array<InputBlock> };
export type AgentMessageItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "agentMessage"; "text": string; "phase"?: "commentary" | "final" };
export type ReasoningItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "reasoning"; "text"?: string; "summary"?: string };
export type PlanItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "plan"; "steps": Array<{ "id": string; "text": string; "status": "pending" | "inProgress" | "completed" }> };
export type ToolCallItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "toolCall"; "kind": "command" | "fileChange" | "mcp" | "dynamic" | "web" | "image" | "other"; "title": string; "input"?: JsonValue; "output"?: JsonValue; "locations"?: Array<{ "path": string; "line"?: number }>; "nativeType"?: string; "raw"?: JsonValue; "fileChanges"?: Array<FileChange>; "image"?: ToolImageOutput; "mcp"?: { "server": string; "tool": string }; "toolName"?: string };
export type SubagentItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "subagent"; "subagentId": string; "state": "pending" | "running" | "completed" | "failed" | "interrupted"; "name"?: string; "task"?: string; "nativeRef"?: NativeRef };
export type ReviewItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "review"; "state": "entered" | "exited"; "text"?: string };
export type CompactionItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "compaction"; "summary"?: string; "trigger"?: string };
export type HookItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "hook"; "name": string; "input"?: JsonValue; "output"?: JsonValue };
export type NoticeItem = { "id": string; "status"?: "running" | "completed" | "failed" | "declined" | "interrupted"; "startedAt"?: string; "durationMs"?: number; "parentItemId"?: string; "extensions"?: JsonObject; "type": "notice"; "severity": "info" | "warning" | "error"; "code"?: string; "text": string };
export type Item = (UserMessageItem) | (AgentMessageItem) | (ReasoningItem) | (PlanItem) | (ToolCallItem) | (SubagentItem) | (ReviewItem) | (CompactionItem) | (HookItem) | (NoticeItem);
export type ApprovalOption = { "id": string; "label": string; "semantic"?: "allowOnce" | "allowSession" | "deny" | "allowWithRule" | "cancel"; "description"?: string };
export type UserQuestion = { "id": string; "prompt": string; "options"?: Array<{ "id": string; "label": string }>; "secret"?: boolean; "required"?: boolean };
export type ApprovalInteraction = { "interactionId": string; "title"?: string; "turnId"?: string; "itemId"?: string; "createdAt"?: string; "expiresAt"?: string; "privatePayload"?: JsonObject; "privatePayloadAvailable"?: boolean; "kind": "approval"; "options": Array<ApprovalOption>; "input"?: JsonValue };
export type UserInputInteraction = { "interactionId": string; "title"?: string; "turnId"?: string; "itemId"?: string; "createdAt"?: string; "expiresAt"?: string; "privatePayload"?: JsonObject; "privatePayloadAvailable"?: boolean; "kind": "userInput"; "questions": Array<UserQuestion>; "schema"?: JsonSchema };
export type ElicitationInteraction = { "interactionId": string; "title"?: string; "turnId"?: string; "itemId"?: string; "createdAt"?: string; "expiresAt"?: string; "privatePayload"?: JsonObject; "privatePayloadAvailable"?: boolean; "kind": "elicitation"; "mode": "form" | "url"; "schema"?: JsonSchema; "message"?: string };
export type DynamicToolInteraction = { "interactionId": string; "title"?: string; "turnId"?: string; "itemId"?: string; "createdAt"?: string; "expiresAt"?: string; "privatePayload"?: JsonObject; "privatePayloadAvailable"?: boolean; "kind": "dynamicTool"; "toolName": string; "arguments": JsonObject; "schema"?: JsonSchema };
export type InteractionRequested = (ApprovalInteraction) | (UserInputInteraction) | (ElicitationInteraction) | (DynamicToolInteraction);
export type InteractionResponse = ({ "kind": "approval"; "optionId": string }) | ({ "kind": "userInput"; "answers": JsonObject }) | ({ "kind": "elicitation"; "action": "accept" | "decline" | "cancel"; "content"?: JsonObject }) | ({ "kind": "dynamicTool"; "content": Array<InputBlock>; "isError"?: boolean });
export type InteractionRespondParams = { "requestId": string; "sessionId": string; "interactionId": string; "response": InteractionResponse };
export type InteractionCancelParams = { "requestId": string; "sessionId": string; "interactionId": string; "reason"?: string };
export type InteractionOutcome = "responded" | "cancelled" | "expired" | "unknown";
export type InteractionResult = { "interactionId": string; "outcome": InteractionOutcome; "reason"?: string };
export type SessionStateEvent = { "type": "session/state"; "payload": SessionState };
export type TurnStartedEvent = { "type": "turn/started"; "payload": { "turnId": string; "nativeTurnId"?: string } };
export type TurnCompletedEvent = { "type": "turn/completed"; "payload": { "turnId": string; "status": "completed" | "interrupted" | "failed"; "error"?: HarnessError; "usage"?: Usage } };
export type ItemStartedEvent = { "type": "item/started"; "payload": { "item": Item } };
export type ItemDeltaEvent = { "type": "item/delta"; "payload": { "itemId": string; "kind": "text" | "reasoningSummary" | "output" | "patch"; "text"?: string; "value"?: JsonValue } };
export type ItemCompletedEvent = { "type": "item/completed"; "payload": { "item": Item } };
export type UsageUpdatedEvent = { "type": "usage/updated"; "payload": Usage };
export type InteractionRequestedEvent = { "type": "interaction/requested"; "payload": InteractionRequested };
export type InteractionResolvedEvent = { "type": "interaction/resolved"; "payload": InteractionResult };
export type NoticeEvent = { "type": "notice"; "payload": { "severity": "info" | "warning" | "error"; "code": string; "message": string; "raw"?: JsonValue } };
export type ExtensionEvent = { "type": "extension"; "payload": { "name": string; "version": string; "method"?: string; "data": JsonValue } };
export type AhpEventPayload = (SessionStateEvent) | (SessionMetadataEvent) | (TurnStartedEvent) | (TurnCompletedEvent) | (ItemStartedEvent) | (ItemDeltaEvent) | (ItemCompletedEvent) | (UsageUpdatedEvent) | (InteractionRequestedEvent) | (InteractionResolvedEvent) | (NoticeEvent) | (ExtensionEvent) | (SubmissionBoundEvent) | (SubmissionStatusEvent);
export type SourceEnvelope = { "sessionId": string; "streamId": string; "seq": number; "timestamp": string; "turnId"?: string; "itemId"?: string };
export type AhpEvent = (SourceEnvelope) & (AhpEventPayload);
export type RpcId = (string) | (number);
export type RpcError = { "code": number; "message": string; "data"?: HarnessError };
export type InitializeRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "initialize"; "params": InitializeParams };
export type SessionOpenRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "session/open"; "params": SessionOpenParams };
export type SessionCloseRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "session/close"; "params": SessionCloseParams };
export type SessionConfigRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "session/config/set"; "params": SessionConfigParams };
export type SessionRevertRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "session/revert"; "params": SessionRevertParams };
export type HistoryReadRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "history/read"; "params": HistoryReadParams };
export type InputSubmitRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "input/submit"; "params": InputSubmitParams };
export type TurnSteerRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "turn/steer"; "params": TurnSteerParams };
export type TurnInterruptRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "turn/interrupt"; "params": TurnInterruptParams };
export type InteractionRespondRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "interaction/respond"; "params": InteractionRespondParams };
export type InteractionCancelRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "interaction/cancel"; "params": InteractionCancelParams };
export type GoalSetRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "goal/set"; "params": GoalSetParams };
export type GoalClearRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "goal/clear"; "params": GoalClearParams };
export type CompactStartRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "compact/start"; "params": CompactStartParams };
export type ReviewStartRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "review/start"; "params": ReviewStartParams };
export type AhpRpcRequest = (InitializeRpcRequest) | (SessionOpenRpcRequest) | (SessionCloseRpcRequest) | (SessionConfigRpcRequest) | (SessionRevertRpcRequest) | (HistoryReadRpcRequest) | (InputSubmitRpcRequest) | (TurnSteerRpcRequest) | (TurnInterruptRpcRequest) | (InteractionRespondRpcRequest) | (InteractionCancelRpcRequest) | (GoalSetRpcRequest) | (GoalClearRpcRequest) | (CompactStartRpcRequest) | (ReviewStartRpcRequest) | (SessionInterruptRpcRequest);
export type AhpRpcSuccess = { "jsonrpc": "2.0"; "id": RpcId; "result": (GoalState) | (HistoryPage) | (InitializeResult) | (InteractionResult) | (MaintenanceResult) | (RevertResult) | (SessionCloseResult) | (SessionOpenResult) | (SessionState) | (TurnInterruptResult) | (InputSubmitResult) | (TurnSteerResult) | (SessionInterruptResult) };
export type AhpRpcFailure = { "jsonrpc": "2.0"; "id": (RpcId) | (null); "error": RpcError };
export type AhpRpcResponse = (AhpRpcSuccess) | (AhpRpcFailure);
export type InitializedNotification = { "jsonrpc": "2.0"; "method": "initialized"; "params"?: {  } };
export type AhpEventNotification = ({ "jsonrpc": "2.0"; "method": "session/state"; "params": (SourceEnvelope) & (SessionStateEvent) }) | ({ "jsonrpc": "2.0"; "method": "session/metadata"; "params": (SourceEnvelope) & (SessionMetadataEvent) }) | ({ "jsonrpc": "2.0"; "method": "turn/started"; "params": (SourceEnvelope) & (TurnStartedEvent) }) | ({ "jsonrpc": "2.0"; "method": "turn/completed"; "params": (SourceEnvelope) & (TurnCompletedEvent) }) | ({ "jsonrpc": "2.0"; "method": "item/started"; "params": (SourceEnvelope) & (ItemStartedEvent) & ({ "turnId": string }) }) | ({ "jsonrpc": "2.0"; "method": "item/delta"; "params": (SourceEnvelope) & (ItemDeltaEvent) & ({ "turnId": string }) }) | ({ "jsonrpc": "2.0"; "method": "item/completed"; "params": (SourceEnvelope) & (ItemCompletedEvent) & ({ "turnId": string }) }) | ({ "jsonrpc": "2.0"; "method": "usage/updated"; "params": (SourceEnvelope) & (UsageUpdatedEvent) }) | ({ "jsonrpc": "2.0"; "method": "interaction/requested"; "params": (SourceEnvelope) & (InteractionRequestedEvent) }) | ({ "jsonrpc": "2.0"; "method": "interaction/resolved"; "params": (SourceEnvelope) & (InteractionResolvedEvent) }) | ({ "jsonrpc": "2.0"; "method": "notice"; "params": (SourceEnvelope) & (NoticeEvent) }) | ({ "jsonrpc": "2.0"; "method": "extension"; "params": (SourceEnvelope) & (ExtensionEvent) }) | ({ "jsonrpc": "2.0"; "method": "submission/bound"; "params": (SourceEnvelope) & (SubmissionBoundEvent) }) | ({ "jsonrpc": "2.0"; "method": "submission/status"; "params": (SourceEnvelope) & (SubmissionStatusEvent) });
export type AhpRpcNotification = (InitializedNotification) | (AhpEventNotification);
export type AhpRpcMessage = (AhpRpcRequest) | (AhpRpcResponse) | (AhpRpcNotification);
export type FileChangeMaterial = ({ "format": "unified"; "patch": string }) | ({ "format": "text"; "scope": "file" | "fragment"; "oldText": (string) | (null); "newText": string; "oldStartLine"?: number; "newStartLine"?: number }) | ({ "format": "unavailable"; "reason": "notProvided" | "binary" | "tooLarge" | "unsupported" });
export type FileChange = { "path": string; "oldPath"?: string; "operation": "add" | "modify" | "delete" | "rename" | "unknown"; "materials": Array<FileChangeMaterial>; "completeness": "complete" | "partial"; "stats"?: { "added": number; "removed": number; "accuracy": "exact" | "partial" } };
export type ToolImageOutput = { "kind": "generated" | "view"; "data"?: string; "mimeType"?: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; "path"?: string; "fileId"?: string; "revisedPrompt"?: string; "blob"?: { "sha256": string; "mimeType": "image/png" | "image/jpeg" | "image/webp" | "image/gif"; "bytes": number }; "unavailable"?: "notProvided" | "unsupportedType" | "storageFailed" | "pathForbidden" };
export type SessionMetadata = { "title"?: (string) | (null) };
export type SessionMetadataEvent = { "type": "session/metadata"; "payload": SessionMetadata };
export type SubmissionAcceptance = ({ "submissionId": string; "accepted": true; "disposition": "started"; "receipt"?: JsonObject; "turnId": string }) | ({ "submissionId": string; "accepted": true; "disposition": "joined"; "receipt"?: JsonObject; "turnId": string }) | ({ "submissionId": string; "accepted": true; "disposition": "queued"; "receipt": JsonObject }) | ({ "submissionId": string; "accepted": true; "disposition": "accepted"; "receipt"?: JsonObject });
export type SubmissionBound = { "submissionId": string; "turnId": string };
export type SubmissionBoundEvent = { "type": "submission/bound"; "payload": SubmissionBound };
export type SubmissionDispatch = { "submissionId": string; "disposition": "dispatched" };
export type SubmissionStatus = { "submissionId": string; "status": "submitted" | "dispatched" | "accepted" | "queued" | "rejected" | "unknown"; "error"?: HarnessError; "receipt"?: JsonObject };
export type SubmissionStatusEvent = { "type": "submission/status"; "payload": SubmissionStatus };
export type SessionInterruptParams = { "requestId": string; "sessionId": string; "cancelQueued"?: boolean };
export type SessionInterruptResult = { "accepted": true; "stillQueued"?: Array<string>; "cancelled"?: Array<string> };
export type SessionInterruptRpcRequest = { "jsonrpc": "2.0"; "id": RpcId; "method": "session/interrupt"; "params": SessionInterruptParams };
export interface AhpRequestMap {
  "initialize": InitializeParams;
  "session/open": SessionOpenParams;
  "session/close": SessionCloseParams;
  "session/config/set": SessionConfigParams;
  "session/revert": SessionRevertParams;
  "history/read": HistoryReadParams;
  "input/submit": InputSubmitParams;
  "turn/steer": TurnSteerParams;
  "turn/interrupt": TurnInterruptParams;
  "interaction/respond": InteractionRespondParams;
  "interaction/cancel": InteractionCancelParams;
  "goal/set": GoalSetParams;
  "goal/clear": GoalClearParams;
  "compact/start": CompactStartParams;
  "review/start": ReviewStartParams;
  "session/interrupt": SessionInterruptParams;
}
export interface AhpResultMap {
  "initialize": InitializeResult;
  "session/open": SessionOpenResult;
  "session/close": SessionCloseResult;
  "session/config/set": SessionState;
  "session/revert": RevertResult;
  "history/read": HistoryPage;
  "input/submit": InputSubmitResult;
  "turn/steer": TurnSteerResult;
  "turn/interrupt": TurnInterruptResult;
  "interaction/respond": InteractionResult;
  "interaction/cancel": InteractionResult;
  "goal/set": GoalState;
  "goal/clear": GoalState;
  "compact/start": MaintenanceResult;
  "review/start": InputSubmitResult;
  "session/interrupt": SessionInterruptResult;
}
export type AhpMethod = keyof AhpRequestMap;
export const AHP_METHODS = [
  "initialize",
  "session/open",
  "session/close",
  "session/config/set",
  "session/revert",
  "history/read",
  "input/submit",
  "turn/steer",
  "turn/interrupt",
  "interaction/respond",
  "interaction/cancel",
  "goal/set",
  "goal/clear",
  "compact/start",
  "review/start",
  "session/interrupt"
] as const;
export const AHP_METHOD_DEFINITIONS = {
  "initialize": [
    "InitializeParams",
    "InitializeResult"
  ],
  "session/open": [
    "SessionOpenParams",
    "SessionOpenResult"
  ],
  "session/close": [
    "SessionCloseParams",
    "SessionCloseResult"
  ],
  "session/config/set": [
    "SessionConfigParams",
    "SessionState"
  ],
  "session/revert": [
    "SessionRevertParams",
    "RevertResult"
  ],
  "history/read": [
    "HistoryReadParams",
    "HistoryPage"
  ],
  "input/submit": [
    "InputSubmitParams",
    "InputSubmitResult"
  ],
  "turn/steer": [
    "TurnSteerParams",
    "TurnSteerResult"
  ],
  "turn/interrupt": [
    "TurnInterruptParams",
    "TurnInterruptResult"
  ],
  "interaction/respond": [
    "InteractionRespondParams",
    "InteractionResult"
  ],
  "interaction/cancel": [
    "InteractionCancelParams",
    "InteractionResult"
  ],
  "goal/set": [
    "GoalSetParams",
    "GoalState"
  ],
  "goal/clear": [
    "GoalClearParams",
    "GoalState"
  ],
  "compact/start": [
    "CompactStartParams",
    "MaintenanceResult"
  ],
  "review/start": [
    "ReviewStartParams",
    "InputSubmitResult"
  ],
  "session/interrupt": [
    "SessionInterruptParams",
    "SessionInterruptResult"
  ]
} as const;
