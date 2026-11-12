# Hermes gateway adapter

`@anureo/adapter-hermes` connects the Anureo client to Hermes's shared canonical
gateway. Hermes owns sessions, models, tools and its durable input queue. The
adapter translates native execution evidence into AHP Sessions, Turns and events.

## Requirements and verification

- Node.js 22+ or the workspace's Bun 1.4.2.
- A configured Hermes installation with `hermes gateway attach --json` and the
  `hermes-gateway-v1` wire contract. The implementation targets the
  [v0.23.1 source contract](https://github.com/NousResearch/hermes-agent/tree/3b421578588243f920886e6fe79a6faa87ea026e/tui_gateway/contracts).
- The selected profile must offer `durable-admission-v1`, `event-replay-v1`,
  `local-cli-create-v1` and the `tool` session source in `runtime.describe`.

Hermes v0.20.0 does not provide the required attach command. This adapter does
not fall back to the older `python -m tui_gateway.entry` protocol. It does not
upgrade Hermes, change profile configuration, or restart a shared gateway after
a code-version mismatch.

The automated tests use real CLI child processes and a scripted native WebSocket
server. They cover shared AHP conformance, native queue/observation conformance,
reconnection, interactions and a bundled Node.js consumer. These tests establish
adapter behavior against that protocol fixture. A real macOS smoke run also
passed against Hermes `v0.23.1+2913.gbba2061`, using `zai` / `glm-5.3` through the
China Coding Plan endpoint: `bun run example:hermes` returned `17 + 25 = 42.`.
Live multi-turn, approval, interrupt and replay scenarios remain unverified;
their current evidence comes from the protocol fixture.

## Use

The workspace example makes a real model request using the selected profile:

```sh
bun install --frozen-lockfile
hermes gateway attach --help
bun run example:hermes
```

Set `HERMES_BIN` for a different executable, `HERMES_PROFILE` to select a named
profile, and `HERMES_MODEL` to override the model when creating the session.
Hermes authentication and tool policies come from that installation/profile.
The workspace example allows 90 seconds for native startup/requests, 120 seconds
for client initialization and 180 seconds for the model result. A result timeout
ends the wait; it does not cancel or authorize resubmission of the native input.

```typescript
import { createClient } from '@anureo/sdk'
import { createHermesAdapter } from '@anureo/adapter-hermes'

const client = await createClient({
  adapter: createHermesAdapter({ timeoutMs: 90_000 }),
  identity: { adapterId: 'hermes', runtimeConfigId: 'default-profile' },
}, { timeoutMs: 120_000 })
try {
  const session = await client.sessions.create({ cwd: process.cwd() })
  const reference = session.reference // Persist this with the profile's runtime configuration.
  const turn = await session.submit({ input: 'What is 17 + 25?' })
  const result = await turn.result({ timeoutMs: 180_000 })
  if (result.status === 'failed') throw new Error(result.error.message)
  if (result.status !== 'completed') throw new Error(`Turn ${result.status}`)
  console.log(result.text)
  await session.close()
  // Reopen with client.sessions.resume(reference), using the same runtime configuration.
  void reference
} finally {
  await client.dispose()
}
```

Additional submissions use Hermes's native FIFO. `session.submit()` returns a
Turn only once the input is associated with a native execution; a queued receipt
alone does not create one. Two overlapping inputs normally become distinct Turns.

Subscribe to `session.events()` before submitting to observe progress. Final
snapshots replace provisional text. Intermediate assistant messages remain
commentary; only the authoritative final message contributes to `result.text`.
Native cumulative usage has `scope: 'session'`; it is not presented as per-turn
usage.

## Interactions and controls

Enable `approval` and `userInput` handlers through the normal client options.
An absent handler cancels the native interaction; it never implicitly authorizes
an action. An explicit `undefined` handler enables manual responses through
session events and `interaction/respond`. See the [SDK guide](../packages/core/README.md#observation-progress-and-control).

Approval options preserve native `once`, `session` and `deny` semantics. Permanent
`always` grants are not offered. Clarify questions, including batches, become
`userInput`. Native secret/sudo requests mark their question as secret; core
redacts supplied secret answers from public events and results. Desktop-specific
read/action bridges receive an unsupported response.

`turn.interrupt()` sends the exact native execution generation. An ACK is not a
terminal result: await `turn.result()` to observe completion/interruption/failure.
Steering, session-wide interruption and cancelling all queued inputs are not
advertised by this release.

`session.close()` detaches this observer and reports
`executionStopped: 'unconfirmed'`. It does not stop the shared gateway or claim
that a running task stopped. `client.dispose()` releases the adapter's local
connections and attach processes. Closing or disposing a Turn observer never
retracts its input.

## Reconnection and unknown outcomes

Each connection obtains a new single-use ticket through the official attach CLI.
The adapter validates the selected WebSocket protocol, profile and owner identity.
Canonical readiness is `runtime.describe`; no `gateway.ready` frame is required.
Ticket values and native stderr never enter diagnostics.

After a disconnect, the adapter replays native events and reattaches the same
session. A replay gap is reconciled with the native snapshot and admission
receipts. An authoritative stored terminal result can restore the final answer;
missing intermediate progress is reported by a `HERMES_PROGRESS_GAP` notice.

Input is never automatically resubmitted. If admission cannot be established or
an owner restart leaves an execution unknown, the operation/observation fails
with `outcomeUnknown: true`. The adapter does not automatically resolve an unknown
admission or unblock its FIFO. Keep the session reference to inspect/reopen it;
do not treat a wait timeout as permission to send the task again.

If a submitted interaction answer is still pending on the owner after reconnect,
delivery is reported as unknown. The adapter never replays a secret answer.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `command` | `hermes` | Hermes executable |
| `args` | `[]` | Wrapper arguments preceding the Hermes CLI arguments |
| `profile` | installation default | Passed as `-p <profile>` to every attach |
| `env` | inherited | Complete child environment; never mutates `process.env` |
| `startup` | `start` | `start` permits on-demand ensure; `attach` only connects to an existing owner |
| `timeoutMs` | 30000 | Attach, connect and native request deadlines |
| `reconnectAttempts` | 3 | Maximum attempts per recovery; zero disables recovery |
| `reconnectDelayMs` | 100 | Base exponential delay after a failed recovery attempt |
| `maxOwnerRecoveriesPerMinute` | 2 | Bounds `--recover`; attach-only mode never uses it |
| `maxFrameBytes` | 8 MiB | Incoming/outgoing protocol frame limit |
| `maxBufferedBytes` | 16 MiB | Native event, pending input and per-execution projection budgets |
| `maxEvents` | 2048 | Buffered native events and attachment hold frames |
| `maxPending` | 128 | Outstanding native RPCs per connection |
| `maxInteractions` | 32 | Unresolved native interactions |
| `maxExecutions` | 128 | Retained execution projections; terminal records can be retired |
| `maxSubmissions` | 1024 | Retained input correlation records |
| `diagnostic` | none | Receives code-only diagnostics |
| `processFactory`, `webSocketFactory` | built-in implementations | Injectable process and WebSocket boundaries |

On owner recovery, the first attempt is an ordinary attach. Later attempts may
use `--recover` if `startup` permits it and the rate limit allows it. A profile or
code-identity mismatch fails explicitly rather than silently selecting another
owner.

## Capability boundaries

Supported: new/resumed sessions, native text submissions, queued admission,
streamed messages/reasoning/tools, approvals/user input, and exact-turn interrupt.
Unrecognized tools retain their native name with `kind: 'other'`.

Unsupported operations reject with `CAPABILITY_UNSUPPORTED` before dispatch:
Native JSON Schema output, image/file input, turn overrides, history, fork/revert,
compaction, goals, review, steer and configuration patches. Explicit session
`instructions` and `permissionMode` are also rejected. Profile MCP
configuration can still be used by Hermes itself. Hermes safe-mode/yolo/toolsets
are not translated into a read-only/workspace sandbox guarantee.

The ordinary text `@anureo/workflow` agent flow can use this adapter. Workflow
schemas use the SDK MCP bridge on new sessions when the gateway advertises
`acp-session-mcp-v1`, an ACP source and the `editor` creation parameter.
Session `mcpServers` are then mapped to `editor.mcp_servers` on the ACP editor
surface with per-edit approval (`ask`). Older gateways and resumed sessions do
not install the bridge. See [structured output](structured-output.md) for process
ownership and result semantics. Explicit instructions retain the limits above.
