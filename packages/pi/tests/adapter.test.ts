import { expect, test } from 'bun:test'
import { fixture, observe, request, types, until } from './test-helpers'
import { fakeFactory } from './fake-host'
import { createClient } from '@anureo/sdk'
import { createPiAdapter } from '../src/index'

test('a prompt streams items in order and completes only when Pi settles', async () => {
  const f = await fixture()
  try {
    const turn = await observe(f.session.submit({ input: 'hello' }))
    const result = await turn.result()
    expect(result.status).toBe('completed')
    expect(result.text).toBe('done: hello')
    expect(result.usage).toMatchObject({ input: 7, output: 9, cacheRead: 2, cacheWrite: 1 })
    await until(() => types(f.events).includes('session/state'))
    const order = types(f.events).filter(type => type !== 'session/state')
    expect(order.indexOf('turn/started')).toBeLessThan(order.indexOf('item/started'))
    expect(order.indexOf('item/completed')).toBeLessThan(order.indexOf('turn/completed'))
    expect(f.events.filter(e => e.type === 'turn/started')).toHaveLength(1)
    const completed = f.events.find(e => e.type === 'item/completed')
    expect(completed).toMatchObject({ payload: { item: { type: 'agentMessage', phase: 'final', text: 'done: hello' } } })
  } finally { await f.dispose() }
})

test('agent_end followed by automatic continuation keeps the turn active until settled', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => {
      await host.assistant('first attempt', { stopReason: 'error', errorMessage: '503 overloaded' })
      host.emit({ type: 'agent_end', willRetry: true })
      host.emit({ type: 'retry', phase: 'start', attempt: 1 })
      await host.assistant('recovered')
    }
    const turn = await observe(f.session.submit({ input: 'retry me' }))
    const result = await turn.result()
    expect(result.status).toBe('completed')
    await until(() => types(f.events).includes('session/state'))
    expect(f.events.filter(e => e.type === 'turn/completed')).toHaveLength(1)
    expect(f.events.some(e => e.type === 'notice' && e.payload.code === 'PI_AUTO_RETRY')).toBe(true)
  } finally { await f.dispose() }
})

test('an error stop reason fails the turn with a typed error and never forwards native text', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => { await host.assistant('', { stopReason: 'error', errorMessage: '429 rate limited for key sk-secret-123' }) }
    const turn = await observe(f.session.submit({ input: 'x' }))
    const result = await turn.result()
    expect(result.status).toBe('failed')
    expect((result as { error?: unknown }).error).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(JSON.stringify(f.events)).not.toContain('sk-secret-123')
  } finally { await f.dispose() }
})

test('tool calls become toolCall items with output and file changes', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => {
      await host.toolRound('call-1', 'bash', { command: 'ls' }, 'a.txt')
      await host.toolRound('call-2', 'edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }] }, 'ok')
      await host.toolRound('call-3', 'read', { path: 'nope' }, 'ENOENT', true)
      await host.assistant('finished')
    }
    const turn = await observe(f.session.submit({ input: 'tools' }))
    await turn.result()
    const done = f.events.flatMap(e => e.type === 'item/completed' && e.payload.item.type === 'toolCall' ? [e.payload.item] : [])
    expect(done.map(item => [item.id, item.kind, item.status, item.output])).toEqual([
      ['call-1', 'command', 'completed', 'a.txt'], ['call-2', 'fileChange', 'completed', 'ok'], ['call-3', 'other', 'failed', 'ENOENT'],
    ])
    expect(done[1]!.fileChanges?.[0]).toMatchObject({ path: 'a.txt', operation: 'modify', completeness: 'complete' })
  } finally { await f.dispose() }
})

test('native delivery steers an active turn and joins it; afterTurn uses follow-up', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => { await host.hold(); await host.assistant('end') }
    const first = await observe(f.session.submit({ input: 'one' }))
    await until(() => f.events.some(e => e.type === 'turn/started'))
    const steered = await observe(f.session.submit({ input: 'focus' }))
    const later = await observe(f.session.submit({ input: 'then this', delivery: 'afterTurn' }))
    expect(f.host.steered).toEqual(['focus'])
    expect(f.host.followed).toEqual(['then this'])
    await expect(first.steer({ input: 'exact' })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(first.interrupt()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect((await steered).id).toBe(first.id)
    expect((await later).id).toBe(first.id)
    f.host.release!()
    expect((await first.result()).status).toBe('completed')
    expect(f.events.filter(e => e.type === 'turn/started')).toHaveLength(1)
  } finally { await f.dispose() }
})

test('input consumed by an extension is accepted without being reported as queued agent input', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => { await host.hold(); await host.assistant('end') }
    const first = await observe(f.session.submit({ input: 'one' }))
    await until(() => f.events.some(e => e.type === 'turn/started'))
    f.host.steerDisposition = 'handled'
    const handled = f.session.submit({ input: '/ext cmd' }, { timeoutMs: 100 })
    await expect(handled).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' }) // no execution to bind: nothing invented
    expect(f.events.filter(e => e.type === 'submission/bound')).toHaveLength(1)
    f.host.release!(); await first.result()
  } finally { await f.dispose() }
})

test('interrupt aborts native work and the turn ends as interrupted', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => { await host.toolRound('c1', 'bash', { command: 'sleep' }, ''); await host.hold() }
    const turn = await observe(f.session.submit({ input: 'long' }))
    await until(() => f.events.some(e => e.type === 'item/started' && e.payload.item.type === 'toolCall'))
    const receipt = await f.session.interrupt()
    expect(receipt.accepted).toBe(true)
    expect(f.host.calls.filter(call => call.method === 'abort')).toHaveLength(1)
    expect((await turn.result()).status).toBe('interrupted')
  } finally { await f.dispose() }
})

test('closing during an active turn aborts, disposes the host and leaks no listeners', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => { await host.hold() }
    const turn = await observe(f.session.submit({ input: 'long' }))
    await until(() => f.events.some(e => e.type === 'turn/started'))
    expect(await f.session.close()).toMatchObject({ observationClosed: true, executionStopped: 'unconfirmed' })
    await expect(turn.result()).rejects.toMatchObject({ code: 'OBSERVATION_CLOSED' })
    expect(f.host.disposed).toBe(true)
    expect(f.host.listeners.size).toBe(0)
    expect(f.host.calls.some(call => call.method === 'abort')).toBe(true)
    expect(f.events.some(e => e.type === 'turn/completed')).toBe(false)
  } finally { await f.dispose() }
})

test('a native prompt failure rejects the submission with a typed error and the session still closes', async () => {
  const f = await fixture()
  try {
    f.host.promptError = new Error('no api key configured for sk-live-999')
    await expect(f.session.submit({ input: 'x' })).rejects.toMatchObject({ code: 'PI_SUBMIT_FAILED' })
    await expect(f.session.close()).resolves.toMatchObject({ closed: true })
    expect(f.host.disposed).toBe(true)
  } finally { await f.dispose() }
})

test('a prompt handled by an extension is accepted without a turn', async () => {
  const f = await fixture()
  try {
    f.host.promptDisposition = 'handled'
    const turn = f.session.submit({ input: '/command' }, { timeoutMs: 100 })
    await expect(turn).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(f.events.some(e => e.type === 'turn/started')).toBe(false)
  } finally { await f.dispose() }
})

test('structured output schemas and file inputs are rejected explicitly', async () => {
  const f = await fixture()
  try {
    await expect(f.session.submit({ input: 'x', outputSchema: { type: 'object' } } as never)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect(f.host.calls.filter(call => call.method === 'prompt')).toHaveLength(0)
  } finally { await f.dispose() }
})

test('read-only sessions restrict Pi to non-mutating tools and unsupported modes fail', async () => {
  const f = await fixture({}, { cwd: process.cwd(), config: { permissionMode: 'read-only' } })
  try {
    const tools = f.opens[0]!.tools!
    expect(tools).toEqual(['read', 'grep', 'find', 'ls'])
    for (const mutating of ['bash', 'edit', 'write']) expect(tools).not.toContain(mutating)
    await request(f.session, 'session/config/set', { patch: { permissionMode: 'agent-full-access' } })
    expect(f.host.calls.find(call => call.method === 'setActiveTools')!.value).toContain('bash')
    await expect(request(f.session, 'session/config/set', { patch: { permissionMode: 'agent' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  } finally { await f.dispose() }
  const fake = fakeFactory()
  const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'test' } })
  try { await expect(client.sessions.create({ cwd: process.cwd(), config: { permissionMode: 'agent' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' }) } finally { await client.dispose() }
})

test('config changes apply to Pi and invalid values leave the previous one', async () => {
  const f = await fixture()
  try {
    const state = await request(f.session, 'session/config/set', { patch: { model: 'fake/small' } })
    expect(state.model).toBe('fake/small')
    expect(f.host.model).toBe('fake/small')
    await expect(request(f.session, 'session/config/set', { patch: { model: 'fake/missing' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(f.host.model).toBe('fake/small')
    await expect(request(f.session, 'session/config/set', { patch: { thinkingLevel: 'high' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(f.host.thinkingLevel).toBe('medium')
    await request(f.session, 'session/config/set', { patch: { model: 'fake/big', thinkingLevel: 'high' } })
    expect(f.host.thinkingLevel).toBe('high')
  } finally { await f.dispose() }
})

test('history is ordered, paged and pairs tool results with their calls', async () => {
  const f = await fixture()
  try {
    f.host.script = async host => { await host.toolRound('c1', 'bash', { command: 'ls' }, 'out'); await host.assistant('all done') }
    await (await f.session.submit({ input: 'first' })).result()
    await (await f.session.submit({ input: 'second' })).result()
    const page = await request(f.session, 'history/read', { limit: 3 })
    expect(page.items).toHaveLength(3)
    expect(page.nextCursor).toBeTruthy()
    const rest = await request(f.session, 'history/read', { cursor: page.nextCursor!, snapshotToken: page.snapshotToken, limit: 100 })
    const all = [...page.items, ...rest.items]
    expect(all.map(entry => entry.item.type)).toEqual(['userMessage', 'toolCall', 'agentMessage', 'userMessage', 'toolCall', 'agentMessage'])
    expect(all[1]!.item).toMatchObject({ type: 'toolCall', output: 'out' })
    expect(new Set(all.map(entry => entry.turnId)).size).toBe(2)
    await expect(request(f.session, 'history/read', { cursor: 'abc', snapshotToken: page.snapshotToken })).rejects.toMatchObject({ code: 'CURSOR_INVALID' })
    await expect(request(f.session, 'history/read', { snapshotToken: 'missing' })).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
  } finally { await f.dispose() }
})

test('fork keeps history up to the boundary and events flow for the new session', async () => {
  const f = await fixture()
  try {
    const one = await f.session.submit({ input: 'one' }); await one.result()
    const two = await f.session.submit({ input: 'two' }); await two.result()
    const forked = await f.client.sessions.fork(f.session.reference, { boundary: { turnId: one.id, relation: 'through' } })
    const forkEvents: typeof f.events = []
    const reader = forked.events()[Symbol.asyncIterator]()
    void (async () => { try { for (;;) { const n = await reader.next(); if (n.done) break; forkEvents.push(n.value) } } catch { /* closed */ } })()
    const history = await request(forked, 'history/read', {})
    expect(history.items.map(entry => entry.item.type === 'userMessage' ? entry.item.content[0] : entry.item.type)).toEqual([{ type: 'text', text: 'one' }, 'agentMessage'])
    const turn = await forked.submit({ input: 'branch' }); expect((await turn.result()).text).toBe('done: branch')
    await until(() => forkEvents.some(e => e.type === 'turn/completed'))
    const before = await f.client.sessions.fork(f.session.reference, { boundary: { turnId: two.id, relation: 'before' } })
    expect((await request(before, 'history/read', {})).items).toHaveLength(2)
    const empty = await f.client.sessions.fork(f.session.reference, { boundary: { turnId: one.id, relation: 'before' } })
    expect((await request(empty, 'history/read', {})).items).toHaveLength(0)
    await expect(f.client.sessions.fork(f.session.reference, { boundary: { turnId: 'unknown', relation: 'through' } })).rejects.toMatchObject({ code: 'TURN_NOT_FOUND' })
    await forked.close(); await before.close(); await empty.close()
    for (const host of f.hosts) expect(host.listeners.size === 0 || !host.disposed).toBe(true)
  } finally { await f.dispose() }
})

test('resume reopens a persisted session with its history', async () => {
  const f = await fixture()
  try {
    await (await f.session.submit({ input: 'remember' })).result()
    const reference = f.session.reference
    await f.session.close()
    const resumed = await f.client.sessions.resume(reference)
    expect((await request(resumed, 'history/read', {})).items[0]!.item).toMatchObject({ type: 'userMessage' })
    await resumed.close()
  } finally { await f.dispose() }
})

test('compaction surfaces as notices outside a turn and as items inside one, and leaves the session usable', async () => {
  const f = await fixture()
  try {
    expect(await request(f.session, 'compact/start', {})).toMatchObject({ status: 'completed' })
    await until(() => f.events.filter(e => e.type === 'notice').length === 2)
    expect(f.events.flatMap(e => e.type === 'notice' ? [e.payload.code] : [])).toEqual(['PI_COMPACTION_STARTED', 'PI_COMPACTION_COMPLETED'])
    f.host.script = async host => { host.emit({ type: 'compaction_start', reason: 'threshold' }); host.emit({ type: 'compaction_end', reason: 'threshold', aborted: false, summary: 's' }); await host.assistant('ok') }
    expect((await (await f.session.submit({ input: 'after' })).result()).status).toBe('completed')
    const compaction = f.events.flatMap(e => e.type === 'item/completed' && e.payload.item.type === 'compaction' ? [e.payload.item] : [])
    expect(compaction).toHaveLength(1)
    expect(compaction[0]).toMatchObject({ status: 'completed', trigger: 'threshold', summary: 's' })
  } finally { await f.dispose() }
})

test('configured secrets are redacted from events and history', async () => {
  const f = await fixture({ secrets: ['TOPSECRET'] })
  try {
    f.host.script = async host => { await host.toolRound('c1', 'bash', { command: 'echo TOPSECRET' }, 'TOPSECRET printed'); await host.assistant('the key is TOPSECRET') }
    await (await f.session.submit({ input: 'go' })).result()
    const history = await request(f.session, 'history/read', {})
    expect(JSON.stringify(f.events)).not.toContain('TOPSECRET')
    expect(JSON.stringify(history)).not.toContain('TOPSECRET')
    expect(JSON.stringify(f.events)).toContain('[REDACTED]')
  } finally { await f.dispose() }
})

test('an unverified Pi version advertises only the baseline and rejects optional capabilities', async () => {
  const f = await fixture({ version: '0.9.0' })
  try {
    expect(f.session.capabilities.session?.fork).toEqual([])
    expect(f.session.capabilities.session?.resume).toBe(false)
    expect(f.session.capabilities.compact).toBeUndefined()
    await expect(request(f.session, 'compact/start', {})).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(request(f.session, 'goal/set', { goal: {} })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(f.session.interrupt()).resolves.toMatchObject({ accepted: true })
  } finally { await f.dispose() }
})

test('revert, goal and review are never advertised', async () => {
  const f = await fixture()
  try {
    expect(f.session.capabilities.session?.revert).toBeUndefined()
    expect(f.session.capabilities.goal).toBeUndefined()
    expect(f.session.capabilities.review).toBeUndefined()
    expect(f.session.capabilities.interactions).toBeUndefined()
  } finally { await f.dispose() }
})

test('adapter disposal disposes every open host', async () => {
  const f = await fixture()
  const other = await f.client.sessions.create({ cwd: process.cwd() })
  await f.client.dispose()
  expect(f.hosts.every(host => host.disposed)).toBe(true)
  expect(f.hosts.every(host => host.listeners.size === 0)).toBe(true)
  void other
  await f.dispose().catch(() => {})
})
