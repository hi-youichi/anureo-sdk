import { expect, test } from 'bun:test'
import { createClient, type StructuredOutputToolDefinition } from '@anureo/sdk'
import { createPiAdapter } from '@anureo/adapter-pi'
import { fakeFactory } from '../../adapter/pi/tests/fake-host'
import { z } from 'zod'
import { agent } from './agent'

test('workflow schema uses direct Pi tools and retains Zod refinement validation', async () => {
  const fake = fakeFactory(host => {
    let output: StructuredOutputToolDefinition | undefined
    Object.assign(host, { async setOutputTool(tool?: StructuredOutputToolDefinition) { output = tool } })
    host.script = async host => {
      if (!output) throw new Error('Output tool must be registered before scripted execution')
      await output.execute({ sum: 42 })
      await host.assistant('submitted')
    }
  })
  const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'workflow-direct-tool' } })
  try {
    const schema = z.object({ sum: z.number().int() })
    expect(await agent('17 + 25', { client, cwd: process.cwd(), schema })).toEqual({ sum: 42 })
    await expect(agent('17 + 25', { client, cwd: process.cwd(), schema: schema.refine(value => value.sum < 0) })).rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false })
    expect(fake.opens.every(open => !Object.hasOwn(open, 'mcpServers'))).toBe(true)
  } finally { await client.dispose() }
})
