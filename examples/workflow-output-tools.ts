import assert from 'node:assert/strict'
import { z } from 'zod'
import { createClient, type Client } from '@anureo/sdk'
import { createDshAcpAdapter } from '@anureo/adapter-acp'
import { createHermesAdapter } from '@anureo/adapter-hermes'
import { createPiAdapter } from '@anureo/adapter-pi'
import { agent } from '@anureo/workflow'
import type { JsonSchema } from '@anureo/protocol'

// Real model requests using installed credentials. Select one backend per run:
// bun run example:workflow-tool-schema dsh|hermes|pi [--session]
// --session exercises two different schemas on one SDK session instead of agent().
const backend = process.argv[2] ?? 'dsh'
const sessionMode = process.argv[3] === '--session'
if (!['dsh', 'hermes', 'pi'].includes(backend) || process.argv.length > 4 || process.argv[3] !== undefined && !sessionMode) {
  throw new Error('Usage: bun run example:workflow-tool-schema [dsh|hermes|pi] [--session]')
}
const { adapter, model } = createBackend(backend)
const client = await createClient({ adapter, identity: { adapterId: backend === 'dsh' ? 'dsh-acp' : backend, runtimeConfigId: 'workflow-tool-schema' } }, { timeoutMs: 120_000 })
try {
  if (sessionMode) await checkSessionOutput({ client, backend, model })
  else await checkWorkflowOutput({ client, backend, model })
} finally {
  await client.dispose()
}

/** CLI-selected backend and borrowed client, which the entry code disposes after the selected check. */
interface CheckOptions {
  client: Client
  backend: string
  model?: string
}

/** Select the adapter and its matching environment model after CLI validation, without opening a client. */
function createBackend(backend: string) {
  switch (backend) {
    case 'dsh':
      // This arithmetic demo auto-approves DSH tool calls for unattended result submission.
      return {
        adapter: createDshAcpAdapter({ autoApprove: true, ...(process.env.ANUREO_DSH_PROFILE ? { profile: process.env.ANUREO_DSH_PROFILE } : {}) }),
        model: process.env.ANUREO_DSH_MODEL,
      }
    case 'hermes':
      return {
        adapter: createHermesAdapter({ timeoutMs: 90_000, ...(process.env.HERMES_PROFILE ? { profile: process.env.HERMES_PROFILE } : {}) }),
        model: process.env.HERMES_MODEL,
      }
    default:
      return { adapter: createPiAdapter({ persistSessions: false }), model: process.env.PI_MODEL }
  }
}

/**
 * For --session, submit two schemas sequentially on one session and print each verified result.
 * Await terminal results, rejecting on request, parse or assertion failure; always close the session.
 */
async function checkSessionOutput({ client, backend, model }: CheckOptions) {
  const session = await client.sessions.create({ cwd: process.cwd(), ...(model ? { model } : {}) })
  try {
    const tasks: Array<{ prompt: string; schema: JsonSchema; expected: unknown }> = [
      { prompt: 'Calculate 17 + 25.', schema: { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }, expected: { sum: 42 } },
      { prompt: 'Return the ordered integers 1, 2, 3 in the values field.', schema: { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } }, required: ['values'], additionalProperties: false }, expected: { values: [1, 2, 3] } },
    ]
    for (const task of tasks) {
      const turn = await session.submit({ input: `${task.prompt} Do not read files or run commands.`, outputSchema: task.schema }, { timeoutMs: 120_000 })
      const result = await turn.result({ timeoutMs: 180_000 })
      assert.equal(result.status, 'completed', result.status === 'failed' ? result.error.code : result.status)
      const value: unknown = JSON.parse(result.text)
      assert.deepEqual(value, task.expected)
      console.log(JSON.stringify({ backend, route: backend === 'pi' ? 'tool' : 'mcp', mode: 'session', value, status: 'passed' }))
    }
  } finally {
    await session.close()
  }
}

/** Verify and print agent's typed answer after its session cleanup; drops fail the assertion and other failures reject. */
async function checkWorkflowOutput({ client, backend, model }: CheckOptions) {
  const value = await agent('Calculate 17 + 25. Answer directly; do not read files or run commands. Follow the output contract supplied with this task.', {
    client, cwd: process.cwd(), schema: z.strictObject({ sum: z.number().int() }), ...(model ? { model } : {}),
  })
  assert(value !== null, `${backend} did not produce a result`)
  assert.equal(value.sum, 42)
  console.log(JSON.stringify({ backend, route: backend === 'pi' ? 'tool' : 'mcp', value, status: 'passed' }))
}
