// Verifies native-open dispatch timing through the public client; output policy belongs to the adapter wrapper.
import { expect, test } from 'bun:test'
import { AHP_PROTOCOL_CONTRACT } from '@anureo/protocol'
import { createClient, type HarnessAdapter } from '../index'

for (const nativeOutput of [true, false]) test(`native open dispatches immediately without a bridge (native schema: ${nativeOutput})`, async () => {
  let opened = false
  const capabilities = { turn: { outputSchema: nativeOutput } }
  const adapter: HarnessAdapter = {
    async initialize() {
      return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT,
        runtime: { name: 'fixture', version: '1', adapter: 'fixture' }, capabilities }
    },
    async openSession(params) {
      opened = true
      return { binding: params.binding, capabilities,
        async execute() { throw new Error('This fixture only opens sessions') },
        async dispose() {},
      }
    },
    async dispose() {},
  }
  const client = await createClient({ adapter, identity: { adapterId: 'fixture', runtimeConfigId: 'test' } })
  try {
    const pending = client.sessions.create({ cwd: process.cwd() })
    // Callers can initiate other work immediately; optional bridge preparation must not delay dispatch.
    expect(opened).toBe(true)
    await pending
  } finally { await client.dispose() }
})
