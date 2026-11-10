# Anureo SDK

Connect Codex, Claude, ACP agents, and external AHP harnesses through a unified host interface. Anureo SDK provides the Anureo Harness Protocol (AHP), a shared runtime, four backend adapters, and conformance tests, independently of Cowork's application orchestration layer.

> The seven packages are published to npm under the `@anureo` scope. AHP is vendor-neutral: the SDK treats every backend — Codex, Claude, ACP agents, external AHP harnesses — identically, and the conformance suite is the arbiter.

The workspace also includes [`@anureo/workflow`](packages/workflow/README.md),
pending publication with the revised lifecycle API. It exports only `agent`,
`parallel`, and `pipeline` for direct imports from ordinary TypeScript workflows.
Clients and function arguments are explicit; each agent call uses a fresh Session.
Run `bun run example:workflow` for a Codex arithmetic example that prints
all agent inputs and outputs. See the [migration plan](docs/workflow-primitives-plan.md).
For a real-model example, run `bun run example:readability` to review the three
primitive implementations with local Codex. See the [usage and report format](docs/readability-review-example.md).

## Getting started

```sh
npm install @anureo/sdk @anureo/adapter-codex
```

`@anureo/sdk` is the runtime; pick one or more adapters (`@anureo/adapter-codex`, `@anureo/adapter-claude`, `@anureo/adapter-acp`, `@anureo/adapter-ahp`) plus `@anureo/protocol` if you need the wire contract directly. Everything requires Node.js 22+.

To work on this repository itself, you also need npm installed with Node.js and Bun 1.4.2+:

```sh
bun install --frozen-lockfile
bun run example
```

The greeting example submits one prompt through the Codex adapter. It requires
a configured, authenticated Codex CLI on PATH; `CODEX_BIN` can override its path.

## Usage example

The following uses the revised workspace API, which differs from the published
0.2.0 API. Create a client with an existing adapter, open a session, submit input,
and await the result.

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
  })
  const result = await turn.result()
  console.log(result.status, result.text)
  await session.close()
} finally {
  await client.dispose()
}
```

The [DSH example](examples/dsh.ts) drives `dsh --profile acp` through
`createDshAcpAdapter()`: it streams one turn, answers DSH's per-call
`allow_once` / `reject_once` permission requests, and reports stop notices. Run it
with `bun run example:dsh`; it requires `dsh` 0.2.2+ (running on Node.js >= 24.9)
and credentials under `$DSH_HOME` (defaults to `~/.dsh`).

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
| `@anureo/workflow` | Agent, parallel, and pipeline primitives for TypeScript workflows (workspace; pending publication) |

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
bun run generate:check
bun run protocol:check
bun run typecheck
bun run typecheck:tooling
bun test --timeout 15000 packages
```

CI validates Windows, macOS, and Linux on every push; all three platforms are green on the released revision.

## Documentation

- [AHP v1 specification](spec/ahp-v1.md) — the revised v1 lifecycle and wire contract (English); a [Chinese reference translation](spec/ahp-v1.zh.md) is available.
- [Governance](GOVERNANCE.md) — versioning, the extension registry, and conformance policy.
- [Contributing](CONTRIBUTING.md) — setup, validation commands, and the adapter checklist.
- [Security](SECURITY.md) — the reporting channel and the redaction/secret-handling invariants.
- [Changelog](CHANGELOG.md) — release history with BREAKING markers for the 0.x line.

The following prose documents are currently in Chinese:

- [Architecture](docs/architecture.md): layers, interfaces, event flow, and approval sequences.
- [Workflow primitive migration plan](docs/workflow-primitives-plan.md): direct TypeScript imports, the three-function API, and migration from the retired runtime/MCP design.
- [Claude Code CLI reverse engineering](docs/research/claude-code/README.md): the pinned executable, stream controls, Workflow runtime, evidence, and reproduction scripts.
- [Readability problem summary](docs/readability-summary.md): the main reading obstacles, representative code, and design-pattern choices.
- [Readability improvement plan](docs/readability-plan.md): file-by-file and function-by-function proposals, design-pattern choices, and implementation checks.
- [Development and migration notes](docs/development.md): implementation scope, naming changes, and validation records.
- [Extraction plan](extraction-plan.md): the original migration sequence, public release goals, and pending decisions.

The [upstream provenance manifest](docs/upstream-provenance.json) records the source revision, source file SHA-256 hashes, and destination paths.
