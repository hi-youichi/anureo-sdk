# @anureo/workflow

Three directly imported primitives for ordinary TypeScript workflows:
`agent`, `parallel`, and `pipeline`. The host creates SDK Clients, imports its
workflow functions, awaits their results, and handles errors with normal TS.

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
    findings => agent(`Independently verify these findings:\n${findings}`, options),
  )
  const [summary, tests] = await parallel([
    () => agent(`Summarize: ${JSON.stringify(verified)}`, options),
    () => agent(`Suggest regression tests: ${JSON.stringify(verified)}`, options),
  ])
  return { verified, summary, tests }
}
```

Import `reviewFiles` from another TS file and call it with a Client. There is no
workflow registration, source-string execution, ambient context, or runtime setup.

## agent

```ts
import { agent, type AgentOptions } from '@anureo/workflow'

const options: AgentOptions = { client, cwd: process.cwd() }
const text: string = await agent('Inspect the authentication module.', options)
```

`AgentOptions` requires `client` and `cwd`; `model` and `instructions` are optional
session settings. Every call creates a fresh Session, submits once, waits for
the associated Turn's actual terminal result, and returns its final text.
Pass a different Client to select a different backend. The Client is borrowed;
the caller owns its lifetime and must eventually call `client.dispose()`.

Failed executions throw a `HarnessSdkError` preserving the native error fields;
interrupted executions throw `AGENT_INTERRUPTED`. Unknown outcomes keep
`outcomeUnknown: true` and are never retried. Closing or disposing the owned
session observation is not a claim that an uncertain backend execution stopped.
Cleanup is attempted on success and failure. A cleanup-only failure throws
`RESOURCE_RELEASE_FAILED`; when execution also failed, the primary code and
uncertainty remain intact and cleanup errors are attached in `details.cleanupErrors`.

The primitive does not parse JSON, enforce an output schema, or introduce its own
execution deadline. For raw items, usage, event observation, or exact execution
controls, use the SDK Session/Turn APIs directly. Project functions can explicitly
parse agent text and pass typed values to later stages.

## parallel

`parallel([() => taskA(), () => taskB()])` starts every callback and returns
input-ordered results. Callbacks may return ordinary values or Promises; inline
heterogeneous tuples preserve each result's type. An empty batch returns `[]`.

Synchronous throws become rejected tasks without skipping the other callbacks.
The returned Promise rejects on failure; already-started siblings continue.
There is no implicit interruption, shared scheduler, or concurrency limit.

## pipeline

`pipeline(items, stage1, stage2, ...)` runs each item through its own sequence of
stages. A fast item can enter stage two while another item is still in stage one.
Results retain input order. Empty input returns `[]`; at least one stage is required.

The first stage receives the original item. Each later stage receives the awaited
result of the previous stage. Stages may change types and pass ordinary TS values,
including objects and Maps, without a JSON serialization boundary.

Inline callbacks have contextual type inference for up to six stages. Longer
chains accept typed stage functions with no runtime stage-count limit. Incompatible
stage inputs are compile-time errors. If one item fails, its subsequent stages
are skipped and the returned Promise rejects; other started items continue.

## Examples

Run `bun run example:workflow` from the repository. The ordinary
[TypeScript example](../../examples/workflow.ts) directly imports all three
primitives and uses the Codex adapter. It requires a configured, authenticated
Codex CLI on PATH (`CODEX_BIN` can override its path). It prints every agent
input and output; each prompt requests arithmetic without tools.

For `[2, 3, 4]`, the pipeline asks the model to double then square each value, expecting
`[16, 36, 64]`. Two parallel agent calls then calculate the sum `116` and maximum `64`.
The eight agent calls each use an independent Session.

For an example using a real model on actual code, run `bun run example:readability`.
The [readability review workflow](../../examples/readability-review.ts) imports the
same three primitives, performs two review perspectives and independent verification,
and writes a Chinese Markdown report. It requires a logged-in local Codex CLI.
See the [usage guide](../../docs/readability-review-example.md) for paths and trace output.

The [migration plan](../../docs/workflow-primitives-plan.md) records the removed
framework and the [development record](../../docs/development.md#workflow-原语收敛)
contains current verification evidence. The package has only its root entry;
there is no `/mcp` subentry.
