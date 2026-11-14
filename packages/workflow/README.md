# @anureo/workflow

`@anureo/workflow` runs Anureo SDK agents from ordinary TypeScript functions. Use
`agent` for one prompt, `parallel` for independent callbacks, `pipeline` for
per-item stages, and `workflow` when you need a disk-backed run and agent replay.
The package exposes one entry point, `@anureo/workflow`. Its Node.js engine
requirement is 22 or newer, and applications supply their TypeScript tooling.

## Usage

This function accepts an initialized SDK Client and reviews files in two stages
before running two synthesis tasks concurrently. The application creates and owns
the Client. See the [SDK README](../../README.md) for Client setup.

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

`pipeline` and `parallel` turn rejected agent calls into `null` at the affected
positions. The two guards report those positions as batch-level errors. Keep the
Client usable until `reviewFiles` settles, then release it when the application
has finished using it.

See the [workflow authoring guide](../../docs/workflow/SKILL.md) for composition and
recovery patterns and the [primitives reference](../../docs/workflow/README.md) for API contracts.

## agent

```ts
import type { Client } from '@anureo/sdk'
import { z } from 'zod'
import { agent } from '@anureo/workflow'

export function listIssues(client: Client, cwd: string) {
  return agent('List the authentication module’s issues.', {
    client,
    cwd,
    schema: z.strictObject({ issues: z.array(z.string()) }),
  })
}
// listIssues returns Promise<{ issues: string[] } | null>.
```

For fresh execution, `agent` opens a Session, submits one prompt, awaits the native
terminal result, and attempts to close and dispose the Session before settling.
The root exports `AgentOptions` for callers building options. Supply an initialized
`client` and a `cwd`. You can also supply `model`, `instructions`, and `permissionMode`
for session creation. The caller owns the Client.
Omit `schema` to receive the final text, which can be empty, or `null`.

`schema` accepts a Zod 4 object schema. The library converts it to draft-07 JSON
Schema, validates the raw JSON result, then validates it with the original Zod schema
and returns `z.output<S>`. By default, schema mode requires effective session
`turn.outputSchema` support. Set `outputFallback: 'json-text'` to include the schema
in the prompt when the session lacks that capability.
This package depends on Zod 4.6.7. Applications that import Zod to author schemas
should also declare it as their own dependency. Schema-associated types infer business fields;
there is no unbound result-type generic or raw JSON Schema overload.

Use closed objects and required fields; nullable fields, array properties, enums,
nested unions and local recursion are supported. Optional properties, open
objects, records, tuples, value transformations and non-JSON types are rejected.
Defaults do not fill omitted model answers. Async refinements are supported
locally; their failures reject without replaying input. See the
[full schema and failure contract](../../docs/workflow/README.md#schema-mode).

Confirmed native failed terminals for authentication, usage or rate limits, and
service unavailability can return `null`. Explicit user skip on interruption and
tagged startup denial can also return `null`. Other failures and ordinary
interruptions reject. Unknown execution outcomes reject with `outcomeUnknown: true`.
The caller decides whether and when to retry.

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

`parallel` snapshots the array and validates every entry before any callback
starts. Invalid arguments reject with `TypeError`. The promise waits for all
callbacks to settle. A synchronous throw, a rejected promise, or a `null` return
all produce `null` at that position. Use `value !== null` to retain other falsy
values, and handle errors inside callbacks if you need their original causes.
The caller manages concurrency limits, cancellation, and callback resources.

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
`undefined` and other falsy values continue normally. A non-array input or a
non-function stage on nonempty input rejects with `TypeError`. The caller manages
concurrency limits, cancellation, and resources used by input work or stages.

## Durable workflow

`workflow(options, body)` creates a new file-backed run and saves its initial
manifest before calling `body({ runId, input })`. Supply strict JSON for the input
and the awaited body result. Set `directory` to the storage root and `name` and
`revision` to identify compatible runs. `runId` defaults to a new UUID. The body
receives a deeply frozen input copy. The root exports `WorkflowOptions`,
`WorkflowContext`, and `WorkflowResult` for typing the options, callback context,
and published result.

To resume, set `resumeFrom` to an inactive source run with the same name and
revision. The body runs again from the beginning in a new run. After schema
validation, journaled calls reserve keys in invocation order using their prompt,
options, and predecessor. Eligible saved results are reused without opening a
Session. A changed key ends replay for later calls. A matching call left at a
started record can rerun while later calls remain eligible. A prior terminal
failure with an unknown outcome requires reconciliation before that call can run.
The body owns any side effects that may repeat during resume.

The promise drains registered agent calls, publishes a JSON copy of the body result, and
releases the writer lock before resolving with `{ runId, status, result }`.
A registered agent rejection or drop can produce `status: 'incomplete'` if the
body still returns a publishable result. Body errors, fatal agent failures, and
storage failures reject. Keep Clients usable until settlement and await any
other background work inside the body. See the [persistence reference](../../docs/workflow/persistence.md)
for cache keys, failure recovery, and file guarantees.

## Code structure

- [Package entry](src/index.ts) exposes the four application primitives and links their public
  types directly to the modules that define them. [TypeScript configuration](tsconfig.json)
  checks `src`, including tests, with Bun and Node types. The [package manifest](package.json)
  declares the root entry and the no-emit build and typecheck scripts.
- [Agent calls](src/agent.ts) choose between fresh execution and journal replay, and record
  the outcome of journaled calls. [Fresh execution](src/agent-execution.ts) owns the SDK
  session from creation through release. [Output schemas](src/output-schema.ts) prepare the
  request schema and validate fresh and replayed results.
- [Parallel](src/parallel.ts) starts independent callbacks. [Pipeline](src/pipeline.ts)
  advances each input through its own typed stage chain.
- [Workflow](src/workflow.ts) opens the run, invokes the body, drains registered agent work,
  and publishes the result or failure before releasing the run. [Workflow types](src/workflow-types.ts)
  define the application contract. [Run state](src/workflow-state.ts) gives nested agent calls
  access to the active run and tracks admission, pending work and sticky failures.
- [Persistence](src/persistence/) holds the [target writer](src/persistence/store.ts), the
  [source reader](src/persistence/replay.ts), and the [journal](src/persistence/journal.ts).
  [Checkpoint records](src/persistence/records.ts) define the shared file layout and schemas.
  [Checkpoint file I/O](src/persistence/checkpoint-files.ts) owns atomic publication and
  checked reads. [Canonical JSON](src/persistence/json.ts) supplies copying and hashing rules.

## Examples

Run `bun run example:workflow` from the repository. The ordinary
[TypeScript example](../../examples/workflow.ts) directly imports all three
primitives and uses the Codex adapter. It requires a configured, authenticated
Codex CLI on PATH (`CODEX_BIN` can override its path). It prints every agent
input and output; each prompt requests arithmetic without tools.

For `[2, 3, 4]`, the pipeline asks the model to double then square each value, expecting
`[16, 36, 64]`. Two parallel agent calls then calculate the sum `116` and maximum `64`.
The eight agent calls each use an independent Session.

Run `bun run example:workflow-persistence` and repeat with the printed run ID to
replay the saved agent results. The example uses a scripted backend, and the
resumed run opens zero new sessions.
