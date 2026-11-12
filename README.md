# Anureo SDK

Build TypeScript applications that use Codex, Claude, Hermes, ACP agents, and external
AHP harnesses through a shared client interface.

- **Connect backends:** choose an adapter and manage it through the same SDK.
- **Manage conversations:** create Sessions, submit input, observe Turn results,
  and handle approvals and execution controls supported by the backend.
- **Compose workflows:** combine independent agent calls with `agent`, `parallel`,
  and `pipeline` in ordinary TypeScript functions.

The Anureo Harness Protocol (AHP) defines the shared lifecycle and wire contract.
Available operations depend on each adapter's declared capabilities; check those
capabilities before using optional features such as fork, revert, or steering.

## Getting started

> This README describes the unreleased workspace API, including `createClient`,
> `Session`, `Turn`, and `@anureo/workflow`. The published 0.2.0 API differs;
> see the [changelog](CHANGELOG.md) for release and migration details. Use the
> source checkout below to run these examples.

Requirements: Node.js 22+ with npm, Bun 1.4.2+, Git, and the Codex CLI on PATH.
The example uses your Codex account and makes a real model request.

```sh
git clone https://github.com/hi-youichi/anureo-sdk.git
cd anureo-sdk
bun install --frozen-lockfile
codex login
bun run example
```

The [greeting example](examples/greeting.ts) prints the model's greeting as it
streams in. The wording varies between runs. Set `CODEX_BIN` if the Codex CLI is
installed outside PATH.

## Usage example

Save the following as `examples/hello.ts` in the checkout and run
`bun examples/hello.ts` after completing the setup above. It opens a conversation,
waits for the final answer, checks the terminal status, and releases resources.

```typescript
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

const client = await createClient({
  adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})
try {
  const session = await client.sessions.create({
    cwd: process.cwd(),
    permissionMode: 'read-only',
    instructions: 'Answer directly without reading files or running commands.',
  })
  const turn = await session.submit({ input: 'Say hello in one sentence.' })
  const result = await turn.result()
  if (result.status === 'failed') throw new Error(result.error.message)
  if (result.status !== 'completed') throw new Error(`Turn ${result.status}`)
  console.log(result.text)
  await session.close()
} finally {
  await client.dispose()
}
```

A Session holds a conversation; a Turn represents an execution associated with
submitted input. Use `session.events()` for streaming progress. The
[SDK guide](packages/core/README.md) covers events, approvals, interruption,
capability checks, and resource ownership.

## Workflow

`@anureo/workflow` provides composition and optional persistence for ordinary TypeScript functions:

| Primitive | Purpose |
| --- | --- |
| `agent(prompt, { client, cwd })` | Run a fresh Session and return text or typed Zod data, with designated failures as `null`. |
| `parallel(tasks)` | Start callbacks concurrently, wait for all to settle, and return results in input order. |
| `pipeline(items, ...stages)` | Advance each item independently through its sequential stages and return results in input order. |
| `workflow(options, body)` | Persist a run ID and explicit step results, then recover compatible work with `resumeFrom`. |

Direct `agent()` calls return `null` for designated confirmed terminal failures;
other failures throw. Pass a Zod object as `schema` to infer structured results.

Schema calls use native output when available, with an MCP result bridge on
supported ACP and Hermes sessions, and direct tools on Pi. See [structured output](docs/structured-output.md)
for adapter requirements, tool definitions and process lifecycle.
Inside `parallel()` and `pipeline()`, callback failures become `null` at their
original positions. A pipeline also skips an item's remaining stages on `null`.

Start with the [workflow package guide](packages/workflow/README.md). The
[authoring guide](docs/workflow/SKILL.md) covers composition patterns and recovery;
the [primitives reference](docs/workflow/README.md) documents parameters, results,
and supported behavior, including differences from the Claude Code reference.
The [persistence reference](docs/workflow/persistence.md) covers `run.step()` and failure recovery.

## Packages

Choose `@anureo/sdk` and an adapter for your backend. Add `@anureo/workflow` for
composition, or `@anureo/protocol` for direct access to the wire contract.

| Package and guide | Purpose |
| --- | --- |
| [@anureo/sdk](packages/core/README.md) | Client, Session, Turn, and shared runtime components |
| [@anureo/adapter-codex](packages/codex/README.md) | Codex app-server adapter |
| [@anureo/adapter-claude](packages/claude/README.md) | Claude Agent SDK adapter |
| [@anureo/adapter-acp](packages/acp/README.md) | Standard ACP agents, including DSH |
| [@anureo/adapter-pi](packages/pi/README.md) | Pi coding agent, embedded in-process through its TypeScript SDK |
| [@anureo/adapter-ahp](packages/ahp/README.md) | External AHP harnesses over stdio or WebSocket |
| [@anureo/adapter-hermes](docs/hermes-adapter.md) | Hermes canonical gateway through ticketed local WebSocket |
| [@anureo/workflow](packages/workflow/README.md) | Agent calls, parallel tasks, pipelines, and durable workflow steps |
| [@anureo/code-review](docs/code-review-cli.md) | Module analysis and parallel code review with a CLI |
| [@anureo/protocol](packages/protocol/README.md) | AHP v1 JSON Schema, TypeScript types, and validation |
| [@anureo/conformance](packages/conformance/README.md) | Shared conformance tests and scripted fixtures |

## Examples

Run these commands from the source checkout after installing dependencies.
Every example uses a real backend and requires its credentials.

| Example | Command | Prerequisites and output |
| --- | --- | --- |
| [Greeting](examples/greeting.ts) | `bun run example` | Authenticated Codex CLI; streams a greeting. |
| [Workflow](examples/workflow.ts) | `bun run example:workflow` | Authenticated Codex CLI; prints arithmetic agent inputs, outputs, and a checked summary. |
| [Zod workflow](examples/workflow-structured.ts) | `bun run example:workflow-schema all` | Authenticated Codex and Claude CLIs; returns typed `{ sum: 42 }` from the same Zod schema. Select `codex` or `claude` to run one backend. |
| [Tool structured workflow](examples/workflow-output-tools.ts) | `bun run example:workflow-tool-schema dsh` | Installed credentials for DSH, Hermes or Pi. Add `--session` to switch schemas sequentially on one SDK session. |
| [Persistent workflow](examples/workflow-persistence.ts) | `bun run example:workflow-persistence [runId]` | Deterministic callbacks; saves a run ID and resumes completed steps without model requests. |
| [Structured output](examples/structured-output.ts) | `bun run example:schema codex` | Authenticated Codex CLI; prints a parsed JSON result for `17 + 25`. Use `claude` for Claude, or omit the argument to run both backends. |
| [DSH over ACP](examples/dsh.ts) | `bun run example:dsh` | DSH 0.2.2+ on PATH, Node.js 24.9+ for DSH, and configured DSH credentials; streams a reply and handles per-call approvals. |
| [Hermes gateway](examples/hermes.ts) | `bun run example:hermes` | Configured Hermes with canonical gateway attach (v0.23.1 contract); runs arithmetic through the selected profile. See the [verification scope](docs/hermes-adapter.md#requirements-and-verification). |

For Claude, log in with `claude auth login` before running its example. Backend
paths, model overrides, and other settings are documented in the linked example
sources and adapter guides.

## Documentation

- [SDK guide](packages/core/README.md): lifecycle, events, and execution controls.
- [Workflow authoring guide](docs/workflow/SKILL.md): composition and recovery patterns.
- [Workflow primitives reference](docs/workflow/README.md): parameter and result contracts.
- [AHP v1 JSON Schema](packages/protocol/schema/v1/ahp.schema.json): the wire contract.
- [Contributing](CONTRIBUTING.md): development setup, validation commands, and adapter requirements. CI runs validation on Windows, macOS, and Linux for pushes and pull requests.
- [Governance](GOVERNANCE.md): versioning, extensions, and conformance policy.
- [Security](SECURITY.md): vulnerability reporting and secret handling.
- [Changelog](CHANGELOG.md): release history and breaking changes.
