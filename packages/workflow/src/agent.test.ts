import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createClient, HarnessSdkError, type Client, type SessionEventSink } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'
import { agent, parallel } from './index'

const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })

async function fixture(options?: FakeAdapterOptions) {
  const adapter = createScriptedAdapter(options)
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, adapter }
}
async function complete(sink: SessionEventSink, turnId: string, text: string) {
  await sink.emit({ type: 'item/completed', payload: { item: { id: randomUUID(), type: 'agentMessage', phase: 'final', text } } }, { turnId })
  await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
}

test('returns text from independent sessions and leaves the borrowed client usable', async () => {
  const { client, adapter } = await fixture()
  expect(await parallel([
    () => agent('first', { client, cwd: process.cwd(), model: 'test-model', instructions: 'review carefully' }),
    () => agent('second', { client, cwd: process.cwd() }),
  ])).toEqual(['first', 'second'])
  expect(adapter.opened).toHaveLength(2)
  expect(new Set(adapter.opened.map(session => session.binding.sessionId)).size).toBe(2)
  expect(adapter.opened[0]).toMatchObject({ cwd: process.cwd(), model: 'test-model', instructions: 'review carefully' })
  expect([...adapter.backends.values()].every(backend => backend.disposeCount === 1)).toBe(true)
  expect(adapter.disposeCount).toBe(0)
  expect(await agent('third', { client, cwd: process.cwd() })).toBe('third')
})

test('each call chooses its backend explicitly without shared configuration', async () => {
  const a = await fixture(), b = await fixture()
  expect(await parallel([
    () => agent('backend a', { client: a.client, cwd: '/a' }),
    () => agent('backend b', { client: b.client, cwd: '/b' }),
  ])).toEqual(['backend a', 'backend b'])
  expect(a.adapter.opened[0]?.cwd).toBe('/a')
  expect(b.adapter.opened[0]?.cwd).toBe('/b')
})

test('native association and acceptance do not replace terminal evidence', async () => {
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  let finish!: () => Promise<void>
  const { client, adapter } = await fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.bindSubmission(call.params.submissionId, turnId)
    finish = () => complete(sink, turnId, 'actual terminal text')
    start()
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  let settled = false
  const result = agent('wait for native work', { client, cwd: process.cwd() }).then(text => { settled = true; return text })
  await started
  expect(settled).toBe(false)
  expect(adapter.calls.some(call => call.method === 'session/close')).toBe(false)
  await finish()
  expect(await result).toBe('actual terminal text')
})

test('preserves native failure details and releases the session', async () => {
  const { client, adapter } = await fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: {
      code: 'NATIVE_FAILED', message: 'native failure', retryable: true, outcomeUnknown: false, details: { reason: 'test' },
    } } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  await expect(agent('fail', { client, cwd: process.cwd() })).rejects.toMatchObject({
    code: 'NATIVE_FAILED', retryable: true, outcomeUnknown: false, details: { reason: 'test' },
  })
  expect(adapter.calls.some(call => call.method === 'session/close')).toBe(true)
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('an interrupted execution cannot return successful text', async () => {
  const { client, adapter } = await fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'interrupted' } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  await expect(agent('interrupted', { client, cwd: process.cwd() })).rejects.toMatchObject({ code: 'AGENT_INTERRUPTED' })
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('unknown submission outcomes are preserved without retries or implicit interrupts', async () => {
  const failure = new HarnessSdkError('RECEIPT_LOST', 'receipt lost', false, true)
  const { client, adapter } = await fixture({ execute: async call => {
    if (call.method === 'input/submit') throw failure
    return undefined
  } })
  await expect(agent('send once', { client, cwd: process.cwd() })).rejects.toMatchObject({ code: 'RECEIPT_LOST', outcomeUnknown: true })
  expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1)
  expect(adapter.calls.some(call => call.method === 'turn/interrupt' || call.method === 'session/interrupt')).toBe(false)
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('source failure remains uncertain and is not converted into successful cleanup', async () => {
  const { client, adapter } = await fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.bindSubmission(call.params.submissionId, turnId)
    await sink.fail(new HarnessSdkError('CONNECTION_LOST', 'lost', false, true))
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  await expect(agent('source disappears', { client, cwd: process.cwd() })).rejects.toMatchObject({ code: 'CONNECTION_LOST', outcomeUnknown: true })
  expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1)
})

test('opening failure does not submit input or dispose the borrowed client', async () => {
  const { client, adapter } = await fixture({ onOpen: async () => { throw new HarnessSdkError('OPEN_FAILED') } })
  await expect(agent('not sent', { client, cwd: process.cwd() })).rejects.toMatchObject({ code: 'OPEN_FAILED' })
  expect(adapter.calls).toHaveLength(0)
  expect(adapter.disposeCount).toBe(0)
})

test('cleanup failure is surfaced and backend disposal is still attempted', async () => {
  const { client, adapter } = await fixture({ execute: async call => {
    if (call.method === 'session/close') throw new HarnessSdkError('CLOSE_FAILED')
    return undefined
  } })
  await expect(agent('completed but cleanup failed', { client, cwd: process.cwd() })).rejects.toMatchObject({
    code: 'RESOURCE_RELEASE_FAILED', details: { errors: [{ code: 'CLOSE_FAILED', outcomeUnknown: false }] },
  })
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('cleanup failure cannot hide the primary uncertain execution failure', async () => {
  const { client, adapter } = await fixture({ execute: async call => {
    if (call.method === 'input/submit') throw new HarnessSdkError('RECEIPT_LOST', 'receipt lost', false, true)
    if (call.method === 'session/close') throw new HarnessSdkError('CLOSE_FAILED')
    return undefined
  } })
  await expect(agent('once', { client, cwd: process.cwd() })).rejects.toMatchObject({
    code: 'RECEIPT_LOST', outcomeUnknown: true,
    details: { cleanupErrors: [{ code: 'CLOSE_FAILED', outcomeUnknown: false }] },
  })
  expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1)
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})
