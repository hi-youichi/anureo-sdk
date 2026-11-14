import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { createClient, type Client, type InteractionHandlers, type Session } from '@anureo/sdk'
import type { AhpEvent } from '@anureo/protocol'
import type { HermesAdapterOptions } from '../src'
import { startFake, until } from './helpers'

/** Run a scenario with an initialized client, disposing client observation before the shared fixture owner on every outcome. */
async function withFixture(scenario: string, run: (fixture: Awaited<ReturnType<typeof startFake>>, client: Client) => Promise<void>, options: HermesAdapterOptions = {}, interactions?: InteractionHandlers) {
  const fixture = await startFake(scenario)
  let client: Client | undefined
  try {
    client = await createClient({ adapter: fixture.adapter(options), identity: { adapterId: 'hermes', runtimeConfigId: 'fake-profile' }, interactions })
    await run(fixture, client)
  } finally { await client?.dispose(); await fixture.dispose() }
}

/** Record live events while turn.result remains the source-error assertion; callers must stop the iterator before client disposal. */
function collect(session: Session) {
  const events: AhpEvent[] = [], iterator = session.events()[Symbol.asyncIterator]()
  const task = (async () => { try { for (;;) { const next = await iterator.next(); if (next.done) return; events.push(next.value) } } catch { /* Tests assert source errors through the public turn. */ } })()
  return { events, async stop() { await iterator.return?.(); await task } }
}

test('initialization describes a ticketed owner without creating a session and keeps diagnostics credential-free', async () => {
  const diagnostics: string[] = []
  await withFixture('lifecycle', async (fixture, client) => {
    expect((await fixture.state()).creates).toBe(0)
    const session = await client.sessions.create({ cwd: tmpdir(), model: 'fake-model' })
    expect(session.binding.nativeRef).toEqual({ provider: 'hermes', value: 'session-1' })
    expect(session.snapshot.metadata?.title).toBe('Native title')
    expect(diagnostics).toContain('HERMES_ATTACH_STDERR')
    expect(JSON.stringify(diagnostics)).not.toContain('test-sensitive-stderr')
    const state = await fixture.state()
    expect(state.attachArgs[0]).toContain('--start')
    expect(state.methods).not.toContain('client.capabilities')
  }, { diagnostic: value => diagnostics.push(value), env: { FAKE_HERMES_STDERR: 'test-sensitive-stderr' } })
})

test.each(['old-contract', 'code-mismatch', 'legacy', 'bad-stdout'])('incompatible or malformed %s fails before session creation', async scenario => {
  const fixture = await startFake(scenario)
  try {
    await expect(createClient({ adapter: fixture.adapter({ env: { ...(scenario === 'legacy' ? { FAKE_HERMES_LEGACY: '1' } : {}), ...(scenario === 'bad-stdout' ? { FAKE_HERMES_BAD_STDOUT: '1' } : {}) } }),
      identity: { adapterId: 'hermes', runtimeConfigId: 'test' } })).rejects.toMatchObject({ code: scenario === 'code-mismatch' ? 'HERMES_GATEWAY_CODE_MISMATCH' : scenario === 'bad-stdout' ? 'PROTOCOL_ERROR' : 'HERMES_GATEWAY_UNSUPPORTED' })
    expect((await fixture.state()).creates).toBe(0)
  } finally { await fixture.dispose() }
})

test('unsupported instructions, permissions, MCP and output constraints are rejected before native mutation', async () => {
  await withFixture('lifecycle', async (fixture, client) => {
    for (const extra of [{ instructions: 'system instructions' }, { permissionMode: 'read-only' }, { mcpServers: [] }, { config: { arbitrary: true } }]) {
      await expect(client.sessions.create({ cwd: tmpdir(), ...extra })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    }
    expect((await fixture.state()).creates).toBe(0)
    const session = await client.sessions.create({ cwd: tmpdir() })
    await expect(session.submit({ input: 'hello', outputSchema: { type: 'object' } })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await expect(session.submit({ input: [{ type: 'file', uri: 'file:///tmp/test' }] })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect((await fixture.state()).inputs).toHaveLength(0)
  })
})

test('authoritative final snapshots replace streamed text and cumulative usage remains session-scoped', async () => {
  await withFixture('lifecycle', async (_fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const turn = await session.submit({ input: 'hello' }), result = await turn.result()
      expect(result.text).toBe('authoritative final')
      expect(result.usage).toBeUndefined()
      expect(result.items.filter(value => value.type === 'agentMessage' && value.phase === 'final')).toHaveLength(1)
      expect(result.items.find(value => value.type === 'reasoning')).toMatchObject({ summary: 'brief reasoning' })
      expect(read.events.some(value => value.type === 'usage/updated' && value.payload.scope === 'session')).toBe(true)
    } finally { await read.stop() }
  })
})

test.each(['delta-replay', 'delta-gap'])('%s preserves text overlap and native terminal authority', async scenario => {
  await withFixture(scenario, async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const result = await (await session.submit({ input: 'stream once' })).result()
      expect(result).toMatchObject({ status: 'completed', text: 'authoritative final' })
      const streamed = read.events.flatMap(event => event.type === 'item/delta' && event.payload.kind === 'text' ? [event.payload.text] : []).join('')
      expect(streamed).toBe(scenario === 'delta-replay' ? 'provisional continued' : 'provisional ')
      const gaps = result.items.filter(item => item.type === 'notice' && item.code === 'HERMES_PROGRESS_GAP')
      expect(gaps).toHaveLength(scenario === 'delta-gap' ? 1 : 0)
      expect((await fixture.state()).inputs).toHaveLength(1)
    } finally { await read.stop() }
  })
})

test('conflicting streamed overlap fails observation without fabricating terminal evidence or resending input', async () => {
  await withFixture('delta-conflict', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const turn = await session.submit({ input: 'stream once' })
      await expect(turn.result()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', outcomeUnknown: true })
      expect(read.events.some(event => event.type === 'turn/completed')).toBe(false)
      expect((await fixture.state()).inputs).toHaveLength(1)
    } finally { await read.stop() }
  })
})

test('global roster notifications with an empty session ID do not end turn observation', async () => {
  await withFixture('global-events', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    const result = await (await session.submit({ input: 'hello' })).result()
    expect(result.status).toBe('completed')
    expect(result.text).toBe('authoritative final')
    expect((await fixture.state()).inputs).toHaveLength(1)
  })
})

test('a queued input binds only after native claim, with distinct execution identity', async () => {
  await withFixture('overlap', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), first = await session.submit({ input: 'first' })
    let associated = false
    const second = session.submit({ input: 'second' }).then(turn => { associated = true; return turn })
    await until(async () => (await fixture.state()).inputs.length === 2)
    expect(associated).toBe(false)
    await fixture.control('release')
    expect((await second).id).not.toBe(first.id)
    expect((await first.result()).status).toBe('completed')
    expect((await (await second).result()).status).toBe('completed')
  })
})

test('closing active observation leaves the shared owner running and its session can be resumed', async () => {
  await withFixture('hold', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), reference = session.reference
    const turn = await session.submit({ input: 'first' })
    expect(await session.close()).toEqual({ closed: true, observationClosed: true, executionStopped: 'unconfirmed' })
    await expect(turn.result()).rejects.toMatchObject({ code: 'OBSERVATION_CLOSED', outcomeUnknown: true })
    expect((await fixture.state()).active).toBe(1)
    const resumed = await client.sessions.resume(reference)
    expect(resumed.binding.nativeRef).toEqual(reference.binding.nativeRef)
    expect(resumed.snapshot.activeTurnIds).toHaveLength(1)
    await fixture.control('release')
    await until(async () => (await fixture.state()).active === 0)
    expect((await fixture.state()).interrupts).toBe(0)
  })
})

test('interrupt is generation-fenced and terminal evidence can arrive before its ACK', async () => {
  await withFixture('hold', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), first = await session.submit({ input: 'first' })
    await first.interrupt()
    expect((await first.result()).status).toBe('interrupted')
    const second = await session.submit({ input: 'second' })
    await expect(first.interrupt()).rejects.toThrow()
    expect((await fixture.state()).interrupts).toBe(1)
    await second.interrupt()
    expect((await second.result()).status).toBe('interrupted')
  })
})

test('approval choices retain native semantics and permanent grants are not offered', async () => {
  await withFixture('approval', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect((await (await session.submit({ input: 'ask' })).result()).status).toBe('completed')
    expect((await fixture.state()).responses[0]).toMatchObject({ method: 'approval.respond', params: { choice: 'once', execution_generation: 1, prompt_id: 'approval-1' } })
  }, {}, { approval: async request => {
    expect(request.options.some(value => value.id === 'always')).toBe(false)
    return { kind: 'approval', optionId: request.options.find(value => value.semantic === 'allowOnce')!.id }
  } })
})

test('batch clarify uses a response frame and answers each native qid', async () => {
  await withFixture('batch', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect((await (await session.submit({ input: 'ask' })).result()).status).toBe('completed')
    expect((await fixture.state()).responses[0]).toMatchObject({ id: 'srq-1', result: { answers: { q1: 'yes', q2: 'free text' }, outcome: 'submitted' } })
  }, {}, { userInput: async () => ({ kind: 'userInput', answers: { q1: 'yes', q2: 'free text' } }) })
})

test('secret answers reach the native response but are redacted from final results', async () => {
  await withFixture('secret', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    const result = await (await session.submit({ input: 'ask' })).result()
    expect(result.status).toBe('completed')
    expect(JSON.stringify(result)).not.toContain('fixture-private-value')
    expect((await fixture.state()).responses[0]).toMatchObject({ id: 'srq-1', result: { value: 'fixture-private-value' } })
  }, {}, { userInput: async request => {
    expect(request.questions[0]!.secret).toBe(true)
    return { kind: 'userInput', answers: { value: 'fixture-private-value' } }
  } })
})

test('unsupported desktop requests receive a native error instead of stalling the reader', async () => {
  await withFixture('unsupported-request', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect((await (await session.submit({ input: 'ask' })).result()).status).toBe('completed')
    expect((await fixture.state()).responses[0]).toMatchObject({ id: 'srq-1', error: { code: -32601 } })
  })
})

test('an unsupported user interaction is explicitly skipped through its native responder', async () => {
  await withFixture('clarify-cancel', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect((await (await session.submit({ input: 'ask' })).result()).status).toBe('completed')
    expect((await fixture.state()).responses[0]).toMatchObject({ method: 'clarify.respond', params: { answer: '' } })
  })
})

test.each(['reconnect', 'gap', 'ack-lost'])('%s reconciles native terminal evidence without resubmitting input', async scenario => {
  await withFixture(scenario, async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    const turn = await session.submit({ input: 'run once' }), result = await turn.result({ timeoutMs: 5000 })
    expect(result).toMatchObject({ status: 'completed', text: 'authoritative final' })
    expect((await fixture.state()).inputs).toHaveLength(1)
    expect((await fixture.state()).attaches).toBeGreaterThanOrEqual(3)
    if (scenario === 'gap') expect(result.items.some(item => item.type === 'notice' && item.code === 'HERMES_PROGRESS_GAP')).toBe(true)
  })
})

test('owner restart with an unknown receipt fails observation without fabricating terminal or resolving the FIFO', async () => {
  await withFixture('unknown', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const turn = await session.submit({ input: 'run once' })
      let failure: unknown
      try { await turn.result({ timeoutMs: 2000 }) } catch (cause) { failure = cause }
      if (!(failure && typeof failure === 'object' && 'code' in failure && failure.code === 'HERMES_EXECUTION_UNKNOWN')) {
        throw new Error(JSON.stringify({ error: failure instanceof Error ? failure.message : failure, native: await fixture.state(), events: read.events.map(value => value.type) }))
      }
      expect(failure).toMatchObject({ code: 'HERMES_EXECUTION_UNKNOWN', outcomeUnknown: true })
      expect(read.events.some(value => value.type === 'turn/completed')).toBe(false)
      expect((await fixture.state()).inputs).toHaveLength(1)
      expect((await fixture.state()).methods).not.toContain('prompt.resolve_unknown')
    } finally { await read.stop() }
  })
})

test('cancelling an unclaimed native queued row rejects submission without fabricating another turn', async () => {
  await withFixture('queued-cancel', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const first = await session.submit({ input: 'first' })
      const second = session.submit({ input: 'second' }); void second.catch(() => {})
      await until(async () => (await fixture.state()).inputs.length === 2)
      await fixture.control('cancelQueued')
      await expect(second).rejects.toMatchObject({ code: 'INPUT_CANCELLED' })
      expect(read.events.filter(value => value.type === 'turn/started')).toHaveLength(1)
      await first.interrupt()
    } finally { await read.stop() }
  })
})

test.each(['approval-reconnect', 'batch-reconnect'])('%s restores one pending question and responds over the new connection', async scenario => {
  let release: () => void = () => {}, questions = 0
  const answer = new Promise<void>(resolve => { release = resolve })
  try {
    await withFixture(scenario, async (fixture, client) => {
      const session = await client.sessions.create({ cwd: tmpdir() }), turn = await session.submit({ input: 'ask once' })
      await until(async () => (await fixture.state()).methods.includes('session.resume'))
      release()
      expect((await turn.result()).status).toBe('completed')
      expect(questions).toBe(1)
      expect((await fixture.state()).responses).toHaveLength(1)
      expect((await fixture.state()).inputs).toHaveLength(1)
    }, {}, {
      approval: async () => { questions++; await answer; return { kind: 'approval', optionId: 'once' } },
      userInput: async () => { questions++; await answer; return { kind: 'userInput', answers: { q1: 'yes', q2: 'text' } } },
    })
  } finally { release() }
})

test('another viewer settling a prompt closes the interaction without submitting a second answer', async () => {
  let release: () => void = () => {}
  const answer = new Promise<void>(resolve => { release = resolve })
  try {
    await withFixture('approval', async (fixture, client) => {
      const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
      try {
        const turn = await session.submit({ input: 'ask' })
        await until(async () => read.events.some(event => event.type === 'interaction/requested'))
        await fixture.control('external-resolve')
        expect((await turn.result()).status).toBe('completed')
        expect(read.events.some(event => event.type === 'interaction/resolved' && event.payload.outcome === 'unknown')).toBe(true)
        expect((await fixture.state()).responses).toHaveLength(0)
      } finally { await read.stop() }
    }, {}, { approval: async () => { await answer; return { kind: 'approval', optionId: 'once' } } })
  } finally { release() }
})

test('a response still open on the owner after reconnect remains unknown and is never replayed', async () => {
  await withFixture('secret-response-lost', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), turn = await session.submit({ input: 'ask' })
    let failure: unknown
    try { await turn.result({ timeoutMs: 2000 }) } catch (cause) { failure = cause }
    expect(failure).toMatchObject({ code: 'RESULT_UNKNOWN', outcomeUnknown: true })
    expect((await fixture.state()).responses).toHaveLength(1)
    expect((await fixture.state()).inputs).toHaveLength(1)
  }, {}, { userInput: async () => ({ kind: 'userInput', answers: { value: 'private-once' } }) })
})
