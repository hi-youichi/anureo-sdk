# @anureo/sdk

The runtime core of Anureo SDK. The native lifecycle revision updates **AHP v1
in place** through this root entry. The workspace exports `createClient`,
`Client`, `Session` and `Turn`; root-entry migration and local validation are complete.
These examples do not describe the published 0.2.0 API. See the
[design and implementation plan](../../docs/native-harness-lifecycle.md).

Core validates requests, results, binding and capabilities; correlates inputs with
actual executions; manages interactions, privacy, bounded observations and retained
results. Adapters provide native admission, association and terminal evidence.
Core does not impose a universal business queue.

Structured output uses native schemas when available, direct tools on Pi, and a
session-scoped MCP result bridge on supported ACP and Hermes adapters. Both Session outputSchema and workflow schema
use the same path; see [structured output](../../docs/structured-output.md) for
availability, process ownership, tool definition and admission limits.

> Part of the [Anureo SDK workspace](../../README.md).

## Exports

| Entry | Contents |
| --- | --- |
| `@anureo/sdk` | `createClient`, `Client`, `Session`, `Turn`, `Input`, `SubmitOptions`, `TurnResult`, adapter ports and shared runtime utilities |
| `@anureo/sdk/process` | `spawnHarnessProcess` for stdio adapters |
| `@anureo/sdk/queue` | Bounded event queues |
| `@anureo/sdk/diagnostics` | Model-catalog progress probes |

Core never imports a concrete adapter. Adapters implement `HarnessAdapter`
(initialize / openSession / dispose). Their `SessionEventSink` publishes events,
binds submissions to executions, manages interactions and reports source failure.
The dependency direction is adapters → core/protocol.

## Submit, steer and result

The following fragment assumes an open session whose backend supports exact-turn
steer. See the [complete Codex setup](../../README.md#usage-example) or run the
[greeting example](../../examples/greeting.ts) with `bun run example`.

```typescript
const turn = await session.submit({
  input: 'Investigate and fix the failing login tests.',
})
await turn.steer({ input: 'Keep all changes inside the authentication module.' })
const result = await turn.result()
console.log(result.status, result.text)
```

| Call | Waits for | Returns |
| --- | --- | --- |
| `session.submit(options, wait?)` | Reliable input-to-execution association | `Promise<Turn>` |
| `turn.steer({ input }, wait?)` | Native confirmation that input was appended to the exact target | `Promise<void>` |
| `turn.result(wait?)` | Actual execution terminal | `Promise<TurnResult>` |

`submit()` needs `await` because admission may queue input or merge it into an
existing execution. The execution identity is only known from native evidence.
It may already be complete when association arrives. `result()` then reads its
retained result; status can be completed, interrupted or failed.
An interrupted result may include optional native `error` reason metadata; core
retains it without changing the status or inferring a user skip. The result snapshot
is immutable, including error details, even if termination preceded the submit reply.

There is no public `Submission`, `accepted()` or `submission.turn()`. Core keeps
submission identities internally. An optional native acceptance receipt is useful
progress evidence, but it is not required before returning an associated Turn.
Local queue/write success alone is not native acceptance.

`Input` accepts a string or input blocks. `SubmitOptions.delivery` accepts `native`
(the default) or `afterTurn`. Using `delivery: 'afterTurn'` requires
`session.capabilities.input?.delivery` to include `afterTurn`:

```typescript
const next = await session.submit({ input: 'Run the follow-up checks.', delivery: 'afterTurn' })
```

Exact steer requires
`session.capabilities.input?.steer?.atomicMatch`. An unsupported or stale target
rejects; steer does not create a Turn or silently fall back to session input.

Claude-style additional input uses another submission to the same session:

```typescript
const first = await session.submit({ input: 'Investigate the login tests.' })
const actual = await session.submit({ input: 'Focus on authentication.' })
console.log(first.id, actual.id) // May match, according to native evidence.
const result = await actual.result()
```

## Observation, progress and control

- `session.events()` reports future session events, including `submission/status`
  and `submission/bound`. Subscribe before submitting if you need that progress;
  there is no replay guarantee. `turn.events()` observes that execution's future
  events; `turn.result()` reads its retained terminal snapshot.
- Each submission returns an independent observation. Multiple handles may share
  one execution ID, terminal and usage. Do not count the same execution twice.
- `turn.interrupt()` requires exact-turn interrupt support. `session.interrupt()`
  requires session scope. Acknowledgement does not prove termination or withdrawal
  of queued input; await native terminal evidence.
- Wait options such as `{ timeoutMs: 30_000, signal }` apply to observation.
  Cancelling a wait or disposing a Turn does not retract input, interrupt execution
  or affect sibling observers. A timeout after sending does not justify resending.
- `session.close()` separates `observationClosed` from `executionStopped`.
  Local cleanup does not prove a native execution stopped. Always release the
  client with `await client.dispose()` in `finally`.

Declare supported interactions in client options. A handler function answers
automatically; an explicitly present key with value `undefined` enables manual
responses through session events and `session.request('interaction/respond', ...)`.
An absent kind is unsupported and cannot authorize a native request.

Optional operations remain capability gated. Source sequence numbers belong to a
`streamId`; session binding fixes the adapter and runtime configuration. Queues,
results and correlation records are bounded, with explicit errors on overflow.

## Development

```sh
cd packages/core
bun run typecheck
bun test src
```

See the [architecture](../../docs/architecture.md), [AHP v1 specification](../../spec/ahp-v1.md)
and [migration ledger](../../docs/development.md#native-lifecycle-v1) for ownership,
wire semantics and outstanding validation.
