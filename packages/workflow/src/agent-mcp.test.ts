import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createClient } from '@anureo/sdk'
import { createAcpAdapter } from '@anureo/adapter-acp'
import { z } from 'zod'
import { agent } from './agent'

test('workflow Zod output uses the same MCP path and retains local refinement failures', async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [fileURLToPath(new URL('../../acp/tests/fixtures/fake-acp.mjs', import.meta.url)), '--scenario', 'mcp-output'] })
  const client = await createClient({ adapter, identity: { adapterId: 'acp', runtimeConfigId: 'workflow-mcp' } })
  try {
    const schema = z.object({ sum: z.number().int() })
    const value = await agent('17 + 25', { client, cwd: process.cwd(), schema })
    expect(value).toEqual({ sum: 42 })
    await expect(agent('17 + 25', { client, cwd: process.cwd(), schema: schema.refine(value => value.sum < 0) })).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false })
  } finally { await client.dispose() }
})
