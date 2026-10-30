# @anureo/adapter-codex

Adapter connecting the Anureo SDK to the [Codex](https://github.com/openai/codex) CLI's `app-server` mode over stdio JSONL. It spawns the binary, speaks Codex's native protocol, and maps requests, events, items, and usage onto the unified AHP session model.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/adapter-codex`.

## Usage

```typescript
import { createHarnessRuntime } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

const runtime = createHarnessRuntime(createCodexAdapter({
  command: 'codex',        // required; args default to ['app-server']
  cwd: '/workspace',
  env: { OPENAI_API_KEY: '...' },
}))
```

The adapter probes the binary's version during initialization (or trusts an explicit `options.version` from a host probe) and derives its capabilities from a native behavior profile.

## Version profiles

Codex's native protocol changes between releases. The adapter selects the newest profile the reported version reaches:

| Profile since | Native methods used |
|---|---|
| `0.148.0` | `thread/read` turns, `thread/rollback` revert, history from turns, per-turn settings |
| `0.164.0` | `thread/turns/list`, `thread/revert(beforeTurnId)`, paged `thread/items/list`, live `thread/settings/update` |

- Versions `0.148.0` and `0.164.0` are **verified** against the pinned native schemas in [`protocol/`](protocol/) — `bun run protocol:check` (also wired as the workspace-level `protocol:check`) validates their hashes and provenance on every run.
- Any other version runs on the nearest profile but is reported as unverified; optional native methods that the runtime rejects as method-not-found are closed at call time, not guessed from the version number.
- Below `0.148.0` nothing is known about the native schema: only the safe baseline capability set is published.

Use `resolveCodexProfile(version)` and `codexCapabilities(version)` to inspect the mapping without spawning a process.

## Exports

| Entry | Contents |
|---|---|
| `@anureo/adapter-codex` | `createCodexAdapter`, `CodexAdapterOptions`, `CodexProfile`, `resolveCodexProfile`, `codexCapabilities`, `createCodexCatalogSession`, `CodexModel`, `CodexJsonlClient`, `CodexRpcError`, `mapItems`, `mapUsage` |
| `@anureo/adapter-codex/jsonl` | The low-level JSONL client over the child process |
| `@anureo/adapter-codex/mapping` | Native record → AHP item/usage mapping helpers |
| `@anureo/adapter-codex/catalog` | Model catalog session (`createCodexCatalogSession`) |

`CodexAdapterOptions` extends the JSONL options (`timeoutMs`, `maxFrameBytes`, `maxPending`, `maxServerRequests`) with `command`, `args`, `cwd`, `env`, `version`, `processFactory` (for injected transports and tests), `diagnostic`, and `maxHistoryItems`.

## Configuration options

The adapter exposes session-scoped config options through AHP: `permissionMode` (`read-only` / `agent` / `agent-full-access`, mapped onto Codex approval policies and sandboxes), `model`, `effort`, `summary`, `approvalPolicy`, and `fastMode` (mapped to Codex's `priority` service tier). Turn-level overrides are supported for model, effort, summary, approval/sandbox policy, and service tier.

## Development

```sh
cd packages/codex
bun run typecheck
bun test tests
bun run protocol:check   # verify pinned native schema hashes and mappings
bun run smoke            # optional live smoke against a local binary
```

## Documentation

- [Architecture](../../docs/architecture.md) — adapters' role in the SDK (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)
