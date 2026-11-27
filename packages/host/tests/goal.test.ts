import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { ScriptedHarnessAdapter } from '@anureo/conformance'
import { createClient } from '@anureo/sdk'
import { HarnessHost, type HostConnection } from '../src/index'
import { HarnessStore } from '../src/sqlite-bun'

test('native Goal completion is persisted and unblocks queued input', async () => {
  const adapter = new ScriptedHarnessAdapter()
  const host = new HarnessHost({
    store: new HarnessStore(':memory:'),
    runtimes: [{ id: 'r', adapterId: 'fake', create: () => createClient({ adapter, identity: { adapterId: 'fake', runtimeConfigId: 'r' } }) }],
    projectRoot: () => tmpdir(),
    can: () => true,
  })
  const connection: HostConnection = { id: 'goal-test', principal: () => ({ userId: 'u', mode: 'on' }), send: () => {} }
  try {
    await host.request(connection, 'hx.initialize', { protocolVersions: [1], clientInfo: { name: 'test', version: '1' } })
    const sessionId = (await host.request(connection, 'hx.session.create', { projectId: 'p', runtimeConfigId: 'r', idempotencyKey: 'create' })).sessionId!
    const goal = { objective: 'Finish the task', status: 'active' }
    const set = await host.request(connection, 'hx.goal.set', { sessionId, expectedRevision: 1, idempotencyKey: 'goal', goal })
    expect(set.state).toBe('completed')
    expect(host.publicSession(sessionId).goal).toEqual({ goal, status: 'active' })
    await host.request(connection, 'hx.queue.enqueue', { sessionId, expectedQueueRevision: 0, idempotencyKey: 'queued', input: [{ type: 'text', text: 'After Goal' }] })
    expect(adapter.calls.some(call => call.method === 'input/submit')).toBe(false)

    const done = { goal: { ...goal, status: 'complete' }, status: 'cleared' } as const
    await adapter.backends.get(sessionId)!.emit({ type: 'session/goal', payload: done })
    for (let attempt = 0; attempt < 100 && !adapter.calls.some(call => call.method === 'input/submit'); attempt++) await Bun.sleep(10)
    expect(host.publicSession(sessionId).goal).toEqual(done)
    expect(host.transcript(sessionId)).toContainEqual(expect.objectContaining({ event: { type: 'session/goal', payload: done } }))
    expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1)
  } finally { await host.close() }
})
