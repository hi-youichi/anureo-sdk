import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createClient } from '@anureo/sdk'
import { createAcpAdapter } from '../src'

for (const scenario of ['mcp-output', 'mcp-stdio-output']) test(`local ACP ${scenario} supports sequential schemas and reconnects on resume`, async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [resolve(import.meta.dirname, 'fixtures/fake-acp.mjs'), '--scenario', scenario] })
  const client = await createClient({ adapter, identity: { adapterId: 'acp', runtimeConfigId: 'mcp' } })
  try {
    const first = await client.sessions.create({ cwd: process.cwd() })
    expect(first.capabilities.turn?.outputSchema).toBe(true)
    const schema = { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }
    expect(await (await first.submit({ input: '17 + 25', outputSchema: schema })).result()).toMatchObject({ status: 'completed', text: '{"sum":42}' })
    const reference = first.reference
    await first.close()
    const resumed = await client.sessions.resume(reference)
    const second = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }
    expect(await (await resumed.submit({ input: 'label', outputSchema: second })).result()).toMatchObject({ status: 'completed', text: '{"label":"second"}' })
  } finally { await client.dispose() }
})
