# Durable workflows

`workflow(options, body)` adds a durable run identity and an agent-call journal
to ordinary TypeScript functions. It is optional: `agent`, `parallel`, and
`pipeline` remain independently callable, and `agent()` outside `workflow()` is
unchanged. Inside a workflow body, every `agent()` call is checkpointed
automatically — there is no explicit step API. The package requires Node.js
22+; TypeScript loading is supplied by the application, such as Bun or tsx.

## Start and resume

The following example persists journaled agent calls against a scripted
backend without real model requests or credentials:

```ts
import { resolve } from 'node:path'
import { agent, pipeline, workflow } from '@anureo/workflow'

export function answerQuestions(client: Client, resumeFrom?: string) {
  return workflow({
    name: 'answers', revision: '1',
    directory: resolve('.anureo/workflows'),
    input: { questions: ['Map the modules.', 'List risky files.'] }, resumeFrom,
  }, async run =>
    pipeline(run.input.questions, async question =>
      agent(promptFor(question), { client, cwd: process.cwd(), schema })))
}
```

The return value is `{ runId, status, result }`. `status` is `completed` when
the body and all journaled agent calls succeed, or `incomplete` when an agent
failure or dropped (`null`) result was caught by the body or a composition
primitive and the body still returned. Uncaught body errors, storage failures,
unknown execution outcomes and cleanup failures reject with a `HarnessSdkError`
carrying `details.runId` and the storage root in `details.directory`.

Run the [executable example](../../examples/workflow-persistence.ts) with
`bun run example:workflow-persistence`. Pass the printed run ID on the next
call: `bun run example:workflow-persistence <runId>`. Identical agent calls
return their saved results; the resumed run opens zero new sessions.

## Run options and context

| Field | Contract |
| --- | --- |
| `name` | Required nonempty workflow type identifier. Resume requires the same name. It does not register a function. |
| `revision` | Required nonempty caller-maintained version. Resume requires the same revision; bump it to invalidate every journaled result at once. |
| `directory` | Required storage root. Each run occupies `<directory>/<runId>/`. |
| `runId` | Optional preallocated new identity; otherwise a full UUID is generated. Existing nonempty directories cannot be overwritten. A chosen ID must be a nonblank single path segment of at most 255 UTF-8 bytes; Unicode and spaces are allowed, separators, control characters, `.` and `..` are rejected. |
| `input` | Required JSON input. A deep-frozen copy is provided as `run.input`. |
| `resumeFrom` | An old run ID under the same root, or `{ directory, runId }` to specify another root. |

`run.runId` is available after its initial manifest is saved and before any
agent call executes. Resume creates a new run ID, records its source, keeps the
source directory unchanged, and copies the source journal into the new run —
afterwards the source directory can be deleted.

The application supplies the current function, arguments, Clients and
configuration on every call. The library does not load source code or
automatically restore old arguments or credentials. It reruns the body from its
beginning, using the journal only at `agent()` calls. Ordinary JavaScript
between agent calls always re-executes; `parallel`/`pipeline` intermediate
values are not checkpointed, and JS variables, timers and Promise stacks are
not saved.

## Agent journal contract

Inside a workflow body, each `agent(prompt, options)` call:

1. Computes a chained cache key from the previous call's key, the prompt, and
   the canonical semantic options.
2. Returns the saved result immediately when the key matches a journaled
   result and no earlier call in this run has diverged. No session is opened.
3. Otherwise executes normally: a `started` event is persisted before the
   session opens, and the full validated result (or a `failed` event) is
   persisted before the value returns.

The cache key is:

```text
key = "v1:" + SHA256(previousKey + NUL + prompt + NUL + canonicalOptions)
```

`previousKey` starts empty and advances in host invocation order — the order
`agent()` is entered, never completion order. `canonicalOptions` includes
`model`, `instructions`, `permissionMode`, the converted output `schema`
(the same portable subset as [agent schema mode](README.md#schema-mode)),
`cwd`, and the Client identity (`adapterId`, `runtimeConfigId`), with object
keys recursively sorted. Because each key chains on the previous one, changing
any call invalidates every later call automatically: a resume reuses the
longest unchanged prefix of calls and re-executes the rest.

Consequences to design around:

- **Prompt determinism.** The body must produce identical prompts for identical
  `input` and identical journaled upstream results. Timestamps, random values,
  or environment reads inside prompt construction silently bust the cache —
  correct, but expensive. Stamp results after the workflow returns, or pass
  such values through `input`.
- **Stale environment hits.** A cache hit does not recheck the file system or
  external services. When an answer depends on mutable state — reviewed source
  files, for example — embed a content fingerprint in the prompt so changed
  state produces a changed key. `code-review` embeds a `git rev-parse HEAD` +
  `git status` digest in every prompt for this reason.
- **Client identity participates.** Switching backend or runtime configuration
  misses the cache even when prompts are identical.

Journaled results accept null, booleans, finite numbers, strings, dense arrays
and plain objects — the JSON subset enforced by schema validation. Returned
values are separate deep copies of the stored ones.

## Failure and recovery decisions

| Prior journal state for the key | Resume behavior |
| --- | --- |
| `result` | Deep-copied value returned after schema revalidation; no session is opened. |
| `started` without a terminal event (crash mid-call) | Re-execute the call; later calls keep their reuse eligibility. |
| `failed` with `outcomeUnknown: false` | Re-execute; downstream calls re-execute too (prefix invalidation). |
| `failed` with `outcomeUnknown: true` | Reject with `WORKFLOW_RECONCILIATION_REQUIRED`; the previous outcome is unknown and re-running could duplicate side effects. |
| No entry, or a format-v1 run directory | Execute after saving `started`. Corrupt or missing journals reject with `WORKFLOW_CHECKPOINT_INVALID`; nothing silently reruns. |
| Source writer still active, on another host, or unverifiable | Reject with `WORKFLOW_SOURCE_ACTIVE`. |

Dropped agents (`null` results) append a `failed` event with code
`AGENT_DROPPED`, mark the run `incomplete`, and re-execute on resume. Agent
failures caught by `parallel`/`pipeline` keep the run `incomplete` and are
re-attempted on resume. There is no automatic retry inside an invocation.
Side effects of re-executed calls (file edits, messages, deployments) may occur
twice; idempotent agents or content fingerprints in prompts are the
application's responsibility. Releasing a Session or detecting a dead writer
does not prove that an underlying backend execution stopped.

While running, storage errors, `outcomeUnknown` and cleanup failures stop new
agent dispatch. Already started calls settle before the workflow rejects. A
body or composition primitive catching an error cannot clear this stopping
state. Agent calls entered from async contexts detached from the body (for
example a callback invoked after the body returned) do not see the run context
and execute as ordinary unjournaled `agent()` calls.

The journal closes when the body settles; registered calls are drained, and
agent calls entered after that reject with `WORKFLOW_CLOSED`. No implicit
concurrency cap or backend cancellation is added. Failed-item coverage remains
an application responsibility.

## Files and durability

Each run stores `run.json`, `journal.json`, and the body's final `result.json`
under an exclusive `writer.lock`. The journal is republished atomically
(same-directory temporary file, flush, rename, containing-directory flush)
after every event, serialized across concurrent calls. `run.json` uses
checkpoint format version 2; run directories written by the previous
explicit-step format are rejected on resume rather than migrated. Node's
Windows implementation does not expose directory fsync, so that part of the
durability guarantee is unavailable there. No device power-loss guarantee has
been established.

Only the owning writer releases `writer.lock`. A stale source lock is accepted
only when its recorded host matches and the recorded PID is confirmed absent;
a reused or inaccessible PID is conservatively treated as active. This is a
local single-writer protocol, not a distributed lease or background adoption
service.

Final state publication and lock release are separate operations. If release
fails after the result was committed, the caller receives an error while the
committed result remains on disk. Inspect that evidence before choosing a
recovery action.
