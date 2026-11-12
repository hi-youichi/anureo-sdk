---
name: workflow-authoring
description: Author ordinary TypeScript workflows with Anureo's agent, parallel, pipeline, and optional durable workflow primitive, explicit Clients, and business-owned validation.
---

# Workflow authoring reference

An Anureo workflow is an ordinary TypeScript function that coordinates independent
agent sessions and application code. Import `agent`, `parallel`, and `pipeline`
from `@anureo/workflow`, pass an initialized SDK Client and working directory,
and await the function's result.
For durable execution identity and explicit step checkpoints, wrap the function
with optional `workflow()`. See the [persistence contract](persistence.md).

This guide describes the current workspace implementation. The [agent contract](README.md#agent) documents supported options, Zod output
constraints and differences from Claude Code's host.

## Choose the work before the orchestration

Start by inspecting enough of the task to identify its inputs, dependencies, and
completion criteria. A useful workflow usually has one bounded purpose:

- **Understand:** read independent subsystems and combine their maps.
- **Design:** generate alternative approaches, compare them, and synthesize a plan.
- **Review:** find candidate issues, independently verify them, then summarize.
- **Research:** search through different sources, read evidence, and synthesize.
- **Migrate:** discover change sites, assign ownership, transform, and verify.

Keep discovery and decision points visible to the caller. For larger work, await
one workflow, inspect its result, then decide which function to call next. A
workflow can call another workflow through an ordinary function import.

## Current API

```ts
import type { Client } from '@anureo/sdk'
import { agent, parallel, pipeline, type AgentOptions } from '@anureo/workflow'

const options = {
  client, // An initialized Client supplied by the caller.
  cwd,    // The working directory supplied by the caller.
}
const text: string | null = await agent('Inspect the authentication module.', options)
```

The snippet assumes `client` and `cwd` already exist. The complete example below
shows their ownership.

| Primitive | Inputs | Result and execution behavior |
| --- | --- | --- |
| `agent(prompt, options)` | A prompt and `{ client, cwd, model?, instructions?, schema? }`. | Creates a fresh Session, submits once, waits for the terminal Turn result, and returns text or inferred Zod data, with `null` for designated terminal failures. Other execution, interruption, and cleanup failures reject. |
| `parallel(tasks)` | An array of callbacks returning ordinary values or Promises. | Starts all callbacks and waits for all to settle. Results retain input positions; a callback failure becomes `null`. |
| `pipeline(items, ...stages)` | An input array and zero or more stage functions. | Each item advances independently through its stages. Results retain input positions; a failure or explicit `null` skips that item's remaining stages. |

Every pipeline stage receives `(prevResult, originalItem, index)`. Later stages
can use the original item and index without carrying them in every intermediate
result. Stages may change types. Inline callbacks have contextual type inference
through six stages; longer chains can use explicitly typed stage functions.

Each `agent()` call starts a new conversation. A later call learns earlier results
only through the prompt or other context the application explicitly supplies.
Use the SDK Session API directly when multiple turns must share a conversation.
Pass a different Client to choose a different backend. Omit `model` to use that
backend's configured default; there is no ambient parent-agent model to inherit.

## Complete example: review and verify files

The host creates the Client and disposes it after the workflow completes. Each
`agent()` call owns and releases its Session resources; it borrows the Client.
This example requires a configured, authenticated Codex CLI and makes real model
requests. Run it from the repository root with a TypeScript runner such as Bun.

```ts
import { createClient, type Client } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { agent, pipeline } from '@anureo/workflow'

async function reviewFiles(client: Client, cwd: string, files: readonly string[]) {
  const options = {
    client,
    cwd,
    instructions: 'Read and analyze code. Do not modify files. Cite file paths and code evidence.',
  }
  const results = await pipeline(
    files,
    file => agent(`Review ${file} for correctness issues. Explain each candidate.`, options),
    (findings, file) => agent(
      `Independently verify these candidate issues in ${file}. Read the code and try to refute each claim.\n${findings}`,
      options,
    ),
    (verification, file) => ({ file, verification }),
  )
  return results.map((result, index) => result ?? {
    file: files[index]!,
    verification: 'Review incomplete: a stage failed.',
  })
}

const client = await createClient({
  adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'workflow-review' },
})
try {
  const files = ['packages/workflow/src/parallel.ts', 'packages/workflow/src/pipeline.ts']
  console.log(await reviewFiles(client, process.cwd(), files))
} finally {
  await client.dispose()
}
```

Prompt instructions express the intended task. Enforced tool permissions are
configured through the selected backend and SDK session facilities.

## Choose pipelines or barriers from data dependencies

Use `pipeline()` when an item can proceed as soon as its own previous stage
finishes. A fast file review can enter verification while a slower file is still
being reviewed. Each item's stages remain sequential.

Use `parallel()` as a barrier when the next operation needs the whole batch:

- Deduplicate findings across all files before expensive verification.
- Compare independent approaches against each other.
- Decide whether there are any findings before starting the next phase.

Mapping or filtering an individual result does not require a barrier. Put that
transformation inside the item's pipeline. Both primitives return only after
all their work settles; pipeline independence applies between item stages.

The following function deliberately waits for both perspectives before synthesis:

```ts
import { agent, parallel, type AgentOptions } from '@anureo/workflow'

export async function compareApproaches(task: string, options: AgentOptions) {
  const drafts = await parallel([
    () => agent(`Propose a minimal implementation for: ${task}`, options),
    () => agent(`Propose an approach focused on failure recovery for: ${task}`, options),
  ])
  if (drafts.some(draft => draft === null)) throw new Error('Design panel incomplete')
  return agent(`Compare these approaches and explain the chosen design:\n${JSON.stringify(drafts)}`, options)
}
```

## Handle failures without losing coverage

A direct `agent()` call returns `null` for designated, confirmed terminal API
failures or trusted adapter skip/startup-block reasons. Other failures throw a
`HarnessSdkError`; ordinary interrupted execution throws `AGENT_INTERRUPTED`. Native error fields, including `outcomeUnknown`, are
preserved. The primitive never automatically resubmits a prompt. Releasing a
Session's observation resources does not prove an uncertain backend execution
stopped.

Inside `parallel()` or `pipeline()`, a callback exception becomes `null`. Neither
primitive logs the error, retries the work, or cancels siblings. Invalid arguments
to the composition call still reject it. If callers need error details, catch
inside the callback and return an application-defined outcome object containing
the original input and error fields.

Keep `null` positions until they have been associated with the original inputs.
Use `value !== null` when filtering: `0`, `false`, `''`, and `undefined` are valid
results, and only `null` short-circuits a pipeline. An empty successful agent
response is an empty string, not proof that the requested analysis was completed.

Report failed, skipped, sampled, and unverified items separately from successful
items with no findings. Filtering failed reviews out of a final report can make
incomplete coverage appear complete.

## Structured data

Pass a Zod object schema to `agent()` to request structured output and infer the
return type from that schema:

```ts
import { z } from 'zod'
import { agent } from '@anureo/workflow'

const result = await agent('List issues in the authentication module.', {
  client,
  cwd,
  schema: z.strictObject({ issues: z.array(z.string()) }),
})
if (result !== null) {
  const issues: string[] = result.issues
  console.log(issues)
}
```

The SDK selects native output, direct Pi tools, or a session-scoped MCP bridge;
see [structured output](../structured-output.md) for supported adapters and limits.
The library converts the schema for the backend, parses complete final JSON,
validates raw data and calls the original schema's `safeParseAsync()`. It returns
validated data, without caller parsing or casts. Use required fields and closed
objects; prefer nullable fields over optional ones. Value transforms, open
objects, records, tuples and non-JSON values are outside the current portable
subset. Zod refinements may run only locally; local validation failure rejects
without retrying the model. See the [schema contract](README.md#schema-mode).

The [workflow structured example](../../examples/workflow-structured.ts) runs the
same Zod schema on Codex and Claude. For raw JSON Schema and multi-turn execution,
use SDK Session/Turn APIs as in the
[SDK structured-output example](../../examples/structured-output.ts).

## Concurrency and file ownership

The composition primitives start all item chains or callbacks without a shared
agent scheduler, concurrency cap, or agent-count budget. Nested calls multiply
the work: ten items with three independent readers can start thirty sessions.
Actual execution remains subject to backend capacity and limits.

Choose a workload limit in the host application. A simple approach is to process
bounded batches; use a shared application scheduler when several workflows must
share the same capacity limit. Batch boundaries introduce a barrier, so choose
them deliberately. For either primitive, the array size determines how many task
chains the call starts; it does not configure the backend's model-concurrency
limit, and each chain may start nested work.

All sessions using the same `cwd` can access the same files. Before parallel
mutations, give each job exclusive file ownership or have the application create
separate Git worktrees and pass their directories as `cwd`. The workflow library
does not create or merge worktrees. Include verification and cleanup in the same
ownership plan; independent sessions do not provide filesystem isolation.

## Quality patterns

Use these patterns in proportion to the requested depth and cost:

- **Adversarial verification:** ask an independent agent to refute a candidate,
  read the relevant source, and provide evidence for its verdict.
- **Different verification perspectives:** check correctness, reproducibility,
  security, or performance separately when they have different failure modes.
- **Design panel:** generate independent approaches, compare them, then combine
  the supported ideas. Supply the drafts explicitly to the synthesis call.
- **Different search methods:** search by subsystem, symbol, content, or history
  when a single method may miss relevant evidence.
- **Completeness review:** ask what remains unexamined or unverified, then turn
  those gaps into concrete follow-up work.
- **Repeat until no new findings:** deduplicate against every previously seen
  candidate, including rejected ones, and stop after a chosen number of rounds
  with no new findings. Failed discovery rounds do not count as empty rounds.

For loops, define an application-owned stopping condition such as a maximum
number of rounds or an explicit work list. If a bound is reached, report remaining
work. `@anureo/workflow` supplies no token-budget counter. Majority votes can help
prioritize evidence; agreement alone does not verify a claim.

## Progress, persistence, and recovery

Pass a progress callback into your workflow function or use application logging.
Include the item and stage in each event so concurrent callbacks remain
attributable. For per-agent events or usage, use the SDK Session/Turn APIs directly;
the workflow `agent()` returns only final text or validated Zod data, or `null`.

The application owns script files, arguments, Clients and business validation.
Optional `workflow()` manages a durable run ID and an automatic agent-call
journal: every `agent()` call inside the body is checkpointed by its chained
prompt-and-options key, and resume reuses the longest unchanged call prefix
without opening sessions. Prompts must be deterministic for identical input and
embed content fingerprints when answers depend on mutable state such as source
files. There is no required meta literal, injected args, phase/log API,
registry or VM. Direct three-primitive functions remain ordinary TypeScript
without persistence.

For recoverable read-only work, make each agent call a pure function of its
prompt: embed the item's input identity, source version, and relevant options,
so a resume reuses completed items and re-executes only the rest. SDK session
resume restores a backend conversation; it does not replay a workflow's control
flow or restore application state. For mutations or uncertain execution
outcomes, inspect the resulting state before deciding whether any work is safe
to repeat; prior calls with unknown outcomes require reconciliation on resume.

## Further examples and implementation references

- [Workflow example](../../examples/workflow.ts): stages that change value types
  and parallel summary calls through a real Codex Client.
- [Zod workflow example](../../examples/workflow-structured.ts): inferred object
  results from both Codex and Claude using the same schema.
- [Persistence example](../../examples/workflow-persistence.ts): run IDs and agent
  journal replay with a scripted backend and no model calls.
- [Package guide](../../packages/workflow/README.md): supported interface and
  resource ownership.
- [agent implementation](../../packages/workflow/src/agent.ts),
  [parallel contract](README.md#parallel), and [pipeline contract](README.md#pipeline): exact
  current behavior and composition edge cases.
