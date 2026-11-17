# @anureo/cli

Command-line runner for the Anureo SDK. Run a single turn against Codex, Claude, Hermes, Pi, ACP, or Swarm. The CLI writes AHP events as JSONL or the final result as one JSON object.

> Part of the [Anureo SDK workspace](../../README.md). Workspace package; not yet published to npm.

## Usage

Requires Bun ≥ 1.4.2 plus the selected harness: the Codex (`codex`), Claude Code (`claude`) or Hermes (`hermes`) CLI installed and authenticated; Pi runs in-process with its own credentials; ACP needs any ACP-speaking executable, passed via `--command`.

```bash
# Stream one turn's events as JSONL (default)
anureo --harness codex "Summarize the failing tests"

# Print only the final result as a single JSON object
anureo --harness claude --output result "Reply with exactly: ok"

# Read the prompt from stdin
cat task.md | anureo --harness codex -

# Resume a session captured from an earlier run's envelope sessionId
anureo --harness codex --resume <sessionId> "Continue with step 2"

# Hermes, or any ACP-speaking agent over stdio
anureo --harness hermes "List the open design questions"
anureo --harness acp --command dsh "Review this diff"

# Let Swarm decide between a direct answer and a team
anureo --harness swarm:codex --sandbox read-only "Use a team to check whether Array.map mutates the input and how it handles sparse arrays."
```

## Command reference

```
anureo [options] [prompt]          # prompt omitted or "-" reads stdin

  --harness <codex|claude|hermes|pi|acp|swarm|swarm:<name>>
                                   Required; selects the adapter and client identity
  --command <exe>                  Harness executable override; required for acp
  --args <json>                    Extra harness args as a JSON array (e.g. '["agent.mjs"]')
  -C, --cd <dir>                   Working directory for the session (SessionOpenParams.cwd)
  --model <name>                   Model override, passed through to the harness
  --resume <sessionId>             Resume a session created by an earlier run
  --sandbox <read-only|workspace|full>   Tool-permission posture (see mapping below)
  --schema <file>                  JSON Schema file constraining the final message
  --output <stream|result>         stream (default): AHP event JSONL
                                   result: one final JSON object
  --review-profile                 Propose improvements after a fixed bee completes
  --review-feedback <text>         Enable profile review and provide feedback
  --verbose                        CLI diagnostics on stderr (default: silent)
  -h, -V                           Help / version
```

There are no config files, no daemon, no interactive mode, and no passthrough escape hatch. One invocation runs one turn. Session opening and submission allow 180 seconds — slow-booting ACP agents (real dsh mounts plugin bundles for ~10 s) fit comfortably. Swarm result waits have no deadline; other harnesses allow 180 seconds for the result.

### Choosing the harness

`--harness` maps to the client identity's `adapterId` and selects a workspace adapter. The AHP session model is identical across all of them — only `--sandbox` has harness-specific mappings.

| Harness | Drives | Notes |
|---|---|---|
| `codex` | `codex app-server` over stdio JSONL | |
| `claude` | the Claude Agent SDK (drives the Claude Code CLI) | |
| `hermes` | the Hermes CLI over its native RPC | `--command` overrides the executable |
| `pi` | the Pi agent in-process (`@earendil-works/pi-coding-agent`) | no process isolation: runs with this process's credentials and file rights |
| `acp` | any ACP-speaking agent over stdio | `--command` required; script agents and Windows `.cmd` shims pass the interpreter plus entry script: `--command node --args '["agent.mjs"]'` |
| `swarm:<name>` | [Swarm adapter](../../packages/adapter/swarm/README.md) with one Client for the named backend | Choose `codex`, `claude`, `hermes`, `pi`, or `acp`. `swarm` is shorthand for `swarm:codex`. `--command` and `--args` follow the selected backend's rules. |

The `ahp` protocol adapter (WebSocket, host-to-host) is intentionally not exposed: it is an embedding transport for SDK hosts, not a local harness.

### Fixed Swarm bees

Store reusable bee profiles as UTF-8 JSON files in `~/.anureo/bees/` or `<project>/.anureo/bees/`. Swarm starts at the CLI working directory (`--cd`, if supplied) and uses the nearest ancestor marked by a `.git` directory or file. In a plain directory it uses the working directory itself.

When asked to create a reusable profile, the main assistant saves general methods reusable across projects in the user directory, and repository-specific architecture, conventions, commands or domain rules in the project directory. It honors an explicit destination, keeps project details out of user profiles, and prefers project scope when cross-project reuse is uncertain. The CLI supplies both absolute storage directories even before they exist. The main assistant performs authorized file writes itself; `bee_create` only creates an instance from a loaded profile. New or changed files are loaded by the next CLI invocation.

Save this example as `.anureo/bees/tester.json`:

```json
{
  "name": "Test engineer",
  "description": "Reviews regression tests and edge cases",
  "instructions": "List missing assertions and suggest reproducible test cases."
}
```

The filename provides the profile ID. Both origins remain available when IDs match. Without an explicit scope, the project profile takes precedence over the entire user profile; fields are not merged. Set `model` to a model on the selected backend, or leave it out for the backend default. Swarm can select profiles automatically or accept an explicit assignment at the start of the prompt:

```bash
anureo --harness swarm:codex --sandbox read-only "@tester Review the current diff for missing regression tests."
anureo --harness swarm:codex --sandbox read-only "@user/tester Review using my reusable profile."
anureo --harness swarm:codex --sandbox read-only "@project/tester Review using the project profile."
```

Explicit `@user/<id>` and `@project/<id>` selections fail if that origin is absent; they never fall back. `@<id>` prefers the project profile, then the user profile. `--verbose` prints all discovered profiles with scoped names and paths to stderr. Assignment events include the resolved `profileId`, `profileScope`, `profileSource` and `sourceFile` under `extensions.swarm`.

### Swarm model selection

Swarm automatically discovers models for Codex, Claude, and Pi using the selected executable/configuration and working directory, then includes the normalized directory in main instructions. Discovery connections are released by their owner. Unsupported discovery (including ACP and Hermes) or a failed query leaves the catalog unavailable and preserves backend-default execution; `--verbose` reports query failures on stderr. Hidden models are omitted from the main catalog display. The main assistant may choose an exact model with `bee_create({ role, name, model })`; fixed bees use their profile model. `--model` continues to select the main model. See [Swarm model selection](../../packages/adapter/swarm/README.md#model-selection) for catalog policies and lifecycle behavior.

### Profile review

```bash
anureo --harness swarm:codex --sandbox read-only --review-feedback "Include the rollback assertions." "@tester Review the migrations."
```

Use `--review-profile` for a review based on the completed assignment alone. Swarm forks the member's completed turn and appends a review request. The CLI writes the foreground answer to stdout and finishes pending reviews before exit. It reports the review outcome and the backend's `cacheRead` count, when available, on stderr.

Validated candidates are saved under the project root at `.anureo/evolution/<user|project>/<profile-id>/proposals/<id>.json`. Each includes the exact `sourceFile` and `profileSource`, baseline instructions hash, patch, proposed instructions, evidence and a check for a future task. Existing unscoped proposal files remain in their original locations. Edit the profile file with a candidate you decide to adopt.

### Controlling tool permissions

`--sandbox` is available with Codex and Claude backends, including `swarm:codex` and `swarm:claude`. Claude's `acceptEdits` auto-approves file edits and can still emit an `interaction/requested` event for a command.

| CLI value | Codex | Claude |
|---|---|---|
| `read-only` | `sandbox=read-only` | `permission-mode=plan` |
| `workspace` | `sandbox=workspace-write` | `permission-mode=acceptEdits` |
| `full` | `danger-full-access`, approval never | `permission-mode=bypassPermissions` |

### Structured output

`--schema` passes a JSON Schema file to the turn's output schema. Codex's strict-mode requirement (`additionalProperties: false` at every object level) is enforced by the codex adapter, not re-validated by the CLI; an invalid schema surfaces as a failed turn. The final agent message text carries the schema-conforming JSON string.

### Stdout contract

**stdout is always pure JSONL — parse every line as JSON, skip nothing.** Harness stderr noise is absorbed by the adapters (codex stderr is folded into diagnostic codes) and republished as `notice` events. CLI diagnostics go to stderr, and only with `--verbose`.

`--output stream` (default) prints one AHP envelope per line:

```jsonl
{"sessionId":"5f0a…","streamId":"s1","seq":0,"timestamp":"2026-11-16T10:00:00.000Z","type":"session/state","payload":{"binding":{...},"capabilities":{...},"state":{...}}}
{"type":"turn/started","payload":{"turnId":"…","nativeTurnId":"…"}}
{"type":"item/started","payload":{"item":{"type":"agentMessage","id":"item_0","text":"…"}}}
{"type":"item/completed","payload":{"item":{"type":"toolCall","id":"item_1","kind":"command","title":"echo hi","status":"completed"}}}
{"type":"usage/updated","payload":{"provider":"openai","scope":"turn","source":"native","input":82922,"cachedRead":74240,"output":273}}
{"type":"turn/completed","payload":{"turnId":"…","status":"completed","usage":{...}}}
```

Every line carries the full `SourceEnvelope` (`sessionId`, `streamId`, `seq`, `timestamp`) alongside `type`/`payload`; it is shown once above and omitted afterwards for readability.

Every line's envelope carries `sessionId`; that value is what `--resume` takes. The first event type is harness-dependent (codex and claude open with `session/state`; hermes may start at `submission/status`), so read the session id from the envelope, not from a fixed position. A failed turn ends with a `turn/completed` whose `status` is `failed` and whose `error` is a `HarnessError`. Permission requests appear as `interaction/requested` events; the CLI registers no handlers, so the SDK denies them — this is the intended closed loop for single-shot runs.

`--output result` prints exactly one JSON object — the turn's `TurnResult` plus binding and status:

```json
{"binding":{...},"status":"completed","text":"ok","items":[...],"usage":{...}}
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Turn completed (or interrupted cleanly) |
| `2` | Turn failed, or the CLI could not start (bad flags, harness missing, session not found) |

Identical in both output modes.

## Native output mapping

The events you see per harness, as a verification contract. The mapping lives in the adapters; this table is what the CLI output must satisfy. Only codex and claude have CLI-level tables here — hermes, pi and acp mappings are owned and exercised by their adapters' conformance tests.

| Codex native event | AHP output |
|---|---|
| `thread.started` | first-line `session/state` (thread id → nativeRef) |
| `turn.started` | `turn/started` |
| `item.started/completed` `agent_message` | `item/*` agentMessage item |
| `item.*` `command_execution` | `item/*` toolCall item (command kind) |
| `turn.completed` `usage` | `usage/updated` + `turn/completed` |
| `turn.failed` / `error` | `turn/completed` status=failed |

| Claude native message | AHP output |
|---|---|
| `system/init` | first-line `session/state` |
| assistant content `text` | `item/*` agentMessage item |
| assistant content `thinking` | `item/*` reasoning item |
| assistant `tool_use` + user `tool_result` | one `item/*` toolCall item |
| `stream_event` deltas | `item/delta` |
| `rate_limit_event` / `system:status` | `notice` |
| `result` | `turn/completed` (usage/modelUsage → Usage) |

## Code structure

- [`bin/anureo.ts`](bin/anureo.ts) — executable entry; delegates to `runCli`.
- [`src/cli.ts`](src/cli.ts) — argument parsing/validation and help text; owns no client lifecycle.
- [`src/run.ts`](src/run.ts) — client assembly (adapter selection, identity, sandbox mapping) and turn execution.
- [`src/models.ts`](src/models.ts) — backend-specific model ID normalization and discovery-failure handling for Swarm instructions.
- [`src/profiles.ts`](src/profiles.ts) — user and project profile discovery and precedence.
- [`src/profile-review.ts`](src/profile-review.ts) — atomic writes for project profile proposals.
- [`src/project.ts`](src/project.ts) — event → JSONL projection for stream mode and the single-object writer for result mode.

The CLI follows the workspace apps' conventions: injected `CliDependencies` (stdout/stderr/factories) for tests, `parseArgs` from `node:util`, exit codes 0/2.
