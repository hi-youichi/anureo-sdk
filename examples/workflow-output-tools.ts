/**
 * Verify structured output with installed credentials.
 * Run bun run example:workflow-tool-schema [dsh|hermes|pi] [--session]. By default, run a
 * typed workflow call through DSH. Pass --session to change schemas on a single SDK session.
 */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createClient, type Client } from '@anureo/sdk'
import { createDshAcpAdapter } from '@anureo/adapter-acp'
import { createHermesAdapter } from '@anureo/adapter-hermes'
import { createPiAdapter } from '@anureo/adapter-pi'
import { agent } from '@anureo/workflow'
import type { JsonSchema } from '@anureo/protocol'
import { submitCompleted } from './submit-completed'

const { backend, mode } = parseArguments(process.argv.slice(2))
const { adapter, model } = createBackend(backend)
const client = await createClient({
  adapter,
  identity: { adapterId: backend === 'dsh' ? 'dsh-acp' : backend, runtimeConfigId: 'workflow-tool-schema' },
}, { timeoutMs: 120_000 })
try {
  if (mode === 'session') await checkSessionOutput({ client, backend, model })
  else await checkWorkflowOutput({ client, backend, model })
} finally {
  await client.dispose()
}

type Backend = 'dsh' | 'hermes' | 'pi'

/** CLI-selected backend and borrowed client, which the entry code disposes after the selected check. */
interface CheckOptions {
  client: Client
  backend: Backend
  model?: string
}

/** Resolve the CLI defaults and reject invalid arguments before the entry code acquires resources. */
function parseArguments([backend = 'dsh', flag, ...extra]: string[]): { backend: Backend; mode: 'session' | 'workflow' } {
  if (
    (backend !== 'dsh' && backend !== 'hermes' && backend !== 'pi')
    || (flag !== undefined && flag !== '--session')
    || extra.length > 0
  ) {
    throw new Error('Usage: bun run example:workflow-tool-schema [dsh|hermes|pi] [--session]')
  }
  return { backend, mode: flag === '--session' ? 'session' : 'workflow' }
}

/** Build the adapter and read its model override for the CLI's client and selected check. */
function createBackend(backend: Backend) {
  switch (backend) {
    case 'dsh': {
      const profile = process.env.ANUREO_DSH_PROFILE
      // This arithmetic demo auto-approves DSH tool calls for unattended result submission.
      return {
        adapter: createDshAcpAdapter({ autoApprove: true, ...(profile ? { profile } : {}) }),
        model: process.env.ANUREO_DSH_MODEL,
      }
    }
    case 'hermes': {
      const profile = process.env.HERMES_PROFILE
      return {
        adapter: createHermesAdapter({ timeoutMs: 90_000, ...(profile ? { profile } : {}) }),
        model: process.env.HERMES_MODEL,
      }
    }
    case 'pi':
      return { adapter: createPiAdapter({ persistSessions: false }), model: process.env.PI_MODEL }
  }
}

/**
 * For --session, submit two schemas sequentially on one session and print each verified result.
 * Await terminal results, rejecting on request, parse or assertion failure. Always await close,
 * whose failure takes precedence. The CLI awaits this check and disposes the client.
 */
async function checkSessionOutput({ client, backend, model }: CheckOptions) {
  const session = await client.sessions.create({ cwd: process.cwd(), ...(model ? { model } : {}) })
  try {
    const tasks: Array<{ prompt: string; schema: JsonSchema; expected: unknown }> = [
      {
        prompt: 'Calculate 17 + 25.',
        schema: {
          type: 'object', properties: { sum: { type: 'integer' } },
          required: ['sum'], additionalProperties: false,
        },
        expected: { sum: 42 },
      },
      {
        prompt: 'Return the ordered integers 1, 2, 3 in the values field.',
        schema: {
          type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } } },
          required: ['values'], additionalProperties: false,
        },
        expected: { values: [1, 2, 3] },
      },
    ]
    for (const task of tasks) {
      const result = await submitCompleted(session, {
        input: `${task.prompt} Do not read files or run commands.`, outputSchema: task.schema,
      }, { associationMs: 120_000, resultMs: 180_000 })
      const value: unknown = JSON.parse(result.text)
      assert.deepEqual(value, task.expected)
      console.log(JSON.stringify({ backend, route: backend === 'pi' ? 'tool' : 'mcp', mode: 'session', value, status: 'passed' }))
    }
  } finally {
    await session.close()
  }
}

/**
 * Verify and print agent's typed answer after its session cleanup. Drops fail the assertion.
 * Execution, validation and cleanup failures reject to the CLI, which disposes the client.
 */
async function checkWorkflowOutput({ client, backend, model }: CheckOptions) {
  const value = await agent('Calculate 17 + 25. Answer directly; do not read files or run commands. Follow the output contract supplied with this task.', {
    client, cwd: process.cwd(), schema: z.strictObject({ sum: z.number().int() }), ...(model ? { model } : {}),
  })
  assert(value !== null, `${backend} did not produce a result`)
  assert.equal(value.sum, 42)
  console.log(JSON.stringify({ backend, route: backend === 'pi' ? 'tool' : 'mcp', value, status: 'passed' }))
}
