# @anureo/adapter-acp

Adapter connecting the Anureo SDK to agents implementing the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), using the official `@agentclientprotocol/sdk` 1.4.0. ACP is an editor↔agent protocol; this adapter brings any standard ACP agent behind the AHP session model — the interoperability proof that AHP is a host-side semantic layer, not a competing agent protocol.

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/adapter-acp`.

## Usage

This shows the revised workspace API, not the published 0.2.0 API. Root migration and local
validation are complete.

```typescript
import { createClient } from '@anureo/sdk'
import { createAcpAdapter } from '@anureo/adapter-acp'

const client = await createClient({
  adapter: createAcpAdapter({
    command: 'my-acp-agent',        // spawn over stdio; or use connect() below
    args: ['--stdio'],
    cwd: '/workspace',
  }),
  identity: { adapterId: 'acp', runtimeConfigId: 'local' },
})
// Use client.sessions.create(...) and session.submit(...); dispose in finally.

// Remote or custom transports inject an official v1 message stream:
// createAcpAdapter({ connect: () => openMyStream() })
```

## How capabilities are mapped

ACP's core protocol covers sessions, turns, messages, and permission requests. AHP-only features are opt-in through an extension object in the agent's `initialize` response (`_meta.ahp`, version 1):

- **Optional methods** — `fork`, `revert`, `steer`, `history`, `goalSet`, `goalClear`, `compact`, `review`, each declaring its private `_…` method name, plus fork boundaries and revert scopes where applicable
- **Client requests** — `userInput` (`_ahp/user_input`) and `dynamicTool` (`_ahp/dynamic_tool`) interactions
- **Features** — nested subagent events and custom instructions

Agents that do not advertise the extension still work: the adapter publishes only the standard ACP baseline (session-scoped interrupt, approval interactions, text/image/file input). fs and terminal capabilities are announced **only** when the host injects the corresponding ports — connecting an adapter never grants filesystem or terminal permission by itself.

Session snapshots loaded via ACP `session/load` have no turn boundaries; they are handed to the host through `onLoadSnapshot` instead of being replayed as realtime events.

Configuration patches apply one field at a time. Each confirmed field updates
the session state immediately. If a later field fails, `CONFIG_PARTIAL` reports
`details.appliedKeys`, `details.failedKey` and the underlying `details.cause.code`;
confirmed changes remain applied. `outcomeUnknown` describes uncertainty about
the failed field and requires recovery when true.

## Options

| Option | Purpose |
|---|---|
| `command`, `args`, `cwd`, `env` | Spawn the agent binary and speak nd-JSON over stdio |
| `connect` | Provide an official `acp.Stream` factory for remote transports or deterministic wire tests |
| `fs` (`AcpFileSystemPort`) | Host-implemented read/write text-file callbacks |
| `terminal` (`AcpTerminalPort`) | Host-implemented terminal lifecycle callbacks |
| `requestTimeoutMs` | Timeout in milliseconds for ACP requests other than `session/prompt` (default 30,000; DSH preset 120,000) |
| `maxFrameBytes` | Maximum bytes per incoming or outgoing stdio line (default 8 MiB; oversized frames fail with `BACKPRESSURE_EXCEEDED`) |
| `onLoadSnapshot` | Receive `session/load` snapshot updates separately from the realtime event stream |
| `stderrTailLines`, `onStderr` | Set the retained stderr line limit (default 200) and receive redacted lines; `0` disables capture and callbacks |
| `autoRespondPermission` | Answer `session/request_permission` without an AHP interaction; undecided or unoffered kinds fall back to the human path |

ACP JSON-RPC error codes map to typed SDK errors (`-32601` → `CAPABILITY_UNSUPPORTED`, `-32602` → `INVALID_PARAMS`, `-32000` → `AUTH_REQUIRED`, `-32002` → `RESOURCE_NOT_FOUND`); a dropped connection surfaces as `ACP_CONNECTION_CLOSED` with `outcomeUnknown`, never as a silent success.

For spawned agents, stderr is never forwarded raw: the adapter redacts `sk-…`, bearer tokens, `key=value` secrets, and URL credentials. `stderrTailLines` controls the retained line limit (default 200; `0` disables capture and `onStderr` callbacks). The retained tail is also limited to 32,768 UTF-16 code units, counting each redacted line's length plus one for a separator, so fewer lines may be retained. The adapter attaches that tail to startup and disconnect failures as `details.diagnostics.stderrTail`.

`session/prompt` stop reasons map explicitly: `end_turn` and `cancelled` keep their existing meaning, `max_tokens` / `max_turn_requests` complete the turn with an `ACP_STOP_MAX_TOKENS` / `ACP_STOP_MAX_TURN_REQUESTS` notice, `refusal` fails it, and any unclassified reason fails closed with `ACP_STOP_UNKNOWN`. A backend that stops for an unknown reason is never reported as clean success.

Automatic approval decisions emit an `ACP_PERMISSION_AUTO_ANSWERED` notice carrying only the tool-call id and chosen option; the request's raw input never reaches the notice. Policies never fabricate an option id: when the agent does not offer the requested kind, the request falls back to `interaction/requested`.

## Driving DeepSeek Harness

`createDshAcpAdapter()` presets the one-liner for `dsh --profile acp` (DSH 0.2.2+, Node.js ≥ 24.9):

```typescript
import { createClient } from '@anureo/sdk'
import { createDshAcpAdapter } from '@anureo/adapter-acp'

const client = await createClient({
  adapter: createDshAcpAdapter({ cwd: workspace, autoApprove: true }),
  identity: { adapterId: 'dsh-acp', runtimeConfigId: 'local' },
})
const session = await client.sessions.create({ cwd: workspace, model: 'deepseek-v4-flash' })
```

DSH advertises the standard ACP v1 baseline only — no `_ahp` extension, no modes, `embeddedContext: false` — so `fork`, `revert`, `steer`, `history`, `goal`, `compact`, `review` and `file` prompt blocks stay unavailable, and `permissionMode` must not be passed. Model values resolve against the advertised `provider/model` enum, so a bare `deepseek-v4-flash` becomes `deepseek-official/deepseek-v4-flash` before it reaches the backend. Auto-approval is opt-in because DSH offers only `allow_once` / `reject_once`; the policy is the only way to run unattended.

## Development

```sh
cd packages/acp
bun run typecheck
bun test tests
```

The conformance tests spawn a scripted ACP agent (implementing the standard wire protocol) as a real child process over stdio.

## Documentation

- [Architecture](../../docs/architecture.md) — adapters' role in the SDK (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)

## AHP v1 lifecycle revision

The lifecycle design updates AHP v1 and package root entries in place.
The root implementation and tests use the revised lifecycle; parallel versioned
entries have been removed. Local conformance and clean-install checks have passed. Standard ACP remains limited to guarantees it can prove; overlapping input requires an explicit correlation extension, and session cancellation must not masquerade as exact-turn interrupt.
See the [design and implementation plan](../../docs/native-harness-lifecycle.md).
