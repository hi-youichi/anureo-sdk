import { expect, test } from 'bun:test'
import { AHP_PROTOCOL_CONTRACT, type AhpRequestMap, type AhpResultMap, type Capabilities } from '@anureo/protocol'
import { createClient, type HarnessAdapter, type StructuredOutputToolDefinition } from '../index'
import { deferred } from '../lifecycle/deferred'

test('native close receipt revokes the output tool before a queued candidate runs', async () => {
  const receipt = deferred<AhpResultMap['session/close']>()
  const closed: AhpResultMap['session/close'] = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' }
  const closing = deferred<void>()
  let tool!: StructuredOutputToolDefinition
  const capabilities: Capabilities = { turn: { outputSchema: false, inputModalities: ['text'] }, input: { delivery: ['native'] } }
  const adapter: HarnessAdapter = {
    async initialize() {
      return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT,
        runtime: { name: 'fixture', version: '1', adapter: 'fixture' }, capabilities }
    },
    async openSession(params, sink) {
      return { binding: params.binding, capabilities,
        structuredOutputTool: { async configure(definition) { if (definition) tool = definition } },
        execute(method, input) {
          if (method === 'session/close') { closing.resolve(); return receipt.promise as never }
          if (method !== 'input/submit') throw new Error('Unexpected fixture request')
          const submission = input as AhpRequestMap['input/submit']
          return sink.emit({ type: 'turn/started', payload: { turnId: 'turn' } }).then(() => ({
            accepted: true, submissionId: submission.submissionId, disposition: 'started', turnId: 'turn',
          })) as never
        },
        async dispose() {},
      }
    },
    async dispose() {},
  }
  const client = await createClient({ adapter, identity: { adapterId: 'fixture', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd: process.cwd() })
    await session.submit({ input: 'Produce a value', outputSchema: {
      type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false,
    } })
    // Register before close starts so the candidate queues immediately after the native receipt.
    const candidate = receipt.promise.then(() => tool.execute({ value: 1 }))
    const close = session.close()
    await closing.promise
    receipt.resolve(closed)
    await expect(candidate).resolves.toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_EXPIRED' } })
    await close
  } finally {
    receipt.resolve(closed)
    await client.dispose()
  }
})
