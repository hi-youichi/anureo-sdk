# @anureo/adapter-acp

Adapter connecting the Anureo SDK to agents implementing the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), using the official `@agentclientprotocol/sdk` 1.4.0. ACP is an editor↔agent protocol; this adapter brings any standard ACP agent behind the AHP session model — the interoperability proof that AHP is a host-side semantic layer, not a competing agent protocol.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/adapter-acp`.

## Usage

```typescript
import { createHarnessRuntime } from '@anureo/sdk'
import { createAcpAdapter } from '@anureo/adapter-acp'

const runtime = createHarnessRuntime(createAcpAdapter({
  command: 'my-acp-agent',        // spawn over stdio; or use connect() below
  args: ['--stdio'],
  cwd: '/workspace',
}))

// Remote or custom transports inject an official v1 message stream:
// createAcpAdapter({ connect: () => openMyStream() })
```

## How capabilities are mapped

ACP's core protocol covers sessions, turns, messages, and permission requests. AHP-only features are opt-in through an extension object in the agent's `initialize` response (`_meta.ahp`, version 1):

- **Optional methods** — `fork`, `revert`, `steer`, `history`, `goalSet`, `goalClear`, `compact`, `review`, each declaring its private `_…` method name, plus fork boundaries and revert scopes where applicable
- **Client requests** — `userInput` (`_ahp/user_input`) and `dynamicTool` (`_ahp/dynamic_tool`) interactions
- **Features** — nested subagent events and custom instructions

Agents that do not advertise the extension still work: the adapter publishes only the standard ACP baseline (interrupt, approval interactions, text/image/file input). fs and terminal capabilities are announced **only** when the host injects the corresponding ports — connecting an adapter never grants filesystem or terminal permission by itself.

Session snapshots loaded via ACP `session/load` have no turn boundaries; they are handed to the host through `onLoadSnapshot` instead of being replayed as realtime events.

## Options

| Option | Purpose |
|---|---|
| `command`, `args`, `cwd`, `env` | Spawn the agent binary and speak nd-JSON over stdio |
| `connect` | Provide an official `acp.Stream` factory for remote transports or deterministic wire tests |
| `fs` (`AcpFileSystemPort`) | Host-implemented read/write text-file callbacks |
| `terminal` (`AcpTerminalPort`) | Host-implemented terminal lifecycle callbacks |
| `requestTimeoutMs`, `maxFrameBytes` | Bound each request and every line (default 8 MiB; oversized frames fail with `BACKPRESSURE_EXCEEDED`) |
| `onLoadSnapshot` | Receive `session/load` snapshot updates separately from the realtime event stream |

ACP JSON-RPC error codes map to typed SDK errors (`-32601` → `CAPABILITY_UNSUPPORTED`, `-32602` → `INVALID_PARAMS`, `-32000` → `AUTH_REQUIRED`, `-32002` → `RESOURCE_NOT_FOUND`); a dropped connection surfaces as `ACP_CONNECTION_CLOSED` with `outcomeUnknown`, never as a silent success. Stderr from the agent is drained and discarded — raw provider output and credentials are not retained in diagnostics.

## Development

```sh
cd packages/acp
bun run typecheck
bun test tests
```

The conformance tests spawn a scripted ACP agent (implementing the standard wire protocol) as a real child process over stdio; `bun run verify:pack` at the workspace root repeats the full text, approval-rejection, and interrupt flows against clean npm installs.

## Documentation

- [Architecture](../../docs/architecture.md) — adapters' role in the SDK (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)
