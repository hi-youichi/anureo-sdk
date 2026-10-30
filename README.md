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
bun run example
```

The example uses a scripted backend and requires no model account or credentials. Real backends require their respective executables, configuration, and authentication.

## Usage example

This example initializes a runtime, opens a session, starts a turn, consumes events, and releases resources. The runnable version is [examples/standalone.ts](examples/standalone.ts). After installing this workspace's dependencies, run it with `bun run example`.

```typescript
import { createHarnessRuntime } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'

const runtime = createHarnessRuntime(createScriptedAdapter())
try {
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'anureo-example', version: '0.2.0' } })
  const session = await runtime.openSession({
    requestId: 'open', mode: 'new', cwd: process.cwd(),
    binding: { sessionId: 'example', adapterId: 'scripted', runtimeConfigId: 'local' },
  })
  // Start consuming events before submitting input to avoid filling the bounded queue.
  const consume = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'item/completed' && event.payload.item.type === 'agentMessage') {
        console.log(event.payload.item.text)
      }
      if (event.type === 'turn/completed') {
        if (event.payload.status !== 'completed') throw new Error(`Turn ended: ${event.payload.status}`)
        return
      }
    }
    throw new Error('Event stream ended without a terminal event')
  })()
  void consume.catch(() => {})
  await session.startTurn({
    requestId: 'start', sessionId: session.binding.sessionId, turnId: 'turn-1',
    input: [{ type: 'text', text: 'Hello from Anureo SDK' }],
  })
  await consume
  await session.close()
} finally {
  await runtime.dispose()
}
```

The example prints `Hello from Anureo SDK`. Here, `createScriptedAdapter()` provides a demo backend without calling a model. To connect a real harness, replace it with the appropriate adapter and supply that adapter's required configuration.

## Packages

| Package | Description |
|---|---|
| `@anureo/protocol` | AHP v1 JSON Schema, TypeScript types, and validation |
| `@anureo/sdk` | `HarnessRuntime`, `HarnessSession`, and shared runtime components |
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

- [AHP v1 specification](spec/ahp-v1.md) — the published protocol contract (English, authoritative); a [Chinese reference translation](spec/ahp-v1.zh.md) is available.
- [Governance](GOVERNANCE.md) — versioning, the extension registry, and conformance policy.
- [Contributing](CONTRIBUTING.md) — setup, validation commands, and the adapter checklist.
- [Security](SECURITY.md) — the reporting channel and the redaction/secret-handling invariants.
- [Changelog](CHANGELOG.md) — release history with BREAKING markers for the 0.x line.

The following prose documents are currently in Chinese:

- [Architecture](docs/architecture.md): layers, interfaces, event flow, and approval sequences.
- [Development and migration notes](docs/development.md): implementation scope, naming changes, and validation records.
- [Extraction plan](extraction-plan.md): the original migration sequence, public release goals, and pending decisions.

The [upstream provenance manifest](docs/upstream-provenance.json) records the source revision, source file SHA-256 hashes, and destination paths.
