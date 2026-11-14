import { expect, test } from 'bun:test'
import { InMemorySessionStore, type Options, type SDKMessage, type SDKUserMessage, type SessionStore, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { BoundedEventQueue, createClient } from '@anureo/sdk'
import type { AhpEvent, JsonSchema, SessionOpenParams } from '@anureo/protocol'
import { createClaudeAdapter, type ClaudeAdapterOptions, type ClaudeQuery } from './index'

const ANSWER = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false }
const LABEL = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }
/** Observe expected admission failures immediately while retaining the original promise for assertions. */
const observe = <T>(promise: Promise<T>) => { void promise.catch(() => {}); return promise }
/** Hold native cleanup/configuration at an explicit boundary until the test releases it. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Drive real adapter/client lifecycles through a scripted streaming query factory.
 * Query creation order is observable independently of turns; tests control native input consumption
 * and terminal results. The caller must await dispose to release the event reader and client. */
async function fixture(options: ClaudeAdapterOptions = {}, open?: Partial<SessionOpenParams>) {
  // Query indices follow creation order from zero, not execution count; equal schemas reuse a Query.
  const queries: Array<{ query: ClaudeQuery; output: BoundedEventQueue<SDKMessage>; input: AsyncIterator<SDKUserMessage>; options: Options; closes: number; returns: number }> = []
  const created: Array<() => void> = []
  const adapter = createClaudeAdapter({ ...options, queryFactory: ({ prompt, options }) => {
      if (typeof prompt === 'string') throw new Error('Expected streaming input')
      const state = { output: new BoundedEventQueue<SDKMessage>(), input: prompt[Symbol.asyncIterator](), options: options ?? {}, closes: 0, returns: 0 }
      const query: ClaudeQuery = {
        [Symbol.asyncIterator]: () => state.output[Symbol.asyncIterator](),
        close() { state.closes++; state.output.end() },
        async interrupt() { return undefined }, async setModel() {}, async setPermissionMode() {}, async setMaxThinkingTokens() {}, async applyFlagSettings() {},
        async rewindFiles() { return { canRewind: true } }, async supportedModels() { return [] },
      }
      Object.assign(query, { async return() { state.returns++; return { done: true, value: undefined } } })
      queries.push(Object.assign(state, { query }))
      for (const done of created.splice(0)) done()
      return query
    } })
  const client = await createClient({
    adapter,
    identity: { adapterId: 'claude', runtimeConfigId: 'schema' },
  })
  const session = await client.sessions.create({ cwd: process.cwd(), ...open })
  const events: AhpEvent[] = []
  const reader = session.events()[Symbol.asyncIterator]()
  // Event failures belong to operation assertions; keep the collector awaitable during disposal.
  const reading = (async () => { try { for (;;) { const next = await reader.next(); if (next.done) break; events.push(next.value) } } catch {} })()
  /** Wait for native query creation, including replacements admitted after asynchronous cleanup. */
  async function waitForQuery(queryIndex: number) {
    while (!queries[queryIndex]) await new Promise<void>(resolve => created.push(resolve))
    return queries[queryIndex]!
  }
  /** Consume one dispatched native input, failing if the scripted query has already ended. */
  async function input(queryIndex: number) {
    const next = await (await waitForQuery(queryIndex)).input.next()
    if (next.done) throw new Error('Expected an input')
    return next.value
  }
  const send = (queryIndex: number, value: Record<string, unknown>) => queries[queryIndex]!.output.write(value as unknown as SDKMessage)
  /** Echo consumed input UUIDs so the real adapter can associate and finish their execution. */
  const result = (queryIndex: number, ids: string[], extra: Record<string, unknown> = {}) => send(queryIndex, {
    type: 'result', subtype: 'success', is_error: false, result: 'Do not parse this prose', num_turns: 1, stop_reason: 'end_turn',
    user_message_uuids: ids, user_message_uuid: ids.at(-1), usage: { input_tokens: 7, output_tokens: 9 }, ...extra,
  })
  return {
    client, adapter, session, queries, events, waitForQuery, input, send, result,
    /** Submit, consume and finish one execution, awaiting both dispatch association and terminal output. */
    async execute(schema: JsonSchema | undefined, queryIndex: number, extra: Record<string, unknown> = {}) {
      const pending = observe(session.submit({ input: 'task', ...(schema !== undefined ? { outputSchema: schema } : {}) }))
      const user = await input(queryIndex)
      await result(queryIndex, [user.uuid!], extra)
      const turn = await pending
      return { turn, result: await turn.result(), user }
    },
    /** Stop collection before disposing the client; propagate resource-release failures to the test. */
    async dispose() { await reader.return?.(); await reading; await client.dispose() },
  }
}

test('outputSchema uses native options, returns only validated JSON, and switches A → B → text on one native session', async () => {
  const f = await fixture({}, { model: 'initial', instructions: 'keep instructions', mcpServers: [{ name: 'tools', type: 'stdio', command: 'fixture-tool' }], config: { effort: 'high', fastMode: true, maxThinkingTokens: 80 } })
  const answerQueryIndex = 1, labelQueryIndex = 2, textQueryIndex = 3
  try {
    const nativeId = f.session.binding.nativeRef!.value
    await f.session.request('session/config/set', { requestId: 'model', sessionId: f.session.id, patch: { model: 'updated', permissionMode: 'plan' } })
    const first = await f.execute(ANSWER, answerQueryIndex, { structured_output: { answer: 42 } })
    expect(first.result).toMatchObject({ status: 'completed', text: '{"answer":42}', usage: { input: 7, output: 9 } })
    expect(first.result.items.filter(item => item.type === 'agentMessage' && item.phase === 'final')).toHaveLength(1)
    expect(f.queries[answerQueryIndex]!.options).toMatchObject({
      sessionId: nativeId, model: 'updated', permissionMode: 'plan', systemPrompt: 'keep instructions', effort: 'high', settings: { fastMode: true }, maxThinkingTokens: 80,
      outputFormat: { type: 'json_schema', schema: ANSWER }, mcpServers: { tools: { type: 'stdio', command: 'fixture-tool' } },
    })
    const reordered = { additionalProperties: false, required: ['answer'], properties: { answer: { type: 'integer' } }, type: 'object' }
    await f.execute(reordered, answerQueryIndex, { structured_output: { answer: 43 } })
    expect(f.queries).toHaveLength(2)
    const second = await f.execute(LABEL, labelQueryIndex, { structured_output: { label: 'ok' } })
    expect(second.result.text).toBe('{"label":"ok"}')
    expect(second.turn.id).not.toBe(first.turn.id)
    expect(f.queries[labelQueryIndex]!.options.resume).toBe(nativeId)
    expect(f.queries[labelQueryIndex]!.options.sessionId).toBeUndefined()
    expect(f.queries[labelQueryIndex]!.options.outputFormat).toEqual({ type: 'json_schema', schema: LABEL })
    const plain = await f.execute(undefined, textQueryIndex, { result: 'plain text', structured_output: { label: 'stale field is ignored' } })
    expect(plain.result.text).toBe('plain text')
    expect(f.queries[textQueryIndex]!.options.resume).toBe(nativeId)
    expect(f.queries[textQueryIndex]!.options.outputFormat).toBeUndefined()
    expect(f.session.binding.nativeRef!.value).toBe(nativeId)
    for (const query of f.queries.slice(0, 3)) expect([query.closes, query.returns]).toEqual([1, 1])
  } finally { await f.dispose() }
  expect(f.queries.map(query => [query.closes, query.returns])).toEqual([[1, 1], [1, 1], [1, 1], [1, 1]])
})

test('terminal API failures use only the latest main-assistant category and native result fields', async () => {
  const f = await fixture()
  try {
    for (const [latest, code] of [['rate_limit', 'RATE_LIMITED'], [undefined, 'CLAUDE_TURN_FAILED']] as const) {
      const pending = f.session.submit({ input: 'api failure' })
      const user = await f.input(0)
      const send = (id: string, error?: string, parent: string | null = null) => f.send(0, {
        type: 'assistant', user_message_uuids: [user.uuid], parent_tool_use_id: parent, error,
        message: { id, content: [{ type: 'text', text: 'private API prose' }] },
      })
      await send('earlier', 'authentication_failed')
      await send('latest', latest)
      await send('child', 'billing_error', 'nested-tool')
      await f.result(0, [user.uuid!], { is_error: true })
      const turn = await pending
      expect(await turn.result()).toMatchObject({ status: 'failed', error: { code, outcomeUnknown: false } })
    }
    const nativeStatus = await f.execute(undefined, 0, { is_error: true, api_error_status: 401 })
    expect(nativeStatus.result).toMatchObject({ status: 'failed', error: { code: 'AUTH_REQUIRED' } })
    const limit = await f.execute(undefined, 0, { subtype: 'error_max_turns', is_error: true })
    expect(limit.result).toMatchObject({ status: 'failed', error: { code: 'CLAUDE_MAX_TURNS_EXCEEDED' } })
  } finally { await f.dispose() }
})

test('pending and active inputs forbid changing or clearing schema, while equal-schema inputs may share an execution', async () => {
  const f = await fixture()
  const answerQueryIndex = 1
  try {
    const pending = observe(f.session.submit({ input: 'first', outputSchema: ANSWER }))
    const first = await f.input(answerQueryIndex)
    await expect(f.session.submit({ input: 'different', outputSchema: LABEL })).rejects.toMatchObject({ code: 'SESSION_BUSY', outcomeUnknown: false })
    await f.send(answerQueryIndex, { type: 'assistant', user_message_uuids: [first.uuid], parent_tool_use_id: null, message: { id: 'work', content: [{ type: 'text', text: 'Working prose' }] } })
    const turn = await pending
    await expect(f.session.submit({ input: 'clear' })).rejects.toMatchObject({ code: 'SESSION_BUSY', outcomeUnknown: false })
    const joined = observe(f.session.submit({ input: 'focus', delivery: 'afterTurn', outputSchema: structuredClone(ANSWER) }))
    const second = await f.input(answerQueryIndex)
    expect(second.priority).toBe('later')
    await f.result(answerQueryIndex, [first.uuid!, second.uuid!], { structured_output: { answer: 2 } })
    const joinedTurn = await joined
    expect(joinedTurn.id).toBe(turn.id)
    expect((await turn.result()).text).toBe('{"answer":2}')
    expect((await joinedTurn.result()).text).toBe('{"answer":2}')
    expect(f.queries).toHaveLength(2)
    const final = (await turn.result()).items.filter(item => item.type === 'agentMessage' && item.phase === 'final')
    expect(final).toHaveLength(1)
    expect(final[0]).toMatchObject({ text: '{"answer":2}' })
  } finally { await f.dispose() }
})

test('ordinary pending input reserves admission before a racing schema submission', async () => {
  const f = await fixture()
  try {
    const plain = observe(f.session.submit({ input: 'plain' }))
    await expect(f.session.submit({ input: 'schema', outputSchema: ANSWER })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    const user = await f.input(0)
    await f.result(0, [user.uuid!], { result: 'ordinary result' })
    expect((await (await plain).result()).text).toBe('ordinary result')
    expect(f.queries).toHaveLength(1)
  } finally { await f.dispose() }
})

test('invalid and unsupported schemas fail before replacing a Query or dispatching input', async () => {
  const f = await fixture()
  const initialQueryIndex = 0, answerQueryIndex = 1
  try {
    const rejectedSchemas: Array<{ name: string; outputSchema: JsonSchema }> = [
      { name: 'boolean schema instead of an object root', outputSchema: false },
      { name: 'array root instead of an object root', outputSchema: { type: 'array' } },
      { name: 'asynchronous validation', outputSchema: { type: 'object', $async: true } },
      { name: 'invalid property type', outputSchema: { type: 'object', properties: { x: { type: 'bogus' } } } },
      { name: 'unsupported draft 2020-12', outputSchema: { type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema' } },
      { name: 'external schema reference', outputSchema: { type: 'object', properties: { x: { $ref: 'https://private.invalid/schema' } } } },
    ]
    for (const { name, outputSchema } of rejectedSchemas) {
      await expect(f.session.submit({ input: 'invalid', outputSchema }), name).rejects.toMatchObject({ code: 'INVALID_PARAMS', outcomeUnknown: false })
    }
    await expect(f.session.submit({ input: [{ type: 'image', data: 'bmp', mimeType: 'image/bmp' }], outputSchema: ANSWER })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', outcomeUnknown: false })
    expect(f.queries).toHaveLength(1)
    expect(f.queries[initialQueryIndex]!.closes).toBe(0)
    const next = await f.execute({ ...ANSWER, $schema: 'http://json-schema.org/draft-07/schema#' }, answerQueryIndex, { structured_output: { answer: 1 } })
    expect(next.result.status).toBe('completed')
  } finally { await f.dispose() }
})

test('missing output, invalid output, retry exhaustion and interruption preserve distinct terminal outcomes without replay', async () => {
  const f = await fixture()
  const answerQueryIndex = 1
  try {
    for (const [extra, code] of [
      [{}, 'CLAUDE_STRUCTURED_OUTPUT_MISSING'],
      [{ structured_output: { answer: 'wrong type' } }, 'CLAUDE_STRUCTURED_OUTPUT_INVALID'],
      [{ subtype: 'error_max_structured_output_retries', is_error: true, errors: ['private provider text'] }, 'CLAUDE_STRUCTURED_OUTPUT_RETRIES_EXCEEDED'],
    ] as const) {
      const run = await f.execute(ANSWER, answerQueryIndex, extra)
      expect(run.result).toMatchObject({ status: 'failed', text: '', error: { code, retryable: false, outcomeUnknown: false } })
      expect(JSON.stringify(run.result)).not.toContain('private provider text')
    }
    const interrupted = await f.execute(ANSWER, answerQueryIndex, { stop_reason: 'interrupted', is_error: true })
    expect(interrupted.result.status).toBe('interrupted')
    expect(f.events.filter(event => event.type === 'submission/status' && event.payload.status === 'dispatched')).toHaveLength(4)
    expect(f.queries).toHaveLength(2)
  } finally { await f.dispose() }
})

test('switch admission spans asynchronous Query cleanup and rejects competing input, config and revert', async () => {
  const entered = deferred(), release = deferred(), f = await fixture({ sessionStore: new InMemorySessionStore() })
  const initialQueryIndex = 0, answerQueryIndex = 1
  try {
    Object.assign(f.queries[initialQueryIndex]!.query, { async return() { f.queries[initialQueryIndex]!.returns++; entered.resolve(); await release.promise; return { done: true, value: undefined } } })
    const pending = observe(f.session.submit({ input: 'switch', outputSchema: ANSWER }))
    await entered.promise
    await expect(f.session.submit({ input: 'competing', outputSchema: LABEL })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await expect(f.session.request('session/config/set', { requestId: 'config', sessionId: f.session.id, patch: { model: 'other' } })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await expect(f.session.request('session/revert', { requestId: 'revert', sessionId: f.session.id, scope: 'conversation', boundary: { turnId: 'old', relation: 'before' } })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    release.resolve()
    const user = await f.input(answerQueryIndex)
    await f.result(answerQueryIndex, [user.uuid!], { structured_output: { answer: 9 } })
    expect((await (await pending).result()).text).toBe('{"answer":9}')
  } finally { release.resolve(); await f.dispose() }
})

test('configuration in progress prevents switching and completed settings survive the replacement', async () => {
  const entered = deferred(), release = deferred(), f = await fixture()
  const initialQueryIndex = 0, answerQueryIndex = 1
  try {
    f.queries[initialQueryIndex]!.query.setModel = async () => { entered.resolve(); await release.promise }
    const configuring = f.session.request('session/config/set', { requestId: 'config', sessionId: f.session.id, patch: { model: 'later-model', fastMode: false } })
    await entered.promise
    await expect(f.session.submit({ input: 'schema', outputSchema: ANSWER })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    release.resolve(); await configuring
    await f.execute(ANSWER, answerQueryIndex, { structured_output: { answer: 1 } })
    expect(f.queries[answerQueryIndex]!.options.model).toBe('later-model')
    expect(f.queries[answerQueryIndex]!.options.settings).toEqual({ fastMode: false })
  } finally { release.resolve(); await f.dispose() }
})

test('close during cleanup never starts a replacement Query or dispatches input', async () => {
  const entered = deferred(), release = deferred(), f = await fixture()
  const initialQueryIndex = 0
  try {
    Object.assign(f.queries[initialQueryIndex]!.query, { async return() { f.queries[initialQueryIndex]!.returns++; entered.resolve(); await release.promise; return { done: true, value: undefined } } })
    const pending = observe(f.session.submit({ input: 'switch', outputSchema: ANSWER }))
    await entered.promise
    const closing = f.session.close()
    release.resolve(); await closing
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    expect(f.queries).toHaveLength(1)
    expect([f.queries[initialQueryIndex]!.closes, f.queries[initialQueryIndex]!.returns]).toEqual([1, 1])
    expect(f.events.some(event => event.type === 'turn/started')).toBe(false)
  } finally { release.resolve(); await f.dispose() }
})

test('cleanup failure does not dispatch, repeat cleanup or silently recover by replay', async () => {
  const f = await fixture()
  const initialQueryIndex = 0
  const query = f.queries[initialQueryIndex]!
  Object.assign(query.query, { async return() { query.returns++; throw new Error('private cleanup error') } })
  await expect(f.session.submit({ input: 'switch', outputSchema: ANSWER })).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED', outcomeUnknown: false })
  await expect(f.session.submit({ input: 'retry' })).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED', outcomeUnknown: false })
  expect(f.queries).toHaveLength(1)
  expect([query.closes, query.returns]).toEqual([1, 1])
  await expect(f.dispose()).rejects.toMatchObject({ code: 'RESOURCE_RELEASE_FAILED' })
  expect([query.closes, query.returns]).toEqual([1, 1])
})

test('replacement startup failure is certain before dispatch and still permits closing the session', async () => {
  const f = await fixture()
  const initialQueryIndex = 0
  try {
    f.adapter.options.queryFactory = () => { throw new Error('private startup failure') }
    await expect(f.session.submit({ input: 'switch', outputSchema: ANSWER })).rejects.toMatchObject({ code: 'CLAUDE_OUTPUT_FORMAT_FAILED', outcomeUnknown: false })
    await expect(f.session.submit({ input: 'do not replay' })).rejects.toMatchObject({ code: 'CLAUDE_OUTPUT_FORMAT_FAILED', outcomeUnknown: false })
    expect(f.events.some(event => event.type === 'turn/started')).toBe(false)
    expect(f.queries).toHaveLength(1)
    await f.session.close()
    expect([f.queries[initialQueryIndex]!.closes, f.queries[initialQueryIndex]!.returns]).toEqual([1, 1])
  } finally { await f.dispose() }
})

test('official history, resume and fork helpers retain validated structured output and ignore unrelated attachments', async () => {
  const transcripts = new Map<string, SessionStoreEntry[]>()
  const store: SessionStore = {
    load: async key => structuredClone(transcripts.get(key.sessionId) ?? null),
    append: async (key, entries) => { transcripts.set(key.sessionId, [...transcripts.get(key.sessionId) ?? [], ...structuredClone(entries)]) },
  }
  const f = await fixture({ sessionStore: store })
  const answerQueryIndex = 1
  try {
    const nativeId = f.session.binding.nativeRef!.value
    const pending = observe(f.session.submit({ input: 'structured', outputSchema: ANSWER }))
    const user = await f.input(answerQueryIndex)
    const tool = randomUUID(), reply = randomUUID(), toolResult = randomUUID(), attachment = randomUUID()
    const blocks = [{ type: 'text', text: 'Working prose' }, { type: 'tool_use', id: tool, name: 'StructuredOutput', input: { answer: 42 } }]
    transcripts.set(nativeId, [
      { type: 'user', uuid: user.uuid!, parentUuid: null, sessionId: nativeId, message: user.message, isSidechain: false },
      { type: 'assistant', uuid: reply, parentUuid: user.uuid, sessionId: nativeId, message: { id: reply, role: 'assistant', content: blocks }, isSidechain: false },
      { type: 'user', uuid: toolResult, parentUuid: reply, sessionId: nativeId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'ok' }] }, isSidechain: false },
      { type: 'attachment', uuid: attachment, parentUuid: toolResult, sessionId: nativeId, attachment: { type: 'structured_output', toolUseID: tool, data: { answer: 42 } } },
      { type: 'attachment', uuid: randomUUID(), parentUuid: attachment, sessionId: nativeId, attachment: { type: 'structured_output', toolUseID: 'retracted-tool', data: { answer: 999 } } },
    ])
    await f.send(answerQueryIndex, { type: 'assistant', user_message_uuids: [user.uuid], parent_tool_use_id: null, message: { id: reply, content: blocks } })
    await f.result(answerQueryIndex, [user.uuid!], { structured_output: { answer: 42 } })
    const turn = await pending, live = await turn.result()
    const history = await f.session.request('history/read', { requestId: 'history', sessionId: f.session.id })
    const finals = history.items.filter(entry => entry.item.type === 'agentMessage' && entry.item.phase === 'final')
    expect(finals.map(entry => entry.item)).toEqual(live.items.filter(item => item.type === 'agentMessage' && item.phase === 'final'))
    expect(finals[0]!.nativeItemId).toBe(attachment)
    const fork = await f.client.sessions.fork({ binding: f.session.binding, cwd: process.cwd() }, { boundary: { turnId: turn.id, relation: 'through' } })
    const forked = await fork.request('history/read', { requestId: 'forked', sessionId: fork.id })
    // The official fork helper remints prompt UUIDs; inherited native turn IDs
    // may differ, while the validated JSON must survive unchanged.
    expect(forked.items.filter(entry => entry.item.type === 'agentMessage' && entry.item.phase === 'final').map(entry => entry.item.type === 'agentMessage' ? entry.item.text : '')).toEqual(['{"answer":42}'])
    await fork.close()
    const binding = f.session.binding
    await f.session.close()
    const resumed = await f.client.sessions.resume({ binding, cwd: process.cwd() })
    const restored = await resumed.request('history/read', { requestId: 'restored', sessionId: resumed.id })
    expect(restored.items.filter(entry => entry.item.type === 'agentMessage' && entry.item.phase === 'final').map(entry => entry.item)).toEqual(finals.map(entry => entry.item))
    await resumed.close()
  } finally { await f.dispose() }
})

test('the pinned official SDK sends schema on initialize and resumes the same native session across format changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-claude-schema-'))
  const log = join(directory, 'initialize.jsonl')
  const client = await createClient({
    adapter: createClaudeAdapter({ command: fileURLToPath(new URL('../tests/fixtures/fake-claude.mjs', import.meta.url)), executableRuntime: 'node', stateDir: join(directory, 'state'), env: { FAKE_SCHEMA_PROBE: '1', FAKE_SCHEMA_LOG: log } }),
    identity: { adapterId: 'claude', runtimeConfigId: 'schema-transport' },
  })
  try {
    const session = await client.sessions.create({ cwd: directory })
    const nativeId = session.binding.nativeRef!.value
    const a = await session.submit({ input: 'schema A', outputSchema: ANSWER }, { timeoutMs: 5000 })
    expect((await a.result({ timeoutMs: 5000 })).text).toBe('{"answer":42}')
    const schemaB = { ...ANSWER, properties: { answer: { type: 'integer', const: 7 } } }
    const b = await session.submit({ input: 'schema B', outputSchema: schemaB }, { timeoutMs: 5000 })
    expect((await b.result({ timeoutMs: 5000 })).text).toBe('{"answer":7}')
    const plain = await session.submit({ input: 'plain' }, { timeoutMs: 5000 })
    expect((await plain.result({ timeoutMs: 5000 })).text).toBe('external executable probe passed')
    await session.close()
    const initialized = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(initialized.map(entry => entry.schema ?? null)).toEqual([null, ANSWER, schemaB, null])
    expect(initialized.map(entry => entry.sessionId)).toEqual([nativeId, nativeId, nativeId, nativeId])
    expect(initialized.slice(2).map(entry => entry.resume)).toEqual([nativeId, nativeId])
  } finally {
    await client.dispose()
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 15_000)
