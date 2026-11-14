import { createFixture } from './test-helpers'
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { HarnessSdkError, type Client, type SessionEventSink } from '@anureo/sdk'
import { z } from 'zod'
import { agent, parallel, pipeline, type AgentOptions } from './index'
import type { HarnessError } from '@anureo/protocol'

const clients: Client[] = []
const fixture = createFixture(clients)
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })

/** Publish final text before completion so the retained terminal includes it. */
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
  const { promise: terminalEmitterReady, resolve: resolveTerminalEmitter } = Promise.withResolvers<() => Promise<void>>()
  const { client, adapter } = await fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.bindSubmission(call.params.submissionId, turnId)
    resolveTerminalEmitter(() => complete(sink, turnId, 'actual terminal text'))
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  let settled = false
  const result = agent('wait for native work', { client, cwd: process.cwd() }).then(text => { settled = true; return text })
  const emitTerminal = await terminalEmitterReady
  expect(settled).toBe(false)
  expect(adapter.calls.some(call => call.method === 'session/close')).toBe(false)
  await emitTerminal()
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

/** Script a retained terminal before submit's reply, including partial text on failed/interrupted turns. */
async function terminalFixture(
  status: 'failed' | 'interrupted' | 'completed',
  { error, text = 'partial' }: { error?: HarnessError; text?: string } = {},
) {
  return fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'item/completed', payload: { item: { id: 'output', type: 'agentMessage', phase: 'final', text } } }, { turnId })
    // Deliberately terminal before submit's reply: no event subscription can recover this later.
    await sink.emit({ type: 'turn/completed', payload: { turnId, status, ...(error ? { error } : {}) } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
}

test('Zod schema is converted for submission and returns typed data through composition', async () => {
  const schema = z.object({ count: z.number() })
  const { client, adapter } = await terminalFixture('completed', { text: '{"count":3}' })
  const options = { client, cwd: process.cwd(), schema }
  const results = await pipeline(['a', 'b'], prompt => agent(prompt, options), value => value.count * 2)
  expect(results).toEqual([6, 6])
  const starts = adapter.calls.filter(call => call.method === 'input/submit')
  expect(starts).toHaveLength(2)
  expect(starts[0]!.params).toMatchObject({ outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'number' } }, additionalProperties: false } })
  expect('outputSchema' in starts[0]!.params && starts[0]!.params.outputSchema).not.toBe(schema)
  expect([...adapter.backends.values()].every(backend => backend.disposeCount === 1)).toBe(true)
})

test('schema preflight rejects before opening, while absent backend support releases without submitting', async () => {
  const { client, adapter } = await fixture()
  await expect(agent('invalid', { client, cwd: '.', schema: z.object({ a: z.coerce.number() }) })).rejects.toMatchObject({ code: 'INVALID_PARAMS', outcomeUnknown: false })
  expect(adapter.opened).toHaveLength(0)
  const unsupported = await fixture({ capabilities: { turn: { outputSchema: false } } })
  await expect(agent('unsupported', { client: unsupported.client, cwd: '.', schema: z.object({ a: z.string() }) })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(unsupported.adapter.calls.some(call => call.method === 'input/submit')).toBe(false)
  expect([...unsupported.adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('session cleanup waits for asynchronous local output validation', async () => {
  const entered = Promise.withResolvers<void>()
  const validation = Promise.withResolvers<boolean>()
  const schema = z.object({ count: z.number() }).refine(async () => {
    entered.resolve()
    return validation.promise
  })
  const { client, adapter } = await terminalFixture('completed', { text: '{"count":3}' })
  const result = agent('validate before cleanup', { client, cwd: '.', schema })
  try {
    await entered.promise
    expect(adapter.calls.some(call => call.method === 'session/close')).toBe(false)
    expect([...adapter.backends.values()][0]?.disposeCount).toBe(0)
  } finally {
    validation.resolve(true)
  }
  expect(await result).toEqual({ count: 3 })
  expect(adapter.calls.some(call => call.method === 'session/close')).toBe(true)
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test.each(['AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'USAGE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'NATIVE_SERVICE_UNAVAILABLE'])('only terminal %s becomes null', async code => {
  const error = { code, message: 'native api error', retryable: true, outcomeUnknown: false }
  const { client, adapter } = await terminalFixture('failed', { error })
  expect(await agent('failed terminal', { client, cwd: '.' })).toBeNull()
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
  for (const stage of ['open', 'submit']) {
    const denied = await fixture(stage === 'open'
      ? { onOpen: async () => { throw new HarnessSdkError(code) } }
      : { execute: async call => { if (call.method === 'input/submit') throw new HarnessSdkError(code); return undefined } })
    await expect(agent('not a terminal', { client: denied.client, cwd: '.' })).rejects.toMatchObject({ code })
  }
})

test.each(['NATIVE_TURN_FAILED', 'CLAUDE_TURN_FAILED', 'NATIVE_REQUEST_INVALID', 'CLAUDE_STRUCTURED_OUTPUT_RETRIES_EXCEEDED', 'CLAUDE_MAX_TURNS_EXCEEDED'])('terminal %s still rejects', async code => {
  const { client } = await terminalFixture('failed', { error: { code, message: 'failure', retryable: false, outcomeUnknown: false } })
  await expect(agent('fail', { client, cwd: '.' })).rejects.toMatchObject({ code })
})

test('uncertainty overrides API and skip classifications, and generic interruptions never become null', async () => {
  for (const status of ['failed', 'interrupted'] as const) {
    const { client } = await terminalFixture(status, { error: { code: 'RATE_LIMITED', message: 'unknown', retryable: false, outcomeUnknown: true, details: { workflowDisposition: 'skipped' } } })
    await expect(agent('unknown', { client, cwd: '.' })).rejects.toMatchObject({ code: 'RATE_LIMITED', outcomeUnknown: true })
  }
  const { client } = await terminalFixture('interrupted')
  await expect(agent('interrupted', { client, cwd: '.' })).rejects.toMatchObject({ code: 'AGENT_INTERRUPTED' })
})

test('explicit skip metadata survives terminal-before-reply and startup denial requires its dedicated code', async () => {
  const skipped = await terminalFixture('interrupted', { error: { code: 'USER_SKIPPED', message: 'skipped', retryable: false, outcomeUnknown: false, details: { workflowDisposition: 'skipped' } } })
  expect(await agent('skip', { client: skipped.client, cwd: '.' })).toBeNull()
  expect([...skipped.adapter.backends.values()][0]?.disposeCount).toBe(1)
  const blocked = await fixture({ onOpen: async () => { throw new HarnessSdkError('AGENT_STARTUP_BLOCKED', 'blocked', false, false, { workflowDisposition: 'startup_blocked' }) } })
  expect(await agent('blocked', { client: blocked.client, cwd: '.' })).toBeNull()
  expect(blocked.adapter.calls).toHaveLength(0)
  const denied = await terminalFixture('failed', { error: { code: 'PERMISSION_DENIED', message: 'denied', retryable: false, outcomeUnknown: false, details: { workflowDisposition: 'startup_blocked' } } })
  await expect(agent('denied', { client: denied.client, cwd: '.' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
})

test('a null candidate cannot hide cleanup failure', async () => {
  const { client, adapter } = await fixture({ execute: async (call, sink) => {
    if (call.method === 'session/close') throw new HarnessSdkError('CLOSE_FAILED')
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: { code: 'RATE_LIMITED', message: 'rate limit', retryable: true, outcomeUnknown: false } } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  await expect(agent('rate limited', { client, cwd: '.' })).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED', details: { droppedError: { code: 'RATE_LIMITED' } } })
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test.each(['', 'bad JSON', '{}', '{"count":"3"}'])('invalid structured terminal %j rejects, cleans up and never replays', async text => {
  const { client, adapter } = await terminalFixture('completed', { text })
  await expect(agent('structured', { client, cwd: '.', schema: z.object({ count: z.number() }) })).rejects.toMatchObject({ outcomeUnknown: false, retryable: false })
  expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1)
  expect(adapter.calls.some(call => call.method === 'session/interrupt' || call.method === 'turn/interrupt')).toBe(false)
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('empty text and multiple final text items retain SDK aggregation', async () => {
  const empty = await terminalFixture('completed', { text: '' })
  expect(await agent('empty', { client: empty.client, cwd: '.' })).toBe('')
  const { client } = await fixture({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    for (const text of ['first', 'last']) await sink.emit({ type: 'item/completed', payload: { item: { id: text, type: 'agentMessage', phase: 'final', text } } }, { turnId })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } })
  expect(await agent('two', { client, cwd: '.' })).toBe('first\nlast')
})

// Compiled by package typecheck; never invoke real clients from type assertions.
function agentTypes(client: Client, dynamic: AgentOptions<z.ZodObject<{ count: z.ZodNumber }>>) {
  const base = { client, cwd: '.' }
  const schema = z.object({ count: z.number() })
  const text: Promise<string | null> = agent('text', base)
  const explicitUndefined: Promise<string | null> = agent('text', { ...base, schema: undefined })
  const value: Promise<{ count: number } | null> = agent('value', { ...base, schema })
  const inline: Promise<{ issues: string[] } | null> = agent('inline', { ...base, schema: z.object({ issues: z.array(z.string()) }) })
  const maybe: Promise<string | { count: number } | null> = agent('dynamic', dynamic)
  // @ts-expect-error Null must be handled.
  const unsafeText: Promise<string> = agent('text', base)
  // @ts-expect-error Schema output is numeric, not a string.
  const wrong: Promise<{ count: string } | null> = agent('value', { ...base, schema })
  // @ts-expect-error Raw JSON Schema is not a workflow schema.
  agent('raw', { ...base, schema: { type: 'object' } })
  // @ts-expect-error A business type cannot replace the schema type parameter.
  agent<{ count: number }>('unbound', { ...base, schema })
  // @ts-expect-error Object roots are required.
  agent('string', { ...base, schema: z.string() })
  void [text, explicitUndefined, value, inline, maybe, unsafeText, wrong]
}
void agentTypes
