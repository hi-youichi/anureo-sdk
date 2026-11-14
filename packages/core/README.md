# @anureo/sdk

`@anureo/sdk` runs agent sessions through a harness adapter. Applications use it
to submit input, stream events, collect results, and control native executions.
The SDK validates AHP requests and events, tracks which execution handles each
submission, and owns session observation and cleanup. The adapter provides the
native execution and reports its progress.

This guide describes the revised workspace API. The published 0.2.0 release has a
different lifecycle API. See the [workspace guide](../../README.md) and the
[lifecycle migration notes](../../draft/docs/native-harness-lifecycle.md).

## Quick start

This example requires an authenticated Codex CLI on PATH and the
[Codex adapter](../adapter/codex/README.md). For a streaming version, run
`bun run example` from the workspace root or read the
[greeting example](../../examples/greeting.ts).

```typescript
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

const client = await createClient({
  adapter: createCodexAdapter({ command: 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})

try {
  const session = await client.sessions.create({ cwd: process.cwd() })
  const turn = await session.submit({ input: 'Say hello in one sentence.' })
  const result = await turn.result()

  if (result.status === 'failed') throw new Error(result.error.message)
  if (result.status === 'interrupted') throw new Error('Turn interrupted')
  console.log(result.text)

  await session.close()
} finally {
  await client.dispose()
}
```

## Application API

Import the application API and its types from `@anureo/sdk`.

### Client

| API | Purpose |
| --- | --- |
| `createClient(options, wait?)` | Initialize an adapter and return a `Client` ready to open sessions. |
| `new Client(options)`, `client.initialize(wait?)` | Construct a client without I/O, then negotiate adapter capabilities explicitly. |
| `client.identity` | Read the adapter and runtime configuration IDs used to validate session bindings. |
| `client.sessions.create(options, wait?)` | Open a new session with a fresh binding. |
| `client.sessions.resume(reference, wait?)` | Reopen the session identified by a saved `session.reference`, when supported. |
| `client.sessions.fork(reference, { boundary }, wait?)` | Open a new session from a specified boundary in an existing session, when supported. |
| `client.openSession(params, wait?)` | Open a session with explicit AHP open parameters and binding. |
| `client.dispose()` | Release the client's sessions and adapter. Call it in `finally`. |

[`ClientOptions`](src/client-options.ts) configures the adapter, client identity,
runtime hooks, interaction handlers, and retention limits.
[`RuntimeOptions`](src/ports.ts) configures timeouts, resource budgets, and host
hooks such as ID generation and history redaction.

### Session

A `Session` represents a conversation opened through the client.

| API | Purpose |
| --- | --- |
| `session.submit(options, wait?)` | Send input and return a `Turn` once the adapter associates the input with an execution. |
| `session.review({ target }, wait?)` | Start a supported native review and return its associated `Turn`. |
| `session.events(options?)` | Subscribe to future session events, including submission progress and interaction requests. Subscribe before submitting to observe those events. |
| `session.id`, `session.binding`, `session.reference` | Read the session ID, its adapter binding, or a reference for resuming or forking it. |
| `session.capabilities`, `session.snapshot` | Check the session's current capabilities or read its current privacy-filtered state. |
| `session.interrupt(options?, wait?)` | Request a session-wide interrupt. Pass `cancelQueued` only when supported. An acknowledgement alone cannot establish that execution stopped or that queued input was withdrawn. |
| `session.request(method, params, wait?)` | Send a typed, lower-level AHP session request for operations such as history reads or manual interaction responses. |
| `session.close(wait?)` | Request native close and release observation and backend resources after the receipt. The receipt reports `observationClosed` and `executionStopped` separately. |
| `session.dispose()` | Release local observation and backend resources without asserting that native execution stopped. |

`Input` accepts a string or an array of AHP input blocks. [`SubmitOptions`](src/client-options.ts)
also accepts capability-gated `delivery`, `overrides`, and `outputSchema`.
Delivery defaults to `native`, so a backend can queue input or merge it into an
existing execution. Two submissions can return handles with the same `turn.id`.
Count the execution and its usage once. Use `delivery: 'afterTurn'` when
`session.capabilities.input?.delivery` includes `afterTurn`.
The SDK tracks submission IDs internally. `submit()` waits for an execution
association, which can arrive before an acceptance receipt or after the execution
has already ended.

Pass a JSON Schema as `outputSchema` when `session.capabilities.turn?.outputSchema`
is enabled. A successful result carries JSON in `result.text`. The SDK uses native
schemas where available, a direct output tool on Pi, or a session-scoped MCP bridge
on supported ACP and Hermes sessions. The [structured output example](../../examples/structured-output.ts)
shows how to submit and parse a result.

Configure supported interactions through `ClientOptions.interactions`.
An `InteractionHandlers` function handles its kind automatically. An explicit
key with value `undefined` enables manual responses through session events and
`session.request('interaction/respond', params)`. An omitted kind is unsupported.

### Turn

| API | Purpose |
| --- | --- |
| `turn.id` | Read the execution ID shared by all handles observing that execution. |
| `turn.result(wait?)` | Wait for the execution's terminal result or read it if already retained. |
| `turn.events(options?)` | Subscribe to future events for this execution. |
| `turn.steer({ input }, wait?)` | Wait for native confirmation that input was appended to this exact execution. Requires `session.capabilities.input?.steer?.atomicMatch` and rejects stale targets. |
| `turn.interrupt(wait?)` | Request interruption of this exact execution when supported. Use `result()` to observe its terminal status. |
| `turn.observe()` | Create an independent handle for the same execution. |
| `turn.dispose()` | Stop this handle's waits and subscriptions. Native execution and other handles can continue. |

[`TurnResult`](src/types.ts) is an immutable snapshot with text, items,
and any available usage. Its status is `completed`, `interrupted`, or `failed`.
An interrupted result can carry a native error reason.

[`RequestOptions`](src/types.ts) sets a caller's wait deadline and abort signal.
A timeout after dispatch can leave the native outcome unknown. Check
`HarnessSdkError.outcomeUnknown` before retrying to avoid duplicate work.
[`EventSubscriptionOptions`](src/types.ts) controls cancellation and
per-subscription queue limits.

## Adapter API

Adapters import their contracts from `@anureo/sdk` and use the types in
[`@anureo/protocol`](../protocol/README.md) for AHP requests, results, and events.

| Contract | Who implements and calls it |
| --- | --- |
| `HarnessAdapter` | The adapter implements `initialize()`, `openSession()`, and `dispose()`. The client calls them to negotiate capabilities, open native sessions, and release client-wide resources. |
| `BackendSession` | The adapter returns this from `openSession()`. Core reads its binding, capabilities, and optional state, and calls `execute()` and `dispose()` for native requests and cleanup. `SessionMethod` identifies requests routed through an open session. |
| `SessionEventSink` | Core supplies this to the adapter at open. The adapter calls `emit()` or `tryEmit()` to publish events, `bindSubmission()` to associate input with an execution, and `fail()` to report observation failure. `EventScope` supplies turn or item context for an event. |
| `NativeInteractionResponder` | The adapter supplies this callback to `sink.requestInteraction()`. Core calls it to deliver a response or request cancellation. The adapter calls `sink.resolveInteraction()` when the native peer has already settled a request. |
| `StructuredOutputToolPort`, `StructuredOutputToolDefinition`, `StructuredOutputToolResult` | An adapter can expose a tool port on `BackendSession`. Core calls `configure()` to install or disable the tool. The adapter presents the definition and calls its `execute()` to validate a candidate. |

`HarnessAdapter.outputBridgeTransport()` lets an adapter opt into the session MCP
bridge. `SessionEventSink.projectOutput()` is an optional hook for privacy-filtering
output before final schema validation. See [the port definitions](src/ports.ts)
for ordering, failure, and ownership contracts.

## Supporting exports

| Purpose | Import path | Exports |
| --- | --- | --- |
| Errors and caller waits | `@anureo/sdk` | `HarnessSdkError` carries a safe code and outcome metadata. `sdkError()` normalizes a failure. `waitForRequest()` applies a caller-scoped wait using `RequestOptions`. |
| Unattended approvals | `@anureo/sdk` | `approveWithNarrowestScope()` can be explicitly registered as `interactions.approval`. It chooses allow-once, then session, then rule grants, and rejects when none is offered. Clients never enable it automatically. |
| Host logging | `@anureo/sdk` | LogTape's `configure`, `configureSync`, `getLogger`, `drain`, `dispose`, `disposeSync`, `reset`, and `resetSync`, plus `Config`, `LogLevel`, `LogRecord`, `Logger`, and `Sink`. The application configures logging sinks. |
| Native subprocesses | `@anureo/sdk/process` or `@anureo/sdk` | `spawnHarnessProcess()` launches and owns stdio subprocess I/O and cleanup. The module also exports `ProcessPortError`, `ProcessExit`, `HarnessProcess`, and `HarnessProcessOptions`. |
| Bounded buffering | `@anureo/sdk/queue` or `@anureo/sdk` | `BoundedEventQueue` provides a bounded, single-reader async queue. `QueueLimits` configures its budgets. |
| Model catalog diagnostics | `@anureo/sdk/diagnostics` | `catalogPhase()` reports probe timing and outcomes. `emitCatalogPhase()` publishes a diagnostic, and `safeCatalogErrorCode()` projects an error to a safe code. `CatalogProbeOptions` and `CatalogProbeEvent` describe observers and their events. |

### Implementation helpers

The root currently exports `NativeIdentityMap` for native-to-SDK ID mapping,
`InteractionRegistry` for tracking native interaction responses, and
`SecretRedactor` for filtering marked secrets.
`@anureo/sdk/structured-output-stdio` is an internal package entry that core
resolves to launch the stdio bridge subprocess.

## Code structure

| Source | Responsibility |
| --- | --- |
| [`package.json`](package.json), [`src/index.ts`](src/index.ts) | Define the package entry points and assemble the root exports. |
| [`src/client.ts`](src/client.ts), [`src/session.ts`](src/session.ts), [`src/turn.ts`](src/turn.ts) | Implement the application API for opening sessions, dispatching requests, and observing and controlling executions. |
| [`src/client-options.ts`](src/client-options.ts), [`src/types.ts`](src/types.ts), [`src/ports.ts`](src/ports.ts) | Define public configuration, input, result, and observation types, plus adapter contracts. |
| [`src/errors.ts`](src/errors.ts), [`src/request.ts`](src/request.ts) | Provide SDK errors, failure normalization, and caller-scoped waits. |
| [`src/lifecycle/`](src/lifecycle/) | Supports the application API with event subscriptions, result accumulation, and interaction settlement. |
| [`src/adapter/`](src/adapter/), [`src/requests/`](src/requests/) | Provide native-to-SDK ID mapping and request validation against session bindings and capabilities. |
| [`src/privacy/`](src/privacy/) | Redacts marked secrets from observed data and bounds retained file change content. |
| [`src/structured-output/`](src/structured-output/) | Wraps adapters for schema validation and manages the direct-tool and MCP fallback paths. |
| [`src/process.ts`](src/process.ts), [`src/queue.ts`](src/queue.ts), [`src/diagnostics.ts`](src/diagnostics.ts) | Implement the subprocess, bounded queue, and model catalog diagnostics subpaths. |

## Development

```sh
cd packages/core
bun run typecheck
bun test src
```

See the [architecture notes](../../draft/docs/architecture.md) for package
responsibilities and the [AHP v1 schema](../protocol/schema/v1/ahp.schema.json)
for wire contracts.
