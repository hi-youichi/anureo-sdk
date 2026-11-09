# Anureo SDK

Connect Codex, Claude, ACP agents, and external AHP harnesses through a unified host interface. Anureo SDK provides the Anureo Harness Protocol (AHP), a shared runtime, four backend adapters, and conformance tests, independently of Cowork's application orchestration layer.

> The seven packages are published to npm under the `@anureo` scope. AHP is vendor-neutral: the SDK treats every backend — Codex, Claude, ACP agents, external AHP harnesses — identically, and the conformance suite is the arbiter.

## Getting started

```sh
npm install @anureo/sdk @anureo/adapter-codex
```

`@anureo/sdk` is the runtime; pick one or more adapters (`@anureo/adapter-codex`, `@anureo/adapter-claude`, `@anureo/adapter-acp`, `@anureo/adapter-ahp`) plus `@anureo/protocol` if you need the wire contract directly. Everything requires Node.js 22+.

To work on this repository itself, you also need npm installed with Node.js and Bun 1.4.2+:

```sh
bun install --frozen-lockfile
bun run example:native
```

The native lifecycle example uses a scripted backend and requires no model account or credentials. Real backends require their respective executables, configuration, and authentication.

## Usage example

The native lifecycle revision updates **AHP v1 in place**, through package root
entries. The following shows the revised workspace API; it is not the published
0.2.0 API. Root-entry migration and local adapter/packaging validation are complete.
See the [design and implementation plan](docs/native-harness-lifecycle.md).

`submit()` waits until the input is reliably associated with an actual execution
and returns a `Turn`. `steer()` waits for confirmation that guidance was appended
to that exact execution. `result()` waits for its terminal result. There is no
public `Submission` or mandatory `accepted()` / `turn()` chain.

This example requires a configured Codex executable and a profile supporting
exact-turn steer. Guidance must arrive while the execution is active; a stale
target rejects instead of silently starting another execution.

```typescript
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

const client = await createClient({
  adapter: createCodexAdapter({ command: 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})
try {
  const session = await client.sessions.create({ cwd: process.cwd() })
  const turn = await session.submit({
    input: 'Investigate and fix the failing login tests.',
    delivery: 'native',
  })
  // In an application, this is triggered by the user while work is running.
  await turn.steer({ input: 'Keep all changes inside the authentication module.' })
  const result = await turn.result()
  console.log(result.status, result.text)
  await session.close()
} finally {
  await client.dispose()
}
```

Claude receives additional session input through another `session.submit()`;
its native input priority does not provide Codex's atomic target guarantee.
The returned handles may identify the same execution or different executions.
See the [Claude example and await semantics](docs/native-harness-lifecycle.md#4-建议的输入与控制-api).
The [scripted native lifecycle example](examples/native-lifecycle.ts) demonstrates
submit, exact steer and result without a model account: `bun run example:native`.

## Packages

| Package | Description |
|---|---|
| `@anureo/protocol` | AHP v1 JSON Schema, TypeScript types, and validation |
| `@anureo/sdk` | `createClient`, `Session`, `Turn`, and shared runtime components |
| `@anureo/adapter-codex` | Codex app-server adapter |
| `@anureo/adapter-claude` | Adapter for the official Claude Agent SDK |
| `@anureo/adapter-acp` | Standard ACP agent adapter |
| `@anureo/adapter-ahp` | Adapter for external AHP harnesses over stdio or WebSocket |
| `@anureo/conformance` | Shared conformance tests and scripted fixtures |

## Why AHP?

AHP sits at the harness layer: one host, many agent backends, uniform
approvals, history, fork/revert, and steering. It interoperates with —
instead of competing against — the neighboring protocols:

| Protocol | Layer | Relationship to AHP |
|---|---|---|
| [MCP](https://modelcontextprotocol.io) | Tools & resources | MCP tool calls ride inside AHP `toolCall` items; the host may proxy MCP servers while turns stay AHP-shaped |
| [ACP](https://agentclientprotocol.com) | Editor ↔ agent | `@anureo/adapter-acp` brings any ACP agent behind AHP — an interop proof, not a fork |
| AG-UI and UI event streams | UI rendering | AHP adds approvals, goals, fork/revert, steering, and replayable history with source sequence numbers |

## Development and validation

```sh
bun run check:boundaries
bun run generate:check
bun run protocol:check
bun run typecheck
bun run typecheck:tooling
bun test --timeout 15000 packages scripts/harness-sdk
bun run verify:pack
```

`bun run build` produces seven standalone `.tgz` packages in `artifacts/`. `verify:pack` also installs them in a clean directory and runs strict NodeNext type checks, examples under both Node and Bun, and ACP/AHP exchanges over actual stdio connections. Build artifacts and dependency directories are excluded from version control.

CI validates Windows, macOS, and Linux on every push; all three platforms are green on the released revision.

## Documentation

- [AHP v1 specification](spec/ahp-v1.md) — the revised v1 lifecycle and wire contract (English); a [Chinese reference translation](spec/ahp-v1.zh.md) is available.
- [Governance](GOVERNANCE.md) — versioning, the extension registry, and conformance policy.
- [Contributing](CONTRIBUTING.md) — setup, validation commands, and the adapter checklist.
- [Security](SECURITY.md) — the reporting channel and the redaction/secret-handling invariants.
- [Changelog](CHANGELOG.md) — release history with BREAKING markers for the 0.x line.

The following prose documents are currently in Chinese:

- [Architecture](docs/architecture.md): layers, interfaces, event flow, and approval sequences.
- [Development and migration notes](docs/development.md): implementation scope, naming changes, and validation records.
- [Extraction plan](extraction-plan.md): the original migration sequence, public release goals, and pending decisions.

The [upstream provenance manifest](docs/upstream-provenance.json) records the source revision, source file SHA-256 hashes, and destination paths.
