import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { createClient, type Client, type InteractionHandlers, type Session } from '@anureo/sdk'
import { spawnHarnessProcess } from '@anureo/sdk/process'
import type { AhpEvent } from '@anureo/protocol'
import type { HermesAdapterOptions } from '../src'
import { startFake, until } from './helpers'

/** Run assertions with an initialized client, then dispose client observation before stopping the fixture owner. */
async function withFixture(
  scenario: string,
  run: (fixture: Awaited<ReturnType<typeof startFake>>, client: Client) => Promise<void>,
  { options, interactions }: { options?: HermesAdapterOptions; interactions?: InteractionHandlers } = {},
): Promise<void> {
  const fixture = await startFake(scenario)
  let client: Client | undefined
  try {
    client = await createClient({ adapter: fixture.adapter(options), identity: { adapterId: 'hermes', runtimeConfigId: 'fake-profile' }, interactions })
    await run(fixture, client)
  } finally { await client?.dispose(); await fixture.dispose() }
}

/** Record live events while turn.result remains the source-error assertion; callers must stop the iterator before client disposal. */
function collect(session: Session) {
  const events: AhpEvent[] = []
  const iterator = session.events()[Symbol.asyncIterator]()
  const task = (async () => {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        events.push(next.value)
      }
    } catch { /* Tests assert source errors through the public turn. */ }
  })()
  return {
    events,
    async stop() {
      await iterator.return?.()
      await task
    },
  }
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
  }, { options: { diagnostic: value => diagnostics.push(value), env: { FAKE_HERMES_STDERR: 'test-sensitive-stderr' } } })
})

test.each(['goal', 'goal-ack-lost'])('Hermes Goal starts exactly one native kickoff and restores completion (%s)', async scenario => {
  await withFixture(scenario, async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect(session.capabilities.goal?.actions).toEqual(['set', 'clear', 'pause', 'resume'])
    const observed = collect(session)
    try {
      const set = { requestId: 'goal-request', sessionId: session.id, goal: { objective: 'pause the cron' } }
      expect(await session.request('goal/set', set)).toMatchObject({ status: 'active', goal: { objective: 'pause the cron', turnBudget: 5 } })
      await session.request('goal/set', set)
      expect((await fixture.state()).inputs.map(input => input.text)).toEqual(['Start the objective'])
      await until(async () => observed.events.some(event => event.type === 'turn/completed'))
      expect(await session.request('goal/pause', { requestId: 'pause-goal', sessionId: session.id })).toMatchObject({ goal: { status: 'paused' } })
      expect(await session.request('goal/resume', { requestId: 'resume-goal', sessionId: session.id })).toMatchObject({ goal: { status: 'active' } })
      expect((await fixture.state()).inputs.map(input => input.text)).toEqual(['Start the objective', 'Continue the objective'])
      await until(async () => observed.events.filter(event => event.type === 'turn/completed').length === 2)
      await fixture.control('completeGoal')
      await until(async () => session.snapshot.goal?.goal?.status === 'complete')
      expect(session.snapshot.goal?.goal).toMatchObject({ turnsUsed: 2, completionTurnId: expect.any(String) })
    } finally { await observed.stop() }
    const reference = session.reference
    await session.close()
    const reopened = await client.sessions.resume(reference)
    expect(reopened.snapshot.goal).toMatchObject({ status: 'cleared', goal: { status: 'complete', turnsUsed: 2 } })
    expect(await reopened.request('goal/clear', { requestId: 'clear-goal', sessionId: reopened.id })).toEqual({ goal: null, status: 'cleared' })
  })
}, 20000)

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
      await expect(client.sessions.create({ cwd: tmpdir(), ...extra })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', ...('instructions' in extra ? { details: { capability: 'session.instructions' } } : {}) })
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

test.each(['late-reasoning', 'late-reasoning-streamed'])('%s surfaces terminal-only reasoning ahead of the final answer instead of after it', async scenario => {
  await withFixture(scenario, async (_fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const result = await (await session.submit({ input: 'think first' })).result()
      expect(result.text).toBe('authoritative final')
      expect(result.items.filter(value => value.type === 'agentMessage')).toHaveLength(1)
      expect(result.items.find(value => value.type === 'reasoning')).toMatchObject({ summary: 'late reasoning', status: 'completed' })
      // First appearance fixes host render order. An unstreamed answer starts after its reasoning;
      // an answer that already streamed keeps its position, but the reasoning starts before it completes.
      const order = read.events.flatMap(value => value.type === 'item/started' ? [`started:${value.payload.item.type}`] : value.type === 'item/completed' ? [`completed:${value.payload.item.type}`] : [])
      const anchor = scenario === 'late-reasoning' ? 'started:agentMessage' : 'completed:agentMessage'
      expect(order.indexOf('started:reasoning')).toBeGreaterThan(-1)
      expect(order.indexOf('started:reasoning')).toBeLessThan(order.indexOf(anchor))
      expect(order).toContain('completed:reasoning')
    } finally { await read.stop() }
  })
})

test('tool results project command rows, flattened output and execution evidence', async () => {
  await withFixture('tool-display', async (_fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() }), read = collect(session)
    try {
      const result = await (await session.submit({ input: 'run tools' })).result()
      expect(result.text).toBe('authoritative final')
      const tools = read.events.flatMap(value => value.type === 'item/completed' && value.payload.item.type === 'toolCall' ? [value.payload.item] : [])
      const byName = new Map(tools.map(item => [item.toolName, item]))
      // Shell tools mirror the codex display model: kind command with the command line as title.
      expect(byName.get('terminal')).toMatchObject({ kind: 'command', title: 'bun test', input: { command: 'bun test' },
        output: 'all green', status: 'completed', durationMs: 1500, extensions: { toolExecution: { exitCode: 0 } } })
      // Failures flatten the error into the output text and surface execution evidence hosts can render.
      expect(byName.get('write_file')).toMatchObject({ kind: 'other', title: 'write_file', output: 'Refusing to overwrite report.md',
        extensions: { toolExecution: { error: { kind: 'tool', message: 'Refusing to overwrite report.md' } } } })
      // Genuinely structured results keep their JSON shape instead of a stringified envelope.
      expect(byName.get('search_files')).toMatchObject({ kind: 'other', title: 'search_files', output: { total_count: 0 } })
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
  }, {
    interactions: { approval: async request => {
      expect(request.options.some(value => value.id === 'always')).toBe(false)
      return { kind: 'approval', optionId: request.options.find(value => value.semantic === 'allowOnce')!.id }
    } },
  })
})

test('batch clarify uses a response frame and answers each native qid', async () => {
  await withFixture('batch', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect((await (await session.submit({ input: 'ask' })).result()).status).toBe('completed')
    expect((await fixture.state()).responses[0]).toMatchObject({ id: 'srq-1', result: { answers: { q1: 'yes', q2: 'free text' }, outcome: 'submitted' } })
  }, { interactions: { userInput: async () => ({ kind: 'userInput', answers: { q1: 'yes', q2: 'free text' } }) } })
})

test('secret answers reach the native response but are redacted from final results', async () => {
  await withFixture('secret', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    const result = await (await session.submit({ input: 'ask' })).result()
    expect(result.status).toBe('completed')
    expect(JSON.stringify(result)).not.toContain('fixture-private-value')
    expect((await fixture.state()).responses[0]).toMatchObject({ id: 'srq-1', result: { value: 'fixture-private-value' } })
  }, {
    interactions: { userInput: async request => {
      expect(request.questions[0]!.secret).toBe(true)
      return { kind: 'userInput', answers: { value: 'fixture-private-value' } }
    } },
  })
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

test('a storage error after admission reconciles the ambiguous submission without sending it again', async () => {
  await withFixture('submit-storage-error', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    const turn = await session.submit({ input: 'run once' })
    expect(await turn.result()).toMatchObject({ status: 'completed', text: 'authoritative final' })
    await until(async () => (await fixture.state()).methods.includes('session.resume'))
    const state = await fixture.state()
    expect(state.inputs).toHaveLength(1)
    expect(state.methods).toContain('session.resume')
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
      const second = session.submit({ input: 'x'.repeat(2048) }); void second.catch(() => {})
      await until(async () => read.events.some(event => event.type === 'submission/status' && event.payload.status === 'queued'))
      await fixture.control('cancelQueued')
      await expect(second).rejects.toMatchObject({ code: 'INPUT_CANCELLED' })
      expect(read.events.filter(value => value.type === 'turn/started')).toHaveLength(1)
      const third = session.submit({ input: 'y'.repeat(2048) }); void third.catch(() => {})
      await until(async () => (await fixture.state()).inputs.length === 3)
      await first.interrupt()
      await fixture.control('release')
      expect((await (await third).result()).status).toBe('completed')
    } finally { await read.stop() }
  }, { options: { maxBufferedBytes: 4096 } })
})

test.each(['approval-reconnect', 'batch-reconnect'])('%s restores one pending question and responds over the new connection', async scenario => {
  let release: () => void = () => {}, questions = 0
  const answer = new Promise<void>(resolve => { release = resolve })
  let reconnect: () => void = () => {}, attaches = 0
  const allowReconnect = new Promise<void>(resolve => { reconnect = resolve })
  try {
    await withFixture(scenario, async (fixture, client) => {
      const session = await client.sessions.create({ cwd: tmpdir() }), turn = await session.submit({ input: 'ask once' })
      try {
        await until(async () => attaches === 3 && questions === 1)
        release()
        const disconnected = await fixture.state()
        expect(disconnected.methods).not.toContain('session.resume')
        expect(disconnected.responses).toHaveLength(0)
      } finally { reconnect() }
      expect((await turn.result()).status).toBe('completed')
      expect(questions).toBe(1)
      expect((await fixture.state()).responses).toHaveLength(1)
      expect((await fixture.state()).inputs).toHaveLength(1)
    }, {
      options: { processFactory: async options => {
        if (++attaches === 3) await allowReconnect
        return spawnHarnessProcess(options)
      } },
      interactions: {
        approval: async () => { questions++; await answer; return { kind: 'approval', optionId: 'once' } },
        userInput: async () => { questions++; await answer; return { kind: 'userInput', answers: { q1: 'yes', q2: 'text' } } },
      },
    })
  } finally { release(); reconnect() }
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
    }, { interactions: { approval: async () => { await answer; return { kind: 'approval', optionId: 'once' } } } })
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
  }, { interactions: { userInput: async () => ({ kind: 'userInput', answers: { value: 'private-once' } }) } })
})


test('Hermes session model changes remain session-scoped, survive resume, and reject unsafe config', async () => {
  await withFixture('lifecycle', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect(session.capabilities.config?.options.some(option => option.id === 'model')).toBe(true)
    const changed = await session.request('session/config/set', { requestId: 'model', sessionId: session.id, patch: { model: 'next-model' } })
    expect(changed.model).toBe('next-model'); expect(changed.config.model).toBe('next-model')
    for (const model of ['x --global', '--global', 'reset', '']) {
      await expect(session.request('session/config/set', { requestId: `bad-${model}`, sessionId: session.id, patch: { model } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    }
    await expect(session.request('session/config/set', { requestId: 'refused', sessionId: session.id, patch: { model: 'refused' } })).rejects.toBeDefined()
    await expect(session.request('session/config/set', { requestId: 'confirm', sessionId: session.id, patch: { model: 'expensive' } })).rejects.toMatchObject({ code: 'MODEL_CONFIRMATION_REQUIRED' })
    expect(session.snapshot.model).toBe('next-model')
    const binding = { ...session.binding, nativeRef: session.binding.nativeRef! }
    await session.request('session/close', { requestId: 'close', sessionId: session.id })
    const resumed = await client.openSession({ requestId: 'resume', mode: 'resume', binding, cwd: tmpdir(), config: { model: 'next-model' } })
    expect(resumed.snapshot.model).toBe('next-model')
    const changedAgain = await resumed.request('session/config/set', { requestId: 'again', sessionId: resumed.id, patch: { model: 'after-resume' } })
    expect(changedAgain.model).toBe('after-resume')
    const canonical = await resumed.request('session/config/set', { requestId: 'alias', sessionId: resumed.id, patch: { model: 'alias' } })
    expect(canonical.model).toBe('resolved-model')
  })
})


test('Hermes reasoning is configurable at creation, in-session, with model changes and after resume', async () => {
  await withFixture('lifecycle', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir(), config: { effort: 'high' } })
    expect((await fixture.state()).createParams[0].reasoning).toBe('high')
    expect(session.snapshot.config.effort).toBe('high')
    const changed = await session.request('session/config/set', { requestId: 'effort', sessionId: session.id, patch: { effort: 'low' } })
    expect(changed.config.effort).toBe('low')
    await expect(session.request('session/config/set', { requestId: 'invalid-effort', sessionId: session.id, patch: { effort: 'hgih' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    const combined = await session.request('session/config/set', { requestId: 'combined', sessionId: session.id, patch: { model: 'next-model', effort: 'xhigh' } })
    expect(combined.model).toBe('next-model'); expect(combined.config.effort).toBe('xhigh')
    const binding = { ...session.binding, nativeRef: session.binding.nativeRef! }
    await session.close()
    const resumed = await client.openSession({ requestId: 'effort-resume', mode: 'resume', binding, cwd: tmpdir(), config: { effort: 'low' } })
    expect(resumed.snapshot.config.effort).toBe('xhigh')
    const off = await resumed.request('session/config/set', { requestId: 'off', sessionId: resumed.id, patch: { effort: 'none' } })
    expect(off.config.effort).toBe('none')
  })
})

test('Hermes without native reasoning selection does not advertise an effort control', async () => {
  await withFixture('no-reasoning', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    expect(session.capabilities.config?.options.some(option => option.id === 'effort')).toBe(false)
    expect(session.snapshot.config.effort).toBeUndefined()
    await expect(client.sessions.create({ cwd: tmpdir(), config: { effort: 'high' } })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect((await fixture.state()).creates).toBe(1)
  })
})


test('disabling the optional output bridge keeps persistent native sessions free of ephemeral MCP endpoints', async () => {
  await withFixture('mcp', async (fixture, client) => {
    const session = await client.sessions.create({ cwd: tmpdir() })
    const created = (await fixture.state()).createParams[0]
    expect(created.source).toBe('tool')
    expect(created.editor).toBeUndefined()
    expect(session.capabilities.turn?.outputSchema).toBe(false)
    const binding = { ...session.binding, nativeRef: session.binding.nativeRef! }
    await session.close()
    const resumed = await client.openSession({ requestId: 'no-bridge-resume', mode: 'resume', binding, cwd: tmpdir() })
    expect(resumed.binding.nativeRef).toEqual(binding.nativeRef)
  }, { options: { outputBridge: false } })
})
