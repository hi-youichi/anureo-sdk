import { expect, test } from 'bun:test'
import { createClient } from '@anureo/sdk'
import { createAcpAdapter, type AcpChannel } from '../src'

test('model validation and configuration failures release partially opened native sessions', async () => {
  for (const model of ['unknown-model', 'known-model', 'cleanup-failure']) {
    const calls: string[] = []
    let input!: ReadableStreamDefaultController
    let closed = false
    const channel: AcpChannel = {
      stream: {
        readable: new ReadableStream({ start(controller) { input = controller }, cancel() { closed = true } }),
        writable: new WritableStream({ write(frame) {
          const { method, id } = frame as { method: string; id: string | number }
          calls.push(method)
          let result: object = {}
          if (method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'model-fixture', version: '1' }, agentCapabilities: { sessionCapabilities: { close: {} } } }
          if (method === 'session/new') result = { sessionId: 'native-model', configOptions: [
            { id: 'model-id', name: 'Model', category: 'model', type: 'select', currentValue: 'known-model', options: [{ value: 'known-model', name: 'Known' }] },
          ] }
          input.enqueue({ jsonrpc: '2.0', id, ...(method === 'session/set_config_option' ? { error: { code: -32602, message: 'Model configuration rejected' } } : method === 'session/close' && model === 'cleanup-failure' ? { error: { code: -32603, message: 'Cleanup failed' } } : { result }) })
        } }),
      },
      async dispose() { if (!closed) { closed = true; input.close() } },
    }
    const client = await createClient({ adapter: createAcpAdapter({ connect: async () => channel }), identity: { adapterId: 'acp', runtimeConfigId: 'model-open' } })
    try {
      await expect(client.sessions.create({ cwd: process.cwd(), model })).rejects.toMatchObject(model === 'cleanup-failure'
        ? { code: 'INVALID_PARAMS', outcomeUnknown: false, details: { cleanupErrors: [{ code: 'RESOURCE_RELEASE_FAILED' }] } }
        : { code: 'INVALID_PARAMS' })
      expect(calls.filter(method => method === 'session/new')).toHaveLength(1)
      expect(calls.filter(method => method === 'session/close')).toHaveLength(1)
      expect(calls).not.toContain('session/prompt')
      expect(calls.filter(method => method === 'session/set_config_option')).toHaveLength(model === 'known-model' ? 1 : 0)
    } finally { await client.dispose() }
    expect(calls.filter(method => method === 'session/close')).toHaveLength(1)
  }
})
