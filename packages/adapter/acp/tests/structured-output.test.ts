import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createClient, type Session, type SubmitOptions } from '@anureo/sdk'
import { createAcpAdapter } from '../src'
import { submitOutput } from './fixtures/mcp-output-client.mjs'

test('the stdio client reports bridge exit before the first reply', async () => {
  await expect(submitOutput({
    command: process.execPath, args: ['-e', 'process.exit(17)'], env: [],
  }, [])).rejects.toThrow('MCP bridge exited (17)')
}, 2000)

for (const scenario of ['mcp-output', 'mcp-stdio-output']) {
  test(`local ACP ${scenario} supports sequential schemas and reconnects on resume`, async () => {
    const adapter = createAcpAdapter({
      command: process.execPath,
      args: [resolve(import.meta.dirname, 'fixtures/fake-acp.mjs'), '--scenario', scenario],
    })
    const client = await createClient({ adapter, identity: { adapterId: 'acp', runtimeConfigId: 'mcp' } })
    try {
      const first = await client.sessions.create({ cwd: process.cwd() })
      expect(first.capabilities.turn?.outputSchema).toBe(true)
      const sumSchema = { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }
      await expectStructuredResult(first, { input: '17 + 25', outputSchema: sumSchema }, '{"sum":42}')

      const reference = first.reference
      await first.close()
      const resumed = await client.sessions.resume(reference)

      const labelSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false }
      await expectStructuredResult(resumed, { input: 'label', outputSchema: labelSchema }, '{"label":"second"}')
    } finally {
      await client.dispose()
    }
  })
}

/** Submit with a schema and assert that terminal completion exposes the expected JSON text. Submit and result wait failures reject the test. */
async function expectStructuredResult(session: Session, options: Required<Pick<SubmitOptions, 'input' | 'outputSchema'>>, expectedText: string) {
  const turn = await session.submit(options)
  expect(await turn.result()).toMatchObject({ status: 'completed', text: expectedText })
}
