# @anureo/adapter-swarm

The swarm adapter gives an Anureo SDK client one conversation that can switch between direct execution and a temporary team. An internal router decides how to handle each turn. The main agent handles direct replies and combines team findings, retaining context for follow-up turns.

## Quick start

This example requires an authenticated Codex CLI on PATH. Run the [three-turn example](examples/codex.ts) from the workspace root with `bun packages/adapter/swarm/examples/codex.ts`.

```ts
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createSwarmAdapter } from '@anureo/adapter-swarm'

const backend = await createClient({
  adapter: createCodexAdapter({ command: 'codex' }),
  identity: { adapterId: 'codex', runtimeConfigId: 'local' },
})

try {
  const client = await createClient({
    adapter: createSwarmAdapter({ backend }),
    identity: { adapterId: 'swarm', runtimeConfigId: 'local' },
  })
  try {
    const session = await client.sessions.create({ cwd: process.cwd(), permissionMode: 'read-only' })
    const turn = await session.submit({ input: 'Explain what Array.prototype.map does.' })
    const result = await turn.result({ timeoutMs: 300_000 })
    if (result.status !== 'completed') throw new Error(result.error?.message ?? result.status)
    console.log(result.text)
    await session.close()
  } finally {
    await client.dispose()
  }
} finally {
  await backend.dispose()
}
```

## API overview

`createSwarmAdapter(options: SwarmAdapterOptions)` is the package entry point. Pass an initialized SDK Client as `backend`. The main agent, router, and team members can all create independent sessions on this Client. Optionally set `memberBackends: { reviewer: claudeClient, tester: codexClient }` to select other initialized Clients by fixed profile ID or temporary role. Unmapped members use `backend`. The caller owns all backend Clients and releases them after disposing the swarm Client.

- **Fixed bees.** Supply `profiles` as a list of `BeeProfile` objects. Each has an `id`, `name`, `description`, `instructions`, and optional `model` for its backend. IDs are lowercase slugs up to 40 characters and start with a letter. The router uses the description to select a bee. Each assignment opens a fresh session using the profile's model and instructions. For backends that reject session instructions, Swarm includes them in the assignment prompt. Start a prompt with `@<id>` to assign the task directly to one fixed bee and have the main agent summarize its findings.
- **Profile loading.** Applications can import `parseBeeProfile(value)` from `@anureo/adapter-swarm` to validate their own data. The [CLI](../../../apps/cli/README.md#fixed-swarm-bees) loads profiles from user and project files.
- **Profile review.** Set `profileReview: { onResult, feedback? }` to review successful fixed-bee assignments. Swarm forks the member's underlying Session through its completed Turn and appends a review prompt. The fork uses the member's opening configuration and permissions. The foreground Turn can finish before the callback fires. Dispose the swarm Client before releasing borrowed backend Clients to drain reviews and callbacks. `BeeProfileReview` reports a proposed patch, a skip, or a failure, with native cache usage when available. Backends without a completed-turn fork capability report a skip.

- **Conversation.** Open a new Session and call `submit({ input })` for each text prompt. One turn can be active at a time. The outer Turn handle is available while routing and execution are in progress. The main agent's Session stays open for the conversation.
- **Routing.** The router opens a short-lived Session on the default backend and requests a structured plan. A routing failure with a known outcome publishes a `SWARM_ROUTING_FALLBACK` notice and selects direct execution. An unknown outcome is surfaced on the Turn.
- **Progress and results.** Subscribe with `session.events()` before submitting to see the main agent's message items and text deltas plus team member lifecycle items. `turn.result()` waits for the whole swarm turn. Member findings are submitted to the main agent for synthesis. Partial failures are included in the synthesis input.
- **Interruption and cleanup.** `turn.interrupt()` requests cancellation. Wait for `turn.result()` to observe its outcome. If a backend may still be running, the result carries `outcomeUnknown` and the swarm Session must be closed before starting work in a new Session. `session.close()` releases the swarm's sessions and reports whether execution stop was confirmed. Dispose the swarm Client even if a turn or session fails.

The adapter advertises text input, member lifecycle events, and turn interruption. Configure sandboxing on each backing harness. Swarm passes `permissionMode` to the backing sessions, and the member prompt requests read-only work. Use permission modes understood by your configured backends. See the [SDK guide](../../core/README.md) for standard session and turn contracts.

## Code structure

| Module | Responsibility |
| --- | --- |
| [src/index.ts](src/index.ts) | Exports the adapter factory, negotiates capabilities, and opens a main Session for each swarm Session. |
| [src/session.ts](src/session.ts) | Associates submissions with swarm turns, drives the router and team, and owns terminal events and close handling. |
| [src/router.ts](src/router.ts) | Requests and validates the direct or team plan. |
| [src/profiles.ts](src/profiles.ts) | Defines and validates fixed bee profiles. |
| [src/profile-review.ts](src/profile-review.ts) | Forks completed member sessions, validates review responses, and drains background reviews. |
| [src/team.ts](src/team.ts) | Runs member sessions concurrently and emits member lifecycle items. |
| [src/execution.ts](src/execution.ts) | Executes and observes backend turns, forwards interruptions, and releases sessions. |
| [src/events.ts](src/events.ts) | Maps assistant messages to swarm turn and item identities. |
