# Anureo Harness Protocol (AHP) v1

> Status: Published. This document specifies AHP v1 as shipped in
> `@anureo/protocol` 0.2.0. The normative source of truth is the JSON Schema
> at `packages/protocol/schema/v1/ahp.schema.json` (`$id:
> urn:anureo:ahp:v1`); TypeScript types, the method table, and runtime
> validation are generated from that schema. This document describes the
> contract as implemented; it does not imply that every backend supports
> every optional capability. A [Chinese reference translation](ahp-v1.zh.md)
> is available; if the two disagree, this English document is authoritative.

## Scope

AHP is a harness-side protocol. The caller is a Harness SDK / Host, not a
browser; browser-to-host communication uses a separate `hx.*` product
protocol and is out of scope here. AHP's position among neighboring
protocols (MCP, ACP, AG-UI) is summarized in the repository
[README](../README.md).

Session-level metadata uses `SessionState.metadata?: SessionMetadata` and
the `session/metadata` event: an absent `title` means no update, a string
replaces, `null` clears, and no turn lifecycle semantics are attached.
External AHP v1 peers send it after negotiating the
`x-anureo/session-metadata@1` extension (see
[GOVERNANCE](../GOVERNANCE.md) for the extension registry).

## Versioning, transport, and handshake

AHP v1 uses standard JSON-RPC 2.0. Over stdio, each line is one UTF-8 JSON
object; over WebSocket, each text frame is one object. Request ids are
non-empty strings or integers, and responses must reuse the id.

`initialize` exchanges both parties' capabilities and selects the highest
commonly supported major version. If no common version exists, the peer
reports `PROTOCOL_VERSION_UNSUPPORTED` before any business operation. After
the caller receives a successful result, it sends `initialized`.
Capabilities that are not declared are not supported: adding an optional
field does not bump the major version, while breaking semantic changes
must bump it.

Wire notifications use `method = event.type` and `params = the full
AhpEvent`. `params` retains `type`, `payload`, and the session source
sequence number; `method` and `params.type` must be equal. Interactions
are initiated by the `interaction/requested` notification and may only be
answered by the separate `interaction/respond` or `interaction/cancel`
requests; no JSON-RPC response is required for the notification itself.

The following JSONL messages are validated by the package's documentation
example tests:

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersions":[1],"clientInfo":{"name":"example-host","version":"0.1.0"},"clientCapabilities":{"interactions":["approval"]}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"runtime":{"name":"example","version":"0.1.0","adapter":"example/0.1.0"},"capabilities":{"turn":{"interrupt":true},"interactions":["approval"]}}}
{"jsonrpc":"2.0","method":"initialized"}
{"jsonrpc":"2.0","id":2,"method":"session/open","params":{"requestId":"open-1","mode":"new","binding":{"sessionId":"s1","adapterId":"example","runtimeConfigId":"example-1"},"cwd":"/workspace"}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"requestId":"start-1","sessionId":"s1","turnId":"t1","input":[{"type":"text","text":"Inspect the workspace"}]}}
{"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"s1","streamId":"stream-1","seq":1,"timestamp":"2026-10-26T00:00:00Z","turnId":"t1","type":"turn/started","payload":{"turnId":"t1"}}}
{"jsonrpc":"2.0","method":"interaction/requested","params":{"sessionId":"s1","streamId":"stream-1","seq":2,"timestamp":"2026-10-26T00:00:01Z","turnId":"t1","type":"interaction/requested","payload":{"interactionId":"approve-1","kind":"approval","options":[{"id":"allow","label":"Allow once","semantic":"allowOnce"},{"id":"deny","label":"Deny","semantic":"deny"}]}}}
{"jsonrpc":"2.0","id":4,"method":"interaction/respond","params":{"requestId":"respond-1","sessionId":"s1","interactionId":"approve-1","response":{"kind":"approval","optionId":"deny"}}}
{"jsonrpc":"2.0","method":"interaction/resolved","params":{"sessionId":"s1","streamId":"stream-1","seq":3,"timestamp":"2026-10-26T00:00:02Z","turnId":"t1","type":"interaction/resolved","payload":{"interactionId":"approve-1","outcome":"responded"}}}
{"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"s1","streamId":"stream-1","seq":4,"timestamp":"2026-10-26T00:00:03Z","turnId":"t1","type":"turn/completed","payload":{"turnId":"t1","status":"completed"}}}
```

## Capabilities and methods

Capability declaration is `Capabilities`. It covers session
resume/fork/revert/history, turn steer/interrupt/outputSchema and input
modalities, goal actions, review, compaction, nested subagents, MCP,
interaction kinds, configuration option schemas, and explicit extensions.
Upper layers select by capability; they must not guess from provider
names. `supportsCapability` returns `false` for absent and empty lists.

| Method | Params | Result and constraints |
| --- | --- | --- |
| initialize | InitializeParams | InitializeResult; major-version negotiation |
| session/open | SessionOpenParams | SessionOpenResult; new/resume/fork; binding is immutable |
| session/close | SessionCloseParams | SessionCloseResult; only idle sessions may be released |
| session/config/set | SessionConfigParams | SessionState; patches validated against the option schema |
| session/revert | SessionRevertParams | RevertResult; every requested scope must be available; the actual effect is reported faithfully |
| history/read | HistoryReadParams | HistoryPage; authoritative item snapshots, no raw delta sequence numbers |
| turn/start | TurnStartParams | TurnStartResult; the caller allocates turnId first; no implicit queuing |
| turn/steer | TurnSteerParams | TurnSteerResult; expectedTurnId must match the current turn exactly |
| turn/interrupt | TurnInterruptParams | TurnInterruptResult; acceptance does not mean the turn has ended |
| interaction/respond | InteractionRespondParams | InteractionResult; approvals only accept offered optionIds |
| interaction/cancel | InteractionCancelParams | InteractionResult; explicit non-authoritative cancellation |
| goal/set, goal/clear | GoalSetParams, GoalClearParams | GoalState; unsupported by default; goals are never simulated |
| compact/start | CompactStartParams | MaintenanceResult; no turn may start during maintenance |
| review/start | ReviewStartParams | TurnStartResult; shares mutual exclusion and lifecycle with normal turns |

The `requestId` of a business request correlates only with that native
session operation; cross-process idempotency is not promised — durable
idempotency is provided by the host's operation ledger. `resume` requires
`binding.nativeRef`; `fork` requires `fork.sourceSessionId` and
`boundary` (before/through). Revert scope is conversation/files/both; a
peer that cannot honor the full scope must reject before executing. A
failure after partial execution reports the actual effect and
`outcomeUnknown`; atomic rollback is not claimed.

## Content and events

Input is text/image/file; file references are explicit URIs — arbitrary
text is never inferred as a file operation. Items are one of ten kinds:
userMessage, agentMessage, reasoning, plan, toolCall, subagent, review,
compaction, hook, notice. `agentMessage.phase` distinguishes
commentary/final; tool kind/input/output and subagent subagentId/state
are expressed structurally; titles are display-only.

Each session has at most one active turn. Each started turn has exactly
one terminal `turn/completed` state (completed/interrupted/failed).
`item/completed` carries the full authoritative content and replaces
streamed content rather than being appended again. Identity is
`(sessionId, turnId, itemId)`; indexing by provider itemId alone is not
valid.

Each `session/open` allocates a `streamId`, and the source `seq`
increments consecutively from 1; opening again allocates a new
`streamId`. The host's durable `hostSeq` is a separate sequence and is
never mixed with source seq. Only sources that explicitly declare replay
may be replayed; history snapshots must not masquerade as original
real-time events. Usage must state provider/scope/source=native;
unavailable counters are omitted rather than reported as zero or faked
via cumulative deltas.

Standard events are session/state, turn/started, turn/completed,
item/started, item/delta, item/completed, usage/updated,
interaction/requested, interaction/resolved, and notice. Unknown native
notifications are converted to notice; unknown items are preserved as
`toolCall.kind = other` with safely publishable nativeType/raw. Unknown
requests return method-not-found and must never default to approval.
Schema validation at the protocol layer does not replace the SDK's
stateful lifecycle checks.

## Interactions and privacy

There are four interaction kinds: approval (options), userInput
(questions with optional answer schemas), elicitation (form/url with
schema), and dynamicTool (toolName/arguments with an output schema).
`validateInteractionResponse` validates kind, optionId, required
questions and choice ranges, and any attached JSON Schema. Racy
responses, timeouts, and single resolution are handled by the SDK's
interaction manager.

`resolved.outcome` is responded/cancelled/expired/unknown. `responded`
means the native answer was submitted; `unknown` means the local side
can no longer answer safely and must not be interpreted as native
approval or cancellation. Timeouts, disconnects, and turn termination
never imply authorization.

`privatePayload` exists only in memory. `publicEvent`/`publicInteraction`
produce a public projection without modifying the original object:
`privatePayload` is removed entirely (replaced by
`privatePayloadAvailable`). Secret-marked answers, authentication
fields, and headers/env must never be persisted. Query and fragment are
stripped from authorization URLs in public text; the full address is
returned only through the host's private authorization read. Logs and
errors keep only validation paths and error keywords, never parameter
values.

## Errors and extensions

`HarnessError` carries a stable code/message/retryable/outcomeUnknown
and optional details. If a disconnect after sending leaves execution
uncertain, `outcomeUnknown` is true and automatic resending is
forbidden. Only an explicitly not-executed method-not-found may be used
for verified alias fallback; destructive methods must not be used to
probe capabilities.

Extensions use `x-<vendor>/<feature>` with an independent version and
must be declared in both parties' capabilities. AHP's extension event
points `payload.name` at the negotiated namespace and `payload.version`
at the extension version. Unknown optional fields may be preserved, but
must not impose new required semantics on older implementations; unknown
required features are treated as unsupported.

## Development and conformance

```sh
cd packages/protocol
bun run generate
bun run generate:check
bun run typecheck
bun test tests
```

The generator rejects unsupported type vocabulary and never silently
emits `any`. Structural validation of the schema uses a pinned Ajv
8.20.0 with JSON Schema draft 2020-12; business types and method
mappings are generated from the same schema. The core and every adapter
must additionally pass the lifecycle/recovery conformance suite — schema
tests alone do not prove runtime correctness. See
[CONTRIBUTING](../CONTRIBUTING.md) for the full validation entry points.

## File-change materials

`toolCall.fileChanges?: FileChange[]` is an optional AHP v1 extension;
older events remain valid. Each entry carries `path`, optional
`oldPath`, `operation`, `materials`, and `completeness`. Materials are
either the original `unified` text, old/new text with
`scope: file|fragment`, or `unavailable` with a reason. Fragments carry
1-based `oldStartLine`/`newStartLine` only when the native side supplies
locations. `oldText: null` denotes evidenced creation; an empty string
denotes pre-existing empty content. `stats.accuracy` and `completeness`
describe the materials; whether execution succeeded is still determined
by the native `item.status`.

`item/delta` with `kind: patch` carries a full item snapshot in `value`;
consumers validate the item, its id, and the existing kinds in the
current turn, then replace wholesale. `patch.text` exists only for
legacy fileChange execution logs and is not a unified patch. Codex's
`item/fileChange/outputDelta` uses `kind: output`.
