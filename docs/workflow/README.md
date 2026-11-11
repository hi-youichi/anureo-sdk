# Workflow primitives: parameters and return values

This document defines the parameter and result contracts for `agent()`,
`parallel()`, `pipeline()`, and optional `workflow()` from `@anureo/workflow`. Anureo workflows use direct
imports in ordinary TypeScript modules, with an explicit SDK Client and working
directory for agent calls.

- [agent](#agent): independent agent execution, options, and results.
- [parallel](#parallel): concurrent callbacks and an input-ordered result barrier.
- [pipeline](#pipeline): independent item chains with sequential stages.
- [workflow](persistence.md): run identities, explicit step checkpoints, and failure recovery.

The primitives implement the contracts below as ordinary TypeScript functions.
Their comparison with the recovered Claude Code 2.1.296 Workflow implementation
identifies retained differences from that reference host. For current executable APIs and workflow patterns, see the
[workflow authoring reference](SKILL.md).

## agent

Each call creates an independent Session, submits once, waits for the associated
Turn's terminal result, and releases its Session resources. The caller supplies
an initialized Client and owns that Client's lifetime.

### Calling convention and parameters

```ts
import type { Client } from '@anureo/sdk'
import type { z } from 'zod'

interface AgentOptions<S extends z.ZodObject = z.ZodObject> {
  client: Client
  cwd: string
  model?: string
  instructions?: string
  schema?: S
}

declare function agent(
  prompt: string,
  options: AgentOptions<never> & { schema?: undefined },
): Promise<string | null>

declare function agent<S extends z.ZodObject>(
  prompt: string,
  options: AgentOptions<S> & { schema: S },
): Promise<z.output<S> | null>

declare function agent<S extends z.ZodObject>(
  prompt: string,
  options: AgentOptions<S>,
): Promise<string | z.output<S> | null>
```

| Option | Meaning |
| --- | --- |
| `client` | Required initialized SDK Client. Selects the backend; the caller owns it. |
| `cwd` | Required working directory for the fresh Session. |
| `model` | Optional model override. Omission uses the backend's configured default. |
| `instructions` | Optional session instructions. |
| `schema` | Optional Zod 4 object schema. Enables structured output and infers the result type from that schema. |

The third overload handles a schema selected at runtime. Preserve its type with
`AgentOptions<typeof schema>`; annotating an option object as the broad
`AgentOptions` erases its particular property types. An inline option object or
`satisfies AgentOptions` preserves its inferred shape.

### Return values and failures

| Outcome | Return behavior |
| --- | --- |
| Text mode succeeds | The SDK's final text, including an empty string when no final text exists. |
| Zod schema mode succeeds | Validated `z.output<S>` data, without a JSON string or result wrapper. |
| Native failed terminal with code `AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `USAGE_LIMIT_EXCEEDED`, `RATE_LIMITED`, or `NATIVE_SERVICE_UNAVAILABLE` | `null`, after successful cleanup. |
| Trusted adapter explicitly confirms a user skip | `null`. Bundled Claude/Codex adapters do not infer skip from an ordinary interrupt. |
| Trusted adapter explicitly reports startup classifier denial | `null`. The library does not provide a classifier; bundled adapters do not synthesize this reason. |
| Invalid or unsupported schema, missing output capability, malformed or invalid structured output, or exhausted native structured retries | Rejects. |
| Other native failures, ordinary interruptions, startup/submission failures, or unknown outcomes | Rejects with a `HarnessSdkError`. |
| Session cleanup fails | Rejects, even if the candidate result was successful or `null`. |

Only known native terminal API failures use the code whitelist. An error with
the same code during open or submit still rejects. `outcomeUnknown: true` always
rejects; it overrides discard classifications. The primitive does not replay input,
retry stalls, wait for usage limits, or claim that closing observation stopped an
uncertain backend execution.

Execution failures preserve their code, retryable flag, uncertainty and details.
When cleanup also fails, `details.cleanupErrors` retains its errors. A cleanup-only
failure throws `RESOURCE_RELEASE_FAILED`; if a discarded execution preceded that
failure, `details.droppedError` contains its code and uncertainty.

### Text mode

The result is `TurnResult.text`: all SDK `agentMessage` items marked `final`,
joined with newlines. It contains no usage, execution ID or item wrapper. Use the
SDK Session/Turn APIs for those details and for multi-turn conversation reuse.

### Schema mode

```ts
import { z } from 'zod'
import { agent } from '@anureo/workflow'

const schema = z.strictObject({ issues: z.array(z.string()) })
const result = await agent('Inspect this project and list its issues.', {
  client,
  cwd,
  schema,
})
// result: { issues: string[] } | null
if (result !== null) {
  for (const issue of result.issues) console.log(issue)
}
```

The library converts the Zod schema to self-contained draft-07 JSON Schema,
checks it before creating a Session, and sends it via `outputSchema`. Backends
must advertise `turn.outputSchema`; unsupported calls reject without submitting
input. Raw JSON Schema remains available through the SDK Session API, and is not
accepted as workflow `schema`.

At a successful terminal result, the library parses the complete final JSON text,
validates the raw value against the generated schema, and calls the original
schema's `safeParseAsync()`. It returns that validated data. It does not recover
JSON from prose or Markdown fences. Claude's adapter uses its native
`structured_output` field and rejects if that field is missing or invalid.

The supported subset has an object root, closed nested objects, required fields,
array properties, enums, nullable fields, nested unions and local recursive
references. Optional properties, open objects, records and tuples are rejected
by the current portability policy. Prefer nullable fields to optional ones.
Transforms, coercion, preprocess, pipes, catch/prefault fallbacks, overwrite
checks and non-JSON types are rejected before Session creation. JSON-compatible
defaults are allowed, but missing required output fields still fail raw validation.

Refinements, including async refinements, and Zod format checks run locally.
Some cannot be represented in the model's JSON Schema; a local failure rejects
and does not trigger another model request. Ordinary mismatch throws
`AGENT_STRUCTURED_OUTPUT_INVALID`; an exception from a refinement throws
`AGENT_STRUCTURED_OUTPUT_VALIDATION_FAILED`. Missing and malformed JSON throw
`AGENT_STRUCTURED_OUTPUT_MISSING` and `AGENT_STRUCTURED_OUTPUT_NOT_JSON`.
Schema errors throw `INVALID_PARAMS`. Diagnostics omit output values and custom
refinement messages. Successful conversion does not guarantee that every schema
keyword is accepted by every native backend.

### Composition

`parallel()` and `pipeline()` accept typed objects directly. They also turn
callback exceptions into `null`, so a null slot in a composition does not identify
whether `agent()` returned null or threw. Catch inside callbacks if the application
needs to retain failure details. Pipeline skips remaining stages for null results;
use `value !== null` when filtering to retain valid falsy values.

### agent implementation status

Text and Zod results, schema preflight, typed composition, native terminal API
classification and Session cleanup are implemented. The SDK preserves optional
interrupted error metadata so trusted adapters can report an explicit skip.
There is no bundled user-skip control or startup safety classifier.

The pinned Claude Code reference documents `Promise<any>` and accepts JSON
Schema directly. Anureo's schema-associated Zod types are a local API design.
Claude's host also extracts its last assistant message, sanitizes directives,
attaches download records, and implements internal retry and orchestration
controls. Those host behaviors are not supplied by this package. No label/phase,
agent registry, automatic worktree, tool-rule, effort or stall options are exposed.

See the [workflow package guide](../../packages/workflow/README.md) and
[implementation](../../packages/workflow/src/agent.ts).

## parallel

### Calling convention and parameters

The reference describes its return type broadly as `Promise<any[]>`. The
Anureo TypeScript declaration below makes its runtime semantics explicit: await each
callback's return value, preserve its position, and allow `null` for a failed
callback. The generic tuple declaration is an Anureo type refinement, not the
reference's original declaration.

```ts
declare function parallel<const Tasks extends readonly (() => unknown)[]>(
  thunks: Tasks,
): Promise<{
  -readonly [K in keyof Tasks]: Awaited<ReturnType<Tasks[K]>> | null
}>
```

For example, callbacks returning `Promise<number>` and `string` produce
`Promise<[number | null, string | null]>` when passed as a tuple. A homogeneous
array of number-returning callbacks produces `Promise<(number | null)[]>`.
An empty tuple produces `Promise<[]>`. Adding `null` reflects failure isolation;
writing `any | null` would lose that distinction because it simplifies to `any`.

`thunks` is a required array of zero-argument functions. Each function may return
an ordinary value or a Promise. The result is awaited before being placed in the
output array. The functions can call [agent()](#agent) or ordinary application
code; `parallel()` itself does not require a Client or working directory.

Pass callbacks that start work when called. Passing already-started Promises,
non-function entries, or a non-array argument rejects the call with a `TypeError`.
The runtime validates every entry before starting callbacks. An empty array
resolves to `[]`.

### Scheduling and return values

All valid callbacks are started without waiting for earlier callbacks to finish.
`parallel()` is a barrier: its Promise resolves only after every callback has
settled. Output positions match input positions, regardless of completion order.

| Callback outcome | Result at that position |
| --- | --- |
| Returns an ordinary value | That value. |
| Returns a Promise that fulfills | The awaited value. |
| Returns `null` | `null`. |
| Throws synchronously or returns a rejected Promise | `null`; the reference host records the failure. |

A single callback failure does not reject the batch or cancel sibling work.
This isolation applies to callback execution; invalid arguments and host-level
execution failures are outside that guarantee. A callback that never settles
prevents normal batch completion.

The result is an array of values, not `PromiseSettledResult` records. A `null`
slot does not distinguish a callback that returned `null` from one that failed.
Valid falsy results such as `0`, `false`, `''`, and `undefined` are preserved.
Use `value !== null` when filtering dropped results.

#### Example

The following example demonstrates failure isolation.

```ts
const results = await parallel([
  () => 0,
  async () => 'ready',
  () => { throw new Error('task failed') },
  () => false,
])
// results: [0, 'ready', null, false]

const retained = results.filter(value => value !== null)
// retained: [0, 'ready', false]
```

Use [pipeline()](#pipeline) when each item can advance as soon as its own prior
stage completes. Use `parallel()` when the next operation needs the whole batch.
Callback concurrency does not establish model concurrency: the Claude Code host
queues actual `agent()` executions through a separate agent gate.

### parallel implementation status

| Feature | Current workspace status |
| --- | --- |
| Direct import, synchronous or asynchronous callbacks, input-ordered results, and empty batches | Implemented. |
| Result types preserved by tuple position | Implemented as an Anureo TypeScript convenience. |
| Start sibling callbacks even when one throws synchronously | Implemented. |
| Wait for all callbacks to settle and convert callback failures to `null` | Implemented with `Promise.allSettled()`. |
| Validate all entries before invoking any callback | Implemented. Invalid arrays or entries reject before callbacks start. |
| Failure logs | Supplied by the Claude Code host. Anureo does not emit logs from this primitive. |

The current declaration adds `null` to each result type automatically.
Its exact types and runtime behavior are defined by
[parallel.ts](../../packages/workflow/src/parallel.ts).

### Reference scope

The contract above follows the recovered
[parallel implementation](../../draft/docs/research/claude-code/snapshot-2.1.296/formatted/chunk-hedqf2m1.js#L1390).
The [isolated probe results](../../draft/docs/research/claude-code/snapshot-2.1.296/workflow-probe.json)
cover callback failure isolation; they are not an end-to-end host verification.
See the [official Workflow guide](https://code.claude.com/docs/en/workflows)
for Claude Code product usage.

The reference host also imposes a 4,096-element VM array bound and host execution
controls. Those belong to its execution environment. The current Anureo primitive
has no VM boundary, shared agent gate, or equivalent array limit.

## pipeline

### Calling convention and parameters

The reference describes the interface broadly as
`pipeline(items, stage1, stage2, ...): Promise<any[]>`. Anureo adds stage-to-stage
type checking and includes `null` in the final result type. The representative
zero-, one-, and two-stage declarations below express that refinement; the
implementation also provides contextual overloads through six stages and a
variadic overload for longer typed chains.

```ts
type WorkflowStage<Previous, Input, Output> = (
  prevResult: Exclude<Awaited<Previous>, null>,
  originalItem: Input,
  index: number,
) => Output

declare function pipeline<Input>(
  items: readonly Input[],
): Promise<(Awaited<Input> | null)[]>

declare function pipeline<A, B>(
  items: readonly A[], first: WorkflowStage<A, A, B>,
): Promise<(Awaited<B> | null)[]>

declare function pipeline<A, B, C>(
  items: readonly A[], first: WorkflowStage<A, A, B>,
  second: WorkflowStage<B, A, C>,
): Promise<(Awaited<C> | null)[]>
```

| Parameter | Contract |
| --- | --- |
| `items` | Required input array. Each position runs through its own stage sequence. |
| `...stages` | Zero or more functions, supplied as separate arguments in execution order. Each may return an ordinary value or a Promise. |
| `prevResult` | Awaited input item for the first stage; awaited result of the preceding stage thereafter. |
| `originalItem` | The original input entry, supplied to every stage without being replaced by stage results. |
| `index` | Zero-based position in the original input array, unchanged across stages. |

Stages may change the result type. Later stages can use `originalItem` and `index`
for context without adding that context to an earlier stage's return value.
For a Promise input entry, the first `prevResult` is its fulfilled value while
`originalItem` remains the original entry.

A non-array `items` argument rejects with a `TypeError`. For nonempty input,
every stage must be a function; invalid stages reject the call before processing
items. Empty input resolves to `[]`; the reference returns before checking stage
functions. Zero stages are valid: the output contains the awaited input values,
with rejected input Promises converted to `null`.

### Scheduling and return values

Each item awaits its own stages in order. Items advance independently: item A can
reach stage three while item B is still in stage one. There is no global barrier
between stages. The returned Promise waits for all item chains to settle, then
returns one result per original position in input order.

| Item outcome | Result and subsequent stages |
| --- | --- |
| All stages succeed | The awaited result of the last stage. |
| Awaited input or any stage result is `null` | Result is `null`; remaining stages for this item are skipped. |
| Input Promise rejects, a stage throws, or a stage Promise rejects | Result is `null`; remaining stages for this item are skipped and the reference host records the failure. |
| Result is `0`, `false`, `''`, or `undefined` | Passed to the next stage normally. Only `null` short-circuits. |

An item failure does not reject the whole pipeline or cancel other items.
Invalid composition arguments and host-level execution failures are outside
this isolation guarantee. An item chain that never settles prevents normal
pipeline completion.

The output is an array of final values, not per-stage histories or
`PromiseSettledResult` records. It retains `null` positions rather than removing
them. Use `value !== null` to filter dropped results while retaining other falsy
values. A `null` result alone does not identify the failing stage or distinguish
failure from an explicit `null` return.

#### Example

The following example demonstrates callback arguments and null semantics.

```ts
const results = await pipeline(
  ['a.ts', 'skip.ts', 'bad.ts'],
  async file => {
    if (file === 'skip.ts') return null
    if (file === 'bad.ts') throw new Error('review failed')
    return { findings: 2 }
  },
  (review, originalFile, index) => ({
    file: originalFile,
    index,
    findings: review.findings,
  }),
)
// results: [{ file: 'a.ts', index: 0, findings: 2 }, null, null]
```

The second stage runs only for `a.ts`. It receives the first stage's result along
with the original filename and input position.

Stages can call [agent()](#agent) or ordinary application code. In the reference
Claude Code host, actual model concurrency is governed separately by its agent
gate. The Anureo primitive itself does not provide a shared agent gate.
Use [parallel()](#parallel) followed by another operation when that operation
needs all prior results together.

### pipeline implementation status

| Feature | Current workspace status |
| --- | --- |
| Direct import, independent item chains, awaited stage results, input order, and empty input with valid stages | Implemented. |
| Stage-to-stage type checking and final result type inference | Implemented as Anureo TypeScript conveniences. |
| Stage callback arguments (`prevResult`, `originalItem`, `index`) and awaited inputs | Implemented. The original input entry remains available even when it is a Promise. |
| Convert item failures to `null` and await all item chains | Implemented with `Promise.allSettled()`. |
| Stop an item's remaining stages when input or a result is `null` | Implemented. Other falsy values continue normally. |
| Zero stages | Implemented in the types and runtime. |
| Return `[]` before stage validation for empty input | Implemented. |
| Failure logs | Supplied by the Claude Code host. Anureo does not emit logs from this primitive. |

The return type is an array of the awaited final stage type plus `null`, including
when an earlier stage fails or returns `null`. With zero stages it is the awaited
input type plus `null`. Stage input types exclude only `null`, preserving
`undefined`. Its exact types and runtime behavior
are defined by [pipeline.ts](../../packages/workflow/src/pipeline.ts).

### Reference scope

The contract above follows the recovered
[pipeline implementation](../../draft/docs/research/claude-code/snapshot-2.1.296/formatted/chunk-hedqf2m1.js#L1402).
The [isolated probe results](../../draft/docs/research/claude-code/snapshot-2.1.296/workflow-probe.json)
cover independent advancement, callback context, null short-circuiting, and item
failure isolation; they are not an end-to-end host verification.
See the [official Workflow guide](https://code.claude.com/docs/en/workflows)
for Claude Code product usage.

The reference host also imposes a 4,096-element VM array bound and host execution
controls. Those belong to its execution environment. The current Anureo primitive
passes ordinary TypeScript values without a VM clone boundary and has no equivalent
array limit or shared agent gate.
