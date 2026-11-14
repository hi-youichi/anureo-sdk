import { expect, test } from 'bun:test'
import { createClient } from '@anureo/sdk'
import { startFake } from './helpers'

test('a gateway advertising session MCP connects to the SDK bridge with isolated editor config', async () => {
  const native = await startFake('mcp')
  const client = await createClient({ adapter: native.adapter(), identity: { adapterId: 'hermes', runtimeConfigId: 'fake-profile' } })
  try {
    const a = await client.sessions.create({ cwd: process.cwd() })
    const b = await client.sessions.create({ cwd: process.cwd() })
    const schema = { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }
    const results = await Promise.all([a, b].map(async session => {
      expect(session.capabilities.turn?.outputSchema).toBe(true)
      return (await session.submit({ input: '17 + 25', outputSchema: schema })).result()
    }))
    expect(results.map(result => [result.status, result.text])).toEqual([['completed', '{"sum":42}'], ['completed', '{"sum":42}']])
    const state = await native.state()
    expect(state.createParams.every(params => params.source === 'acp')).toBe(true)
    const editors = state.createParams.map(params => params.editor as { mcp_servers: Array<{ url: string; headers: unknown }> })
    expect(editors[0]!.mcp_servers[0]!.url).not.toBe(editors[1]!.mcp_servers[0]!.url)
    expect(state.inputs).toHaveLength(2)
    // The SDK provisions a session MCP bridge on creation. Resuming an observation does not provision a new bridge.
    const reference = a.reference
    await a.close()
    const resumed = await client.sessions.resume(reference)
    expect(resumed.capabilities.turn?.outputSchema).toBe(false)
  } finally { await client.dispose(); await native.dispose() }
})
