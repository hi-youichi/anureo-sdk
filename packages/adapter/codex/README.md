# @anureo/adapter-codex

Adapter connecting the Anureo SDK to the [Codex](https://github.com/openai/codex) CLI's `app-server` mode over stdio JSONL. It spawns the binary, speaks Codex's native protocol, and maps requests, events, items, and usage onto the unified AHP session model.

> Part of the [Anureo SDK workspace](../../../README.md). Install with `npm install @anureo/adapter-codex`.

## Usage

This shows the revised workspace API, not the published 0.2.0 API. The lifecycle
revision updates AHP v1 and package root entries in place. The root implementation
and tests use the revised lifecycle; parallel versioned entries have been removed.
Root migration and local validation are complete, including passing local
conformance and clean-install checks.

```typescript
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

const client = await createClient({
  adapter: createCodexAdapter({
    command: 'codex',        // required; args default to ['app-server']
    cwd: '/workspace',
    env: { OPENAI_API_KEY: '...' },
  }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})
// Use client.sessions.create(...) and session.submit(...); dispose in finally.
```

The adapter probes the binary's version during initialization (or trusts an explicit `options.version` from a host probe) and derives its capabilities from a native behavior profile.

## Version profiles

Codex's native protocol changes between releases. The adapter selects the newest profile whose minimum version is no higher than the reported version. Below `0.148.0`, nothing is known about the native schema: only the safe baseline capability set is published.

| Profile since | Native methods used |
|---|---|
| `0.148.0` | `thread/read` turns, `thread/rollback` revert, history from turns, per-turn settings |
| `0.164.0` | `thread/turns/list`, `thread/revert(beforeTurnId)`, paged `thread/items/list`, live `thread/settings/update` |

- Versions `0.148.0` and `0.164.0` are **verified** against the pinned native schemas in [`protocol/`](protocol/) — `bun run protocol:check` (also wired as the workspace-level `protocol:check`) validates their hashes and provenance on every run.
- Any other version is reported as unverified; optional native methods that the runtime rejects as method-not-found are closed at call time, not guessed from the version number.

Use `resolveCodexProfile(version)` and `codexCapabilities(version)` to inspect the mapping without spawning a process.

## Exports

| Entry | Contents |
|---|---|
| `@anureo/adapter-codex` | `createCodexAdapter`, `CodexAdapterOptions`, `CodexProfile`, `resolveCodexProfile`, `codexCapabilities`, `createCodexCatalogSession`, `CodexModel`, `CodexThreadSummary`, `CodexThreadListParams`, `CodexThreadPage`, `CodexJsonlClient`, `CodexRpcError`, `mapItems`, `mapUsage` |
| `@anureo/adapter-codex/jsonl` | The low-level JSONL client over the child process |
| `@anureo/adapter-codex/mapping` | Native record → AHP item/usage mapping helpers |
| `@anureo/adapter-codex/catalog` | Model catalog session (`createCodexCatalogSession`) |

`CodexModel` preserves the native ID and display name, optional picker `description`, `inputModalities`, default/hidden flags, supported `efforts` with descriptions, `defaultEffort`, and `serviceTiers`. These describe discovery results, not account prices, measured quality, or the effective settings of a running thread. Applications may use them to build model selection guidance without inferring capability from model names.

`CodexAdapterOptions` extends the JSONL options (`timeoutMs`, `maxFrameBytes`, `maxPending`, `maxServerRequests`) with `command`, `args`, `cwd`, `env`, `version`, `processFactory` (for injected transports and tests), `diagnostic`, and `maxHistoryItems`.

## Configuration options

The adapter exposes session-scoped config options through AHP: `permissionMode` (`read-only` / `agent` / `agent-full-access`, mapped onto Codex approval policies and sandboxes), `model`, `effort`, `summary`, `approvalPolicy`, and `fastMode` (mapped to Codex's `priority` service tier). Turn-level overrides are supported for model, effort, summary, approval/sandbox policy, and service tier.

## Subagent protocol

Codex spawns subagent threads from the model through collab tools (there is no client-side spawn method). The adapter surfaces them on three planes, gated by the `subagents` capability (`events: 'nested'`, plus `threadDiscovery` and `tree` flags per profile):

- **Nested items.** `collabAgentToolCall` items expand into one nested `SubagentItem` per receiver thread (`state`, `task`, `parentItemId`), with raw evidence such as `tool`, `model`, `reasoningEffort`, `senderThreadId` and per-agent `errorMessage`/`resultMessage` under `item.extensions.native`. `subAgentActivity` lifecycle items (`started`/`interacted`/`interrupted`/`completed`, carrying `agentThreadId`/`agentPath`) project into the same vocabulary. Documented singular legacy wire words (`receiverThreadId`, `newThreadId`, `agentStatus`) are tolerated as a fallback.
- **Discovery.** `thread/started` notifications for spawned children surface as a session `notice` event with code `SUBAGENT_THREAD_STARTED`; its `extensions` carry the child's `nativeThreadId`, `parentThreadId`, `agentNickname`, `agentRole` and `forkedFromId`. Spawn children that declare `canAcceptDirectInput: false` (parent-owned Multi-Agent V2) degrade the advertised `input` capability to no delivery — direct input is rejected natively for them, and the mapped error is `SUBAGENT_DIRECT_INPUT_REJECTED` (definite, non-retryable). `turn/interrupt` remains available for such threads.
- **Thread tree.** `adapter.listThreads(params)` pages stored threads with optional relation filters (`parentThreadId` for direct children, `ancestorThreadId` for any-depth descendants — mutually exclusive), `sourceKinds`, `cwd` and cursor pagination, returning `CodexThreadSummary` entries (`parentThreadId`/`agentNickname`/`agentRole` where native supplies them, enriched from locally observed spawns when the page omits them). Review and guardian threads never participate in relation filters (native behavior). Method-not-found downgrades every registered session's `subagents.tree` capability.

Session metadata exposes the same linkage on opened and resumed threads via `snapshot.metadata.extensions` (`parentThreadId`, `agentNickname`, `agentRole`, `forkedFromId`, `nativeSource`). Resumed child threads keep Codex's paginated-history semantics: their history contains only their own turns.

Late native completions (`subAgentActivity` `completed` arriving after the spawning turn completed) keep their original turn attribution; the core admits them as late completions of tracked items instead of rejecting the event stream.

## Native hook events

Synchronous Codex hook runs with an active turn appear as `hook` items.
Session-level runs appear as `NATIVE_HOOK_STARTED` and
`NATIVE_HOOK_COMPLETED` notices. See [Codex App Server](https://learn.chatgpt.com/docs/app-server)
for native notification coverage and [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
for configuration and trust management.

## Code structure

| Source | Responsibility |
| --- | --- |
| [`src/index.ts`](src/index.ts), [`src/adapter.ts`](src/adapter.ts) | Assemble the package exports and manage native App Server sessions. |
| [`src/session.ts`](src/session.ts), [`src/mapping.ts`](src/mapping.ts) | Dispatch session requests and project native turns, items, and hook notifications. |
| [`src/jsonl.ts`](src/jsonl.ts), [`src/profile.ts`](src/profile.ts) | Run the JSON-RPC transport and resolve version-specific native capabilities. |
| [`src/catalog.ts`](src/catalog.ts), [`src/threads.ts`](src/threads.ts) | Discover models and list native threads. |

## Development

```sh
cd packages/adapter/codex
bun run typecheck
bun test tests
bun run protocol:check   # verify pinned native schema hashes and mappings
bun run smoke            # optional live smoke against a local binary
```

## Documentation

- [Architecture](../../../docs/architecture.md) — adapters' role in the SDK (currently in Chinese)
- [AHP v1 protocol](../../../spec/ahp-v1.md)

## AHP v1 lifecycle revision

Use `await turn.steer({ input })` before `await turn.result()` for exact guidance.
The adapter maps the target to native `expectedTurnId`, preserving native target
validation; a stale target rejects. An input receipt alone does not prove that a
new execution has started or completed.

See the [design and implementation plan](../../../draft/docs/native-harness-lifecycle.md).
See the [complete example](../../../README.md#usage-example).
