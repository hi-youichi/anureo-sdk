# Durable workflows

`workflow(options, body)` adds a durable run identity and explicit checkpoints to
ordinary TypeScript functions. It is optional: `agent`, `parallel`, and `pipeline`
remain independently callable. The package requires Node.js 22+; TypeScript loading
is supplied by the application, such as Bun or tsx.

## Start and resume

The following example persists deterministic application callbacks without model
requests or credentials:

```ts
import { resolve } from 'node:path'
import { z } from 'zod'
import { pipeline, workflow } from '@anureo/workflow'

export function squareNumbers(resumeFrom?: string) {
  return workflow({
    name: 'square-numbers', revision: '1',
    directory: resolve('.anureo/workflows'),
    input: { numbers: [2, 3, 4] }, resumeFrom,
  }, async run => {
    console.log(`Run: ${run.runId}`)
    return pipeline(run.input.numbers, number => run.step({
      key: `square:${number}`, input: { number },
      schema: z.strictObject({ value: z.number() }),
      recovery: 'repeatable',
    }, () => ({ value: number * number })))
  })
}
```

The return value is `{ runId, status, result }`. `status` is `completed` when the
body and all requested steps succeed, or `incomplete` when a step failure was
caught by the body or a composition primitive and the body still returned.
Uncaught body errors, storage failures, unknown execution outcomes and cleanup
failures reject with a `HarnessSdkError` carrying `details.runId` and the storage
root in `details.directory`.

Run the [executable example](../../examples/workflow-persistence.ts) with
`bun run example:workflow-persistence`. Pass the printed run ID on the next call:
`bun run example:workflow-persistence <runId>`. Compatible steps return their saved
values; the example's execution messages appear only for steps that actually run.

## Run options and context

| Field | Contract |
| --- | --- |
| `name` | Required nonempty workflow type identifier. Resume requires the same name. It does not register a function. |
| `revision` | Required nonempty caller-maintained version for execution and local validation logic. Changes invalidate saved steps. |
| `directory` | Required storage root. Each run occupies `<directory>/<runId>/`. |
| `runId` | Optional preallocated new identity; otherwise a full UUID is generated. Existing nonempty directories cannot be overwritten. |
| `input` | Required JSON input. A deep-frozen copy is provided as `run.input`; changes conservatively invalidate all steps. |
| `resumeFrom` | An old run ID under the same root, or `{ directory, runId }` to specify another root. |

`run.runId` is available after its initial manifest is saved and before any step
executes. Resume creates a new run ID and records its source; it keeps the source
directory unchanged. A chosen ID must be a nonblank single path segment of at most
255 UTF-8 bytes. Unicode and spaces are allowed for existing application output
names; separators, control characters, `.` and `..` are rejected. Filesystem-specific
filename restrictions still apply.

The application supplies the current function, arguments, Clients and configuration
on every call. The library does not load source code or automatically restore old
arguments or credentials. It reruns the body from its beginning, using checkpoints
only at explicit `run.step()` calls. JS variables, timers and Promise stacks are
not saved.

## Step contract

`run.step(options, execute)` returns `Promise<z.output<S>>`, inferred from its Zod
object schema. `execute` may return the schema's output, `null`, or a Promise of
either. A `null` result records incompleteness and rejects with
`WORKFLOW_STEP_INCOMPLETE`; it never creates a successful checkpoint.

| Field | Contract |
| --- | --- |
| `key` | Required unique logical step identity within one body invocation; nonempty and at most 1,024 UTF-8 bytes. Prefer business IDs over positions. |
| `input` | Required declared JSON dependencies of this step. Captured synchronously before execution. |
| `schema` | Required Zod object schema. Uses the same portable subset and local validation as [agent schema mode](README.md#schema-mode). |
| `recovery` | `manual` by default, or `repeatable` as an explicit assertion that repeating the operation is safe. |
| `reuse` | Optional sync/async `(savedValue) => boolean` for checking external dependencies and business invariants. |

Declare prompts, model and backend configuration, instructions, source content
hashes, relevant budgets and upstream business results in the input. The library
does not inspect function closures or discover file dependencies. The fingerprint
includes the workflow's name, revision, root input, step key, step input and
converted schema. Concurrent invocation and completion order do not affect it.
Change `revision` when local refinements or implementation logic change.

On a match, the result is checked against its saved digest and current schema,
then passed as a frozen copy to `reuse`. `false` invalidates the result; an exception
fails the step. Perform the equivalent business checks inside `execute` before
returning a fresh value. Schema and reuse checks may run again on every resume.
Put checkpoint calls in the body and use composition functions around them;
avoid nesting checkpoint boundaries inside another step's execution callback.

JSON inputs and saved outputs accept null, booleans, finite numbers, strings,
dense arrays and plain objects. They reject undefined, functions, dates, Maps,
cycles, getters, sparse arrays and hidden or Symbol properties. Plain composition
outside persistence retains its usual support for ordinary TypeScript values.
Saved results and returned objects use separate copies.

## Failure and recovery decisions

| Old state | Resume behavior |
| --- | --- |
| No previous record for the key | Execute once after saving started. |
| Compatible committed result, accepted by schema/reuse | Copy the result into the new run and return it without execute. |
| Old record exists but has no reusable result | `manual` rejects with `WORKFLOW_RECONCILIATION_REQUIRED`; `repeatable` permits one new attempt. |
| Corrupt JSON, versions, digests, missing committed material or links in record paths | Reject recovery with `WORKFLOW_CHECKPOINT_INVALID`; do not silently rerun. |
| Source writer still active, on another host, or unverifiable | Reject with `WORKFLOW_SOURCE_ACTIVE`. |

`repeatable` permits new attempts only during an explicit new invocation with
`resumeFrom`. It includes the possibility of repeating an old unknown execution.
There is no automatic retry inside an invocation. File changes, commits, messages
or deployments need application-specific state checks or idempotency before this
policy is appropriate. Releasing a Session or detecting a dead writer does not
prove that an underlying backend execution stopped.

While running, storage errors, `outcomeUnknown` and cleanup failures stop new step
dispatch. Already started steps settle before the workflow rejects. A body or
composition primitive catching an error cannot clear this stopping state.
Known step failures remain incomplete even when `pipeline` or `parallel` converts
their exceptions to null. Errors in unregistered application work require the
application's own coverage/error handling.

The step API closes when the body settles; registered steps are drained, and
late calls reject with `WORKFLOW_CLOSED`. No implicit concurrency cap or backend
cancellation is added. Input versioning and failed-item coverage remain application
responsibilities.

## Files and durability

Each run stores `run.json`, `attempts/`, `results/`, `checkpoints/`, a self-contained
`inherited/` source index and the body's final `result.json`. Initialization and
step starts are awaited; result data is written before its completion record.
Same-directory temporary files are flushed and renamed; macOS/Linux also flush
the containing directory. Node's Windows implementation does not expose directory
fsync, so that part of the durability guarantee is unavailable there. No device
power-loss guarantee has been established.

Only the owning writer releases `writer.lock`. A stale source lock is accepted
only when its recorded host matches and the recorded PID is confirmed absent;
a reused or inaccessible PID is conservatively treated as active. This is a local
single-writer protocol, not a distributed lease or background adoption service.

Effective history is carried into each resumed run, including keys not requested
by a new branch. A newer failed or unfinished attempt shadows historical success.
Deleting the old directory after successful source import does not remove the new
run's checkpoint data. Arbitrary external files referenced by returned values are
not backed up; use `reuse` to validate or reconstruct them.

Final state publication and lock release are separate operations. If release fails
after the result was committed, the caller receives an error while the committed
result remains on disk. Inspect that evidence before choosing a recovery action.
