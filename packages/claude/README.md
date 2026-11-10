# @anureo/adapter-claude

Adapter connecting the Anureo SDK to the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It drives the Claude SDK's streaming `query()` interface and maps messages, permissions, tool use, and subagents onto the unified AHP session model.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/adapter-claude`.

## Usage

This shows the revised workspace API, not the published 0.2.0 API. Root migration and local
validation are complete.

```typescript
import { createClient } from '@anureo/sdk'
import { createClaudeAdapter } from '@anureo/adapter-claude'

const client = await createClient({
  adapter: createClaudeAdapter({
    // Claude must run under an isolated, explicit CLAUDE_CONFIG_DIR…
    stateDir: '/var/my-host/claude-state',
    // …or deliberately reuse the CLI's login/profile home:
    // defaultHome: true,
  }),
  identity: { adapterId: 'claude', runtimeConfigId: 'local' },
})
// Use client.sessions.create(...) and session.submit(...); dispose in finally.
```

Initialization fails with `HARNESS_CONFIG_INVALID` unless one of `stateDir` (or `env.CLAUDE_CONFIG_DIR`), `defaultHome`, or an injected `queryFactory` is provided — accidental reuse of a user's default Claude home is never silent.

## Capabilities

What the adapter can offer depends on the options it was constructed with:

| Condition | Unlocks |
|---|---|
| A session store is present (`stateDir`, or injected `sessionStore`) | `session.resume`, fork (`before`/`through`), `revert: conversation`, `history` |
| `enableFileCheckpointing: true` | `revert: files` (and `both` together with a store), backed by the SDK's checkpoint/rewind support |

Revert requires no active execution or pending input. Those cases, and input,
configuration changes or another revert attempted during a revert, reject with
`SESSION_BUSY`. Finish or interrupt the current execution and await its terminal
result before reverting.

The revised workspace exposes native input delivery (`native` → `next`,
`afterTurn` → `later`) and **session-scoped** interrupt with pending-input receipts.
Exact-turn steer and interrupt are not declared. It also supports `approval` / `userInput` / `elicitation` interactions, nested subagent events, and MCP (stdio + http, with `form`/`url` elicitation). Output schemas are not offered. The fixed SDK is 0.3.265; multi-message
correlation and interrupt mapping have dedicated fixture and transport coverage.

Additional guidance uses another `await session.submit({ input, delivery: 'native' })`.
It may join the same execution or reach a later one. See the
[Claude example](../../docs/native-harness-lifecycle.md#42-claude追加会话指导与精确-steer-分开).

## Exports

| Entry | Contents |
|---|---|
| `@anureo/adapter-claude` | `createClaudeAdapter`, `ClaudeNativeAdapter`, `ClaudeAdapterOptions`, `ClaudeQuery`, `ClaudeQueryFactory`, `createClaudeCatalogSession` |
| `@anureo/adapter-claude/store` | `FileSessionStore` |
| `@anureo/adapter-claude/catalog` | `createClaudeCatalogSession` |

### FileSessionStore

Resume, fork, and history need the official `SessionStore` contract. `FileSessionStore` implements it with one JSON file per session under a directory you own, using the SDK's opaque entries — it never parses Claude's private transcript files. Concurrent writers coordinate through lock files whose abandoned locks are reclaimed only after proving the owning process is gone.

### Model catalog

`createClaudeCatalogSession(options)` opens a prompt-less connection to list supported models (including effort levels per model) without creating a product session; `adapter.listModels(cwd)` is the one-shot variant.

## Configuration options

Session-scoped config options exposed through AHP: `model`, `permissionMode` (`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto`), `effort` (`low`–`max`, per-model support reported by the catalog), `fastMode`, and `maxThinkingTokens`. Text and image inputs are supported.

For script-based Claude executables, `executableRuntime: 'node' | 'bun' | 'deno'` names the interpreter; native binaries need none. Tests can inject `queryFactory` and the store/history functions — that is how `@anureo/conformance` drives this adapter without credentials.

## Development

```sh
cd packages/claude
bun run typecheck
bun test src
```

## Documentation

- [Architecture](../../docs/architecture.md) — adapters' role in the SDK (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)

## AHP v1 lifecycle revision

The lifecycle design updates AHP v1 and package root entries in place.
The root implementation and tests use the revised lifecycle; parallel versioned
entries have been removed. Local conformance and clean-install checks have passed. Native input priority and multi-message correlation must be verified for the pinned SDK; session input delivery is distinct from atomic exact-turn steering.
See the [design and implementation plan](../../docs/native-harness-lifecycle.md).
