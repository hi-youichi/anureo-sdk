# @anureo/sdk

The runtime core of the Anureo SDK. `createHarnessRuntime(adapter)` wraps any `HarnessAdapter` — Codex, Claude, ACP, an external AHP harness, or your own — behind the unified `HarnessRuntime` / `HarnessSession` interface, and enforces the AHP semantics that hosts should not have to re-implement:

- Request, result, binding, and capability validation; turn and item lifecycle state machines
- Event delivery with `streamId`, `seq`, and timestamps through a bounded queue (backpressure is explicit, never silent)
- Interaction registration, answering, and cancellation, with cleanup on timeout, turn end, or disconnection
- Per-method request caching, waiting timeouts, typed errors, and recovery state
- Secret redaction for events, histories, and file-change materials marked as secret

> Part of the [Anureo SDK workspace](../../README.md). Install with `npm install @anureo/sdk`.

## Exports

| Entry | Contents |
|---|---|
| `@anureo/sdk` | `createHarnessRuntime`, `HarnessRuntime`, `HarnessSession`, `ManagedHarnessSession`, `HarnessAdapter`, `BackendSession`, `SessionEventSink`, `RuntimeOptions`, `HarnessSdkError`, `BoundedEventQueue`, `SecretRedactor`, and related types |
| `@anureo/sdk/process` | `spawnHarnessProcess` — child-process helper used by the stdio adapters |
| `@anureo/sdk/queue` | The bounded event queue used for host consumption and stream buffering |
| `@anureo/sdk/diagnostics` | `catalogPhase` and helpers for progress-reporting probes (model catalog sessions) |

Core never imports a concrete adapter. Adapters implement `HarnessAdapter` (initialize / openSession / dispose) and receive a `SessionEventSink` (`emit`, `tryEmit`, `requestInteraction`, `resolveInteraction`, `fail`) to publish into the managed session. The dependency direction is one-way: adapters depend on core and protocol.

## Usage

The scripted adapter from `@anureo/conformance` runs without a model or credentials; replace it with any real adapter to talk to a live backend.

```typescript
import { createHarnessRuntime } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'

const runtime = createHarnessRuntime(createScriptedAdapter())
try {
  await runtime.initialize({
    protocolVersions: [1],
    clientInfo: { name: 'my-host', version: '0.1.0' },
  })
  const session = await runtime.openSession({
    requestId: 'open', mode: 'new', cwd: process.cwd(),
    binding: { sessionId: 's1', adapterId: 'scripted', runtimeConfigId: 'local' },
  })

  // Start consuming events before submitting input: the queue is bounded.
  const consume = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'item/completed' && event.payload.item.type === 'agentMessage') {
        console.log(event.payload.item.text)
      }
      if (event.type === 'turn/completed') return
    }
  })()
  void consume.catch(() => {})

  await session.startTurn({
    requestId: 'start', sessionId: session.binding.sessionId, turnId: 't1',
    input: [{ type: 'text', text: 'Hello' }],
  })
  await consume
  await session.close()
} finally {
  await runtime.dispose()
}
```

The runnable version lives at [examples/standalone.ts](../../examples/standalone.ts) (run with `bun run example` from the workspace root).

## Session surface

`HarnessSession` exposes `startTurn`, `steer`, `interrupt`, `respond`, `cancelInteraction`, `setConfig`, `revert`, `readHistory`, `setGoal`, `clearGoal`, `compact`, `review`, and `close`. The interface existing does not mean the backend supports the operation: every optional method is gated on the capabilities negotiated at initialization, and calls that exceed them fail with typed errors rather than undefined behavior.

Operational notes hosts should rely on:

- **Event identity.** Sequence numbers belong to a `streamId`; a new open produces a new stream. Do not treat `seq` across streams as one persistent log.
- **Backpressure.** The queue bounds both queued events and waiters. Non-pausable sources use `tryEmit()` and observe failure; slow consumers surface as explicit errors.
- **Outcome ambiguity.** Stopping a wait after a request was sent can yield `outcomeUnknown`; that never implies the backend did not act. Cancelling a wait and interrupting backend execution are distinct operations.
- **Session binding.** A session is bound to one adapter and runtime config. Resume and fork must honor the binding; switching backends inside a session is not supported.

## Development

```sh
cd packages/core
bun run typecheck
bun test src
```

## Documentation

- [Architecture](../../docs/architecture.md) — interfaces, turn/approval sequences, and safety boundaries (currently in Chinese)
- [AHP v1 protocol](../../spec/ahp-v1.md)
