# @anureo/adapter-claude

Adapter connecting the Anureo SDK to the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It drives the Claude SDK's streaming `query()` interface and maps messages, permissions, tool use, and subagents onto the unified AHP session model.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/adapter-claude`.

## Usage

This example uses the revised workspace API described under [Capabilities](#capabilities).

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

The revised workspace API shown here differs from the published 0.2.0 API.
The adapter pins `@anthropic-ai/claude-agent-sdk` to 0.3.265.

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
Exact-turn steer and interrupt are not declared. It also supports `approval` / `userInput` / `elicitation` interactions, nested subagent events, MCP (stdio + http, with `form`/`url` elicitation), and `turn.outputSchema`.

Validation covers two layers:

- Injected Query fixtures exercise native input priority mapping, multi-message
  correlation, and session interrupt mapping, including pending-input receipts.
- Transport tests run the pinned official SDK against a simulated child executable
  to check single-input correlation.

Validation of native input priority, multi-message correlation, and interruption
behavior with real Claude execution remains unconfirmed by these tests.

Additional guidance uses another `await session.submit({ input, delivery: 'native' })`.
It may join the same execution or reach a later one. Session input delivery is
distinct from atomic exact-turn steering. See the
[Claude example](../../docs/native-harness-lifecycle.md#42-claude追加会话指导与精确-steer-分开).

## Structured output

Pass a self-contained draft-07 JSON Schema with `type: 'object'` at its root:

```typescript
const turn = await session.submit({
  input: 'Return the number of matching files.',
  outputSchema: {
    type: 'object',
    properties: { count: { type: 'integer', minimum: 0 } },
    required: ['count'],
    additionalProperties: false,
  },
})
const result = await turn.result()
if (result.status === 'completed') {
  const data = JSON.parse(result.text)
  console.log(data.count)
}
```

The adapter passes the schema to the official Agent SDK's `outputFormat` option.
The SDK handles tool use, output validation and correction attempts. The adapter
validates the returned `structured_output` with draft-07 AJV and publishes its
JSON serialization as the final `agentMessage` and `TurnResult.text`. Intermediate
prose remains commentary. `format` annotations are accepted without enforcement;
asynchronous schemas, external references and newer schema dialects are rejected
with `INVALID_PARAMS` before input dispatch.

The pinned SDK sets output format at Query initialization. Equal schemas (object
key order does not matter) reuse the existing Query, including native overlapping
input. Changing or omitting the schema closes and drains that Query, then starts
another with the same native session ID and the latest session configuration.
After an execution, the new Query resumes the saved conversation. This adds
process startup cost when switching formats. A switch requires no active execution,
pending inputs or configuration changes; otherwise it rejects with `SESSION_BUSY`,
including for `delivery: 'afterTurn'`. Omit `outputSchema` to return to ordinary text;
the previous schema is never implicitly inherited. Input and configuration changes
are also refused while a format switch is in progress.

Missing or invalid structured output fails the turn with
`CLAUDE_STRUCTURED_OUTPUT_MISSING` or `CLAUDE_STRUCTURED_OUTPUT_INVALID`.
Native correction-limit exhaustion maps to
`CLAUDE_STRUCTURED_OUTPUT_RETRIES_EXCEEDED`; interruption remains `interrupted`.
The adapter never resubmits the task to repair output or recover a failed switch.
When a session store is available, history also exposes saved validated output
attachments linked to surviving `StructuredOutput` calls, including after resume
or fork.

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

See the [design and implementation plan](../../docs/native-harness-lifecycle.md).
