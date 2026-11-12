# @anureo/adapter-pi

Adapter connecting the Anureo SDK to the [Pi](https://github.com/badlogic/pi-mono) coding agent. Pi runs **in-process** through its TypeScript SDK (`@earendil-works/pi-coding-agent`, `createAgentSession`); the adapter maps sessions, runs, tool activity and usage onto the unified AHP session model.

> Part of the [Anureo SDK workspace](../../../README.md). Install with `npm install @anureo/adapter-pi @earendil-works/pi-coding-agent`.

## Usage

```typescript
import { createClient } from '@anureo/sdk'
import { createPiAdapter } from '@anureo/adapter-pi'

const client = await createClient({
  adapter: createPiAdapter({ sessionDir: '.pi-sessions' }),
  identity: { adapterId: 'pi', runtimeConfigId: 'local' },
})
try {
  const session = await client.sessions.create({
    cwd: process.cwd(),
    model: 'anthropic/claude-sonnet-4-5',          // `provider/id`, as listed by Pi
    config: { permissionMode: 'read-only' },
  })
  const turn = await session.submit({ input: 'Summarize this repository.' })
  console.log((await turn.result()).text)
} finally { await client.dispose() }
```

Credentials are Pi's own: its `auth.json` in the agent directory (default `~/.pi/agent`, override with `agentDir`) or the provider environment variables Pi reads. The adapter never accepts API keys as options.

## Trust model: Pi runs inside your process

Pi executes in the host process with the host's credentials, environment and file-system rights. There is **no process isolation** and **no approval gate**. Use `agentDir`/`sessionDir` to keep Pi state separate, `read-only` mode to remove mutating tools, and the `secrets` option to redact known credential values from events, history and errors. If you need isolation, supply a different `createHost` (see below).

## Capabilities

| AHP | Pi | Notes |
|---|---|---|
| submit | `prompt` | A turn lasts until Pi *settles* (`agent_settled`), including automatic retries and queued continuations. |
| steer (`delivery: 'native'`) | `steer` | Joins the active turn; if an extension consumes the input it is accepted without a turn. |
| `delivery: 'afterTurn'` | `followUp` | Joins the active turn. |
| session interrupt | `abort` | The turn ends as `interrupted`. |
| history | session entries on the active branch | Paged, with tool results paired to their calls. |
| fork (`before`/`through`) | branch the session file | Needs persisted sessions. |
| resume | open the session by id | Needs persisted sessions. |
| compact | `compact` | Progress is a compaction item inside a turn, or notices outside one. |
| config | `model`, `thinkingLevel`, `permissionMode` | Values are validated against what Pi lists. |
| text + base64 image input | prompt images | URL images and file inputs are rejected. |

Not supported natively: interactions (approval, user input, elicitation, dynamic tools), revert, goal, review, structured output schemas, `turn/steer` and `turn/interrupt` (Pi has no turn ids to match atomically — use session-level interrupt and native delivery).

The default embedded host supports [structured output](../../../docs/structured-output.md)
through a dynamically registered Pi tool. Each structured submission replaces
`anureo_submit_result` with the current business JSON Schema. A validated tool
result requests native termination; the SDK publishes success only after Pi
settles successfully. The tool is disabled after the real terminal or definite
submission rejection. Text-only inputs have no active output tool.

Pi does not use MCP. Session `mcpServers` are unsupported, and the embedded host
disables Pi's built-in MCP extension. Custom hosts can opt into structured output
by implementing `PiSessionHost.setOutputTool(tool?)`: replace the definition,
invoke its submission-bound callback, and disable it when passed `undefined`.
Hosts without this method retain text support without advertising output schemas.

### Permission modes

Pi has no approval flow, so modes are tool allowlists:

- `read-only` — `read`, `grep`, `find`, `ls`
- `agent-full-access` (default) — adds `bash`, `edit`, `write`

Anything else (for example `agent`) fails with `INVALID_PARAMS`.

## Version profiles

`resolvePiProfile(version)` selects capabilities. Pi `1.5.2` is the verified version; newer releases of major 1 get the same set but are reported unverified. Older or unknown versions get the safe baseline: no resume, fork or compaction. Pass `version` explicitly when using an injected host.

## Options

| Option | Purpose |
|---|---|
| `version` | Pi version from a trusted probe; defaults to baseline for injected hosts |
| `createHost` | Host factory; defaults to embedding Pi in-process (`createPiHost`) |
| `agentDir`, `sessionDir` | Pi's global config directory and session directory |
| `persistSessions` | Keep sessions on disk so resume/fork work (default `true`) |
| `secrets` | Credential values to redact everywhere |
| `maxHistoryItems` | Cap on history items per snapshot (default 5000) |

## The host seam

Only `src/host.ts` imports the Pi SDK. Everything else uses the small `PiSessionHost` interface (prompt, steer, followUp, abort, models, history entries, compact, fork, dispose, event subscription). Tests inject a scripted host; a subprocess/RPC host (`pi --mode rpc`) could implement the same interface for isolation. A host reports a lost source with the `failed` event, which fails observation without inventing a terminal.

## Development

```sh
cd packages/adapter/pi
bun run typecheck
bun test tests
bun run smoke                                  # offline: opens a real in-memory Pi session
PI_SMOKE_MODEL=provider/id bun run smoke       # also runs one real prompt (needs Pi credentials)
PI_SMOKE_MODEL=provider/id bun run spike       # records the real event sequence under protocol/<version>/
```

```sh
PI_SMOKE_MODEL=provider/id bun run live       # multi-turn, history, fork, resume, interrupt on persisted sessions
```

Most unit tests drive a scripted host; `tests/replay.test.ts` replays a real run recorded from Pi 1.5.2 (`protocol/1.5.2/run.json`). The live scripts were verified with Zhipu's `zai/glm-5.3-flash` using `ZAI_API_KEY` in the environment. `scripts/fork-probe.ts` checks Pi's session-file semantics without credentials.

The direct structured-output live check exercises schema A → schema B → plain
text on one real session, recalls a nonce supplied only on the first turn, checks
public history, and runs a separate workflow schema call:

```sh
# From the repository root, using credentials already configured for Pi:
PI_SMOKE_MODEL=provider/id bun run example:pi-tool-schema
# Optional: PI_SMOKE_AGENT_DIR=/path/to/pi/agent
```

The real provider check passed with Pi 1.5.2 and
`zai-coding-cn/glm-5.3-flash` on the China Coding Plan endpoint.
