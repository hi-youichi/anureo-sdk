# Structured output

The SDK accepts JSON Schema through `session.submit({ outputSchema })`.
Workflow accepts a Zod object through `agent({ schema })`, converts it to JSON
Schema, and performs its own final Zod validation. Both use the same SDK execution
and result path.

```typescript
import type { Client } from '@anureo/sdk'
import { agent } from '@anureo/workflow'
import { z } from 'zod'

export async function calculate(client: Client, cwd: string) {
  return agent('Calculate 17 + 25.', {
    client, cwd, schema: z.object({ sum: z.number().int() }),
  })
}

export async function calculateWithSession(client: Client, cwd: string) {
  const session = await client.sessions.create({ cwd })
  try {
    const turn = await session.submit({
      input: 'Calculate 17 + 25.',
      outputSchema: {
        type: 'object',
        properties: { sum: { type: 'integer' } },
        required: ['sum'],
        additionalProperties: false,
      },
    })
    const result = await turn.result()
    if (result.status !== 'completed') throw new Error('Calculation did not complete')
    return z.object({ sum: z.number().int() }).parse(JSON.parse(result.text))
  } finally {
    try { await session.close() } finally { await session.dispose() }
  }
}
```

These examples use default SDK observation deadlines. Long tasks can supply
existing `RequestOptions.timeoutMs` values to `submit()` and `result()`.
Workflow uses a long observation deadline internally.

The [tool example](../examples/workflow-output-tools.ts) makes real model requests
using installed credentials. Run `bun run example:workflow-tool-schema dsh`,
`hermes`, or `pi` for the workflow path. Add `--session` to exercise two different
JSON Schemas sequentially on one SDK session. Pi needs a configured model and
credentials (`PI_MODEL=provider/model` selects a model). DSH's arithmetic example
auto-approves tool calls for unattended result submission.

For Pi, `PI_SMOKE_MODEL=provider/id bun run example:pi-tool-schema` runs the
[real-model verification example](../examples/pi-structured-live.ts): schema A,
schema B and plain text share a session and recall a nonce supplied only on the
first turn. It also checks prior submissions through history and a separate
workflow call. `PI_SMOKE_AGENT_DIR` selects an existing Pi credential/config
directory. The live check passed on Pi 1.5.2 with
`zai-coding-cn/glm-5.3-flash` using the China Coding Plan endpoint.

## Native, direct tool and MCP routes

The SDK uses the backend's native `outputSchema` capability when available.
Otherwise, the SDK prefers an adapter's direct output-tool port. Adapters without
a direct tool port can opt into a session-scoped MCP output bridge.
The application supplies neither MCP startup configuration nor output IDs.
Direct `session.request('input/submit', ...)` requests use this same path and
retain request-ID deduplication.

`session.capabilities.turn.outputSchema` describes effective session support,
including a direct output tool or installed bridge. A Pi session advertises
`x-anureo/structured-output-tool` version `1`; a bridge-backed session advertises
`x-anureo/structured-output-mcp` version `1`. Raw backend capabilities are kept
separately, so an unsupported schema field is never sent to the backend.
Backend state/configuration updates preserve this effective capability projection.

| Adapter | Route |
| --- | --- |
| Codex / Claude | Native output schemas when advertised by the selected backend profile |
| Local ACP subprocess | HTTP when advertised by the peer, otherwise stdio; new and supported resume/load operations receive session MCP configuration |
| Pi default embedded host | Direct dynamic tool registration; injected hosts opt in by implementing `setOutputTool(tool?)`. MCP is unsupported |
| Hermes canonical gateway | New sessions only, when `runtime.describe` advertises `acp-session-mcp-v1`, ACP source, and the `editor` creation parameter |
| External/remote AHP peer | The peer's advertised output capability; no automatic local bridge injection |

ACP channels supplied through `connect` have unknown execution locations and do
not automatically receive a local bridge. An older Hermes gateway remains
unsupported. Hermes resumes currently retain text support without installing a
new output bridge: its editor transport fingerprint cannot be silently replaced
on attach.

Hermes bridge-backed sessions use the gateway's ACP editor surface with
`edit_approval_policy: ask`. File edits follow that surface's approval policy.
The SDK does not change a shared profile or restart other sessions to install MCP.
Explicit Hermes session instructions and permission modes remain unsupported.

## Tool definition and result validation

Pi registers `anureo_submit_result` directly through its extension API. For an
object-root output schema, the tool's parameter schema is the business schema:

```json
{
  "name": "anureo_submit_result",
  "parameters": {
    "type": "object",
    "properties": { "sum": { "type": "integer" } },
    "required": ["sum"],
    "additionalProperties": false
  }
}
```

Each structured submission replaces this definition in the same Pi session.
Scalar, array, null and Boolean schemas use an object parameter envelope with a
required `value` field. The callback captures the submission internally, so Pi
passes no output ID. Valid acceptance returns `terminate: true` to Pi; the SDK
still waits for `agent_settled`. The output tool is disabled after the real
terminal or definite pre-dispatch rejection, and stays inactive for text-only
inputs. Ordinary permission-tool changes preserve it while configured. Repeated
schemas replace one registry entry; stale callbacks cannot submit to a newer task.
The embedded host disables Pi's built-in MCP extension and rejects `mcpServers`.
The SDK checks the original tool arguments, preserving strict validation even
when Pi's own tool validator coerces parameter types.

The MCP bridge exposes one stable tool for the lifetime of the SDK session:

```json
{
  "name": "submit_result",
  "description": "Submit the final structured result for the current task. Use its outputId and satisfy its JSON Schema. After acceptance, end the task. On validation errors, correct the value and submit again.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "outputId": { "type": "string", "minLength": 1 },
      "value": {}
    },
    "required": ["outputId", "value"],
    "additionalProperties": false
  }
}
```

For each MCP structured submission the SDK appends an output contract containing
the business JSON Schema and a fresh output ID. The tool definition remains
stable across successive schemas; correctness does not depend on tool-list
refresh. The service validates `value` against that submission's schema. This
provides validated successful results, rather than a guarantee that a model
will call the tool or use provider-side constrained decoding for business fields.

The first valid value is retained. Structurally equal duplicates are idempotent;
different later values are rejected. Invalid values receive bounded validation
feedback and can be corrected within the current execution. Three invalid values
exhaust the correction budget. The SDK never resubmits the business task.

Acceptance by the tool is provisional. The SDK waits for reliable
submission-to-turn binding and a real successful native terminal. Failed or
interrupted native executions retain their original outcome even after an
accepted tool result. Successful structured turns contain one final JSON message;
other generated text is commentary. Native final item identities are retained
when one native final already represents the result, preserving authoritative
history identity. Tool-produced final items are SDK live projections; native
history is not required to reconstruct them after restart.

JSON Schema without `$schema` uses draft-07. Explicit draft-07 and 2020-12 select
their respective validators. Schemas must be self-contained and synchronous.
No remote references, coercion, default insertion, or property removal are used.
The raw SDK supports JSON scalars, arrays, null and Boolean schemas. Workflow
retains its narrower [portable Zod contract](workflow/README.md#schema-mode).
Output errors omit values and custom diagnostics. Privacy projection is applied
before the public result is revalidated; an invalidated redacted result fails
instead of returning the private value.

## Process and resource ownership

Pi tools execute in the embedded host in the SDK application process, with no
MCP client, server, proxy or listener.

For MCP routes, the SDK lazily starts one loopback HTTP listener per Client,
with isolated session leases and authentication. The service runs inside the SDK application's
Node/Bun process; no separately installed daemon is needed.

```text
HTTP:
  harness MCP client ── HTTP ──► SDK application / MCP server / output state

stdio:
  harness MCP client ── stdin/stdout ──► SDK stdio proxy child
                                            │ HTTP
                                            ▼
                                  SDK application / MCP server / output state
```

For stdio, the harness starts the supplied JS proxy using its configured
command/args/env. The proxy is an MCP server toward the harness and an MCP client
toward the SDK listener. It forwards discovery and calls; schemas and accepted
results remain owned by the SDK application. Its executable asset is resolved
through `@anureo/sdk/structured-output-stdio`. Deployments that bundle the SDK
must retain this installed subpath when using stdio. It runs on Node or Bun and
does not require a TypeScript loader.

Closing/disposing a session revokes its lease. Client disposal closes the shared
listener. The proxy exits on stdin EOF, parent loss, or failed upstream heartbeat.
Observation timeout, caller abort and Turn disposal do not revoke an executing
task's result slot or imply that native execution stopped. Remote hosts and
sandboxes require verified connectivity; a host's loopback URL and installed
paths are not automatically reachable in another environment.

## Admission and errors

A direct-tool or bridge-backed structured task exclusively reserves its SDK session until the
real terminal. The session must be idle with no unresolved older submissions.
Additional submissions, review, compaction and execution-changing configuration
are rejected with `STRUCTURED_OUTPUT_BUSY`; separate sessions can run in parallel.
Supported exact steering preserves the current schema. Delivery modes retain
their backend capability checks and are not silently changed.

Parameter/unsupported/busy failures reject submission before dispatch. Output
failures after association are failed TurnResults; workflow throws their errors.
Native failures take precedence over output validation failures.

| Code | Meaning |
| --- | --- |
| `STRUCTURED_OUTPUT_MISSING` | No final output was produced; tool route had no accepted tool submission |
| `STRUCTURED_OUTPUT_NOT_JSON` | Native final text is not JSON |
| `STRUCTURED_OUTPUT_INVALID` | Output does not match its schema |
| `STRUCTURED_OUTPUT_RETRIES_EXCEEDED` | Three invalid values reaching SDK validation exhausted the local correction budget |
| `STRUCTURED_OUTPUT_BINDING_CONFLICT` | Different output contracts were associated with one execution |
| `STRUCTURED_OUTPUT_REDACTED` | Privacy projection made the public output invalid |
| `RESULT_BUDGET_EXCEEDED` | Output state or retained results exceeded configured limits |

Existing backend structured-output errors and workflow Zod refinement errors
retain their own codes. A lost native source remains an unknown observation
outcome; the SDK does not manufacture a native completed event.
