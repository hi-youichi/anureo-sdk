# @anureo/workflow

Directly imported primitives for ordinary TypeScript workflows:
`agent`, `parallel`, `pipeline`, and optional `workflow`. The host creates SDK Clients, imports its
workflow functions, awaits their results, and handles errors with normal TS.

See the [workflow authoring reference](../../docs/workflow/SKILL.md) for current
APIs, composition patterns, failure handling, and application-owned recovery.

The [Workflow primitives reference](../../docs/workflow/README.md) defines
parameters and result semantics for `agent`, `parallel`, and `pipeline`,
and records current support.

See the [composition comparison](../../draft/docs/workflow-composition-differences.md)
and [alignment plan](../../draft/docs/workflow-composition-plan.md) for Claude Code
semantics, the implemented changes, and retained host differences (Chinese).

This workspace package uses the revised native lifecycle API and is pending
publication with that revision. Requires Node.js 22+; TypeScript loading and
compilation are provided by your project (for example, Bun, tsx, or tsc).

## Usage

Create an initialized Client using `createClient` and your chosen adapter as
described in the [SDK README](../../README.md). A workflow is just a function:

```ts
import type { Client } from '@anureo/sdk'
import { agent, parallel, pipeline } from '@anureo/workflow'

export async function reviewFiles(client: Client, files: readonly string[], cwd: string) {
  const options = { client, cwd }
  const verified = await pipeline(
    files,
    file => agent(`Review ${file}; include code locations and evidence.`, options),
    (findings, file) => agent(`Independently verify ${file}:\n${findings}`, options),
  )
  if (verified.some(value => value === null)) throw new Error('Some file reviews failed')
  const [summary, tests] = await parallel([
    () => agent(`Summarize: ${JSON.stringify(verified)}`, options),
    () => agent(`Suggest regression tests: ${JSON.stringify(verified)}`, options),
  ])
  if (summary === null || tests === null) throw new Error('Review synthesis failed')
  return { verified, summary, tests }
}
```

In this example, `pipeline` and `parallel` convert internal `agent` rejections to
`null`; `pipeline` also skips the affected item's remaining stages. The two
explicit checks then throw summary errors for `null` results, so those errors do
not preserve the original agent failure classification.

Import `reviewFiles` from another TS file and call it with a Client. Calls do not
require workflow registration, source-string execution, ambient context, or runtime setup.
Use [durable workflow steps](../../docs/workflow/persistence.md) when a function
needs a persisted run ID and recoverable results.

## agent

```ts
import { z } from 'zod'
import { agent } from '@anureo/workflow'

const options = { client, cwd: process.cwd() }
const text: string | null = await agent('Inspect the authentication module.', options)
const findings = await agent('List authentication issues.', {
  ...options,
  schema: z.strictObject({ issues: z.array(z.string()) }),
})
// findings: { issues: string[] } | null
if (findings !== null) console.log(findings.issues)
```

Each call owns a fresh Session, submits once, waits for its native terminal
result, and releases its resources. `client` and `cwd` are required; `model` and
`instructions` are optional. The caller owns the borrowed Client.

`schema` accepts a Zod 4 object schema. The library converts it to draft-07 JSON
Schema, requires effective session `turn.outputSchema` support, validates the raw JSON
result, then validates it with the original Zod schema and returns `z.output<S>`.
This package depends on Zod 4.6.7. Applications that import Zod to author schemas
should also declare it as their own dependency. Schema-associated types infer business fields;
there is no unbound result-type generic or raw JSON Schema overload.

Use closed objects and required fields; nullable fields, array properties, enums,
nested unions and local recursion are supported. Optional properties, open
objects, records, tuples, value transformations and non-JSON types are rejected.
Defaults do not fill omitted model answers. Async refinements are supported
locally; their failures reject without replaying input. See the
[full schema and failure contract](../../docs/workflow/README.md#schema-mode).

Confirmed native failed terminals for authentication, usage/rate limits, and
service unavailability return `null`. Other failures and ordinary interruptions
reject. Trusted adapters may explicitly report user skip or classifier startup
denial; bundled adapters do not infer these reasons. Unknown execution outcomes
retain `outcomeUnknown: true` and always reject. No input is automatically retried.

Cleanup is attempted for successful, failed and discarded executions. A cleanup
failure rejects with `RESOURCE_RELEASE_FAILED`, or preserves a primary execution
exception with attached `details.cleanupErrors`. Releasing observation does not
prove the backend stopped. Use SDK Session/Turn APIs for raw items, usage, event
observation, multi-turn context, and exact execution controls.

Run `bun run example:workflow-schema [all|codex|claude]` for the
[Zod example](../../examples/workflow-structured.ts) using authenticated local
CLIs and real model requests.

## parallel

`parallel([() => taskA(), () => taskB()])` starts every callback and returns
input-ordered results. Callbacks may return ordinary values or Promises; inline
heterogeneous tuples preserve each result's type. An empty batch returns `[]`.

The array and every entry are validated before any callback starts. The call
waits for all callbacks to settle and uses `null` at each failed position,
including synchronous throws. Result types include `null` at every position.
Invalid arguments still reject the call. Use `value !== null` to filter failures
without dropping valid `0`, `false`, or empty-string results.
There is no implicit interruption, shared scheduler, or concurrency limit.

## pipeline

`pipeline(items, stage1, stage2, ...)` runs each item through its own sequence of
stages. A fast item can enter stage two while another item is still in stage one.
Results retain input order. Empty input returns `[]` before stage validation.
Zero stages are allowed and return the awaited inputs, with failures as `null`.

Every stage receives `(prevResult, originalItem, index)`. The first stage gets
the awaited input value; later stages get the awaited prior result. The original
input entry and zero-based index remain available throughout. Stages may change
types and pass ordinary TS values, including objects and Maps, without a JSON
serialization boundary.

Inline callbacks have contextual type inference for up to six stages. Longer
chains accept typed stage functions with no runtime stage-count limit. Incompatible
stage inputs are compile-time errors. A `null` input or stage result skips that
item's remaining stages. An item failure also skips its remaining stages and
becomes `null`. The returned Promise waits for all item chains to settle; its
result type always includes `null`. Stage input types exclude only `null`, so
`undefined` and other falsy values continue normally. Invalid composition
arguments still reject the call.

## Durable workflow

`workflow(options, body)` saves an initial manifest before passing explicit
`runId`, `input` and `step` to the body. Use `run.step({ key, input, schema }, execute)`
to persist validated results and `resumeFrom` to reuse them in a new run. Existing
three-primitive functions keep their independent behavior.

The [persistence reference](../../docs/workflow/persistence.md) defines JSON inputs,
schema inference, manual/repeatable recovery, error handling and file guarantees.
Try `bun run example:workflow-persistence` and then repeat with its printed run ID.
This example uses deterministic callbacks and makes no model requests.

## Examples

Run `bun run example:workflow` from the repository. The ordinary
[TypeScript example](../../examples/workflow.ts) directly imports all three
primitives and uses the Codex adapter. It requires a configured, authenticated
Codex CLI on PATH (`CODEX_BIN` can override its path). It prints every agent
input and output; each prompt requests arithmetic without tools.

For `[2, 3, 4]`, the pipeline asks the model to double then square each value, expecting
`[16, 36, 64]`. Two parallel agent calls then calculate the sum `116` and maximum `64`.
The eight agent calls each use an independent Session.

The [migration plan](../../draft/docs/workflow-primitives-plan.md) records the removed
framework and the [development record](../../draft/docs/development.md#workflow-agent-zod)
contains current verification evidence. The package has only its root entry;
there is no `/mcp` subentry.
