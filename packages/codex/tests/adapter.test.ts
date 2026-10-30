import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHarnessRuntime, type HarnessRuntime } from '@anureo/sdk'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { type AhpEvent, type InteractionResponse, type JsonObject } from '@anureo/protocol'
import { createCodexAdapter, codexCapabilities, mapItems, mapUsage, resolveCodexProfile, type CodexAdapterOptions } from '../src'
import { rejectionOf } from '../../../scripts/harness-sdk/test-helpers'

const resources: HarnessRuntime[] = []; const dirs: string[] = []
afterEach(async () => { await Promise.all(resources.splice(0).map(runtime => runtime.dispose())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup(mode = 'normal', version = '0.164.0', timeoutMs = 1000, config?: JsonObject, model?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex adapter ')); dirs.push(dir)
  const log = path.join(dir, 'calls.jsonl')
  // Bootstrap is not the operation under timeout test; Windows process startup may exceed 100ms.
  const adapter = createCodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))], version, env: { ...process.env, FAKE_SCENARIO: mode, FAKE_LOG_FILE: log }, timeoutMs: Math.max(1000, timeoutMs) })
  const runtime = createHarnessRuntime(adapter); resources.push(runtime)
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' }, clientCapabilities: { interactions: ['approval','userInput','elicitation','dynamicTool'] } })
  const session = await runtime.openSession({ requestId: 'open', mode: 'new', binding: { sessionId: 'session', adapterId: 'codex', runtimeConfigId: 'codex-test' }, cwd: dir, config, ...(model ? { model } : {}) })
  adapter.options.timeoutMs = timeoutMs
  const events: AhpEvent[] = []; const listeners = new Set<() => void>()
  const consume = (async () => { try { for await (const event of session.events()) { events.push(event); for (const listener of [...listeners]) listener() } } catch {} })()
  const waitFor = (condition: () => boolean) => new Promise<void>((resolve, reject) => {
    if (condition()) { resolve(); return }
    const done = () => { if (condition()) { clearTimeout(timer); listeners.delete(done); resolve() } }
    const timer = setTimeout(() => { listeners.delete(done); reject(new Error('Event timeout')) }, 2000); listeners.add(done)
  })
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown>; id?: string|number; result?: unknown; error?: unknown })
  return { adapter, runtime, session, events, waitFor, calls, consume, dir }
}
const start = { requestId: 'start', sessionId: 'session', turnId: 'canonical', input: [{ type: 'text' as const, text: 'hello' }] }

test('retains image provenance and distinguishes generated output from viewed inputs', () => {
  expect(mapItems({ id: 'g', type: 'imageGeneration', result: 'base64-data', savedPath: '/tmp/g.png', revisedPrompt: 'A tree' }, true)[0]).toMatchObject({
    type: 'toolCall', kind: 'image', image: { kind: 'generated', data: 'base64-data', path: '/tmp/g.png', revisedPrompt: 'A tree' },
  })
  expect(mapItems({ id: 'g', type: 'imageGeneration', result: '', fileId: 'attachment' }, true)[0]).toMatchObject({ image: { kind: 'generated', fileId: 'attachment' } })
  expect(mapItems({ id: 'v', type: 'imageView', path: '/tmp/input.png' }, true)[0]).toMatchObject({ image: { kind: 'view', path: '/tmp/input.png' } })
})

describe('Codex permission controls', () => {
  const modes = [
    ['read-only', 'on-request', 'read-only', 'readOnly'],
    ['agent', 'on-request', 'workspace-write', 'workspaceWrite'],
    ['agent-full-access', 'never', 'danger-full-access', 'dangerFullAccess'],
  ] as const
  for (const version of ['0.148.0', '0.164.0']) for (const [mode, approvalPolicy, sandbox, type] of modes) {
    test(`${version} applies draft ${mode} to thread and subsequent turns`, async () => {
      const s = await setup('normal', version, 1000, { permissionMode: mode })
      await s.session.startTurn(start)
      const calls = await s.calls()
      expect(codexCapabilities(version).config?.options.find(option => option.id === 'permissionMode')?.schema).toMatchObject({ enum: ['read-only', 'agent', 'agent-full-access'] })
      expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ approvalPolicy, sandbox, config: { sandbox_mode: sandbox, approval_policy: approvalPolicy } })
      expect(calls.find(call => call.method === 'thread/start')?.params?.config).not.toHaveProperty('permissionMode')
      expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ approvalPolicy, sandboxPolicy: { type } })
    })
    test(`${version} applies session ${mode} to native settings and the next turn`, async () => {
      const s = await setup('normal', version)
      const state = await s.session.setConfig({ requestId: 'permissions', sessionId: 'session', patch: { permissionMode: mode } })
      expect(state.config.permissionMode).toBe(mode)
      await s.session.startTurn(start)
      const calls = await s.calls()
      if (version === '0.164.0') {
        const update = calls.find(call => call.method === 'thread/settings/update')?.params
        expect(update).toMatchObject({ approvalPolicy, sandboxPolicy: { type } })
        expect(update).not.toHaveProperty('permissionMode')
      } else expect(calls.some(call => call.method === 'thread/settings/update')).toBe(false)
      expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ approvalPolicy, sandboxPolicy: { type } })
    })
  }
})

describe('Codex native lifecycle', () => {
  test('retains native start anchors through deltas, repeated starts, completion and reused IDs', async () => {
    const s = await setup('timing')
    for (const [turnId, startedAt] of [['canonical', '2026-10-28T01:00:03.000Z'], ['second', '2026-10-28T01:01:03.000Z']] as const) {
      await s.session.startTurn({ ...start, requestId: `start-${turnId}`, turnId })
      await s.waitFor(() => s.events.some(event => event.turnId === turnId && event.type === 'item/delta' && event.payload.kind === 'patch'))
      const started = s.events.find(event => event.turnId === turnId && event.type === 'item/started')!
      expect(started.type === 'item/started' && started.payload.item.startedAt).toBe(startedAt)
      const patched = s.events.find(event => event.turnId === turnId && event.type === 'item/delta' && event.payload.kind === 'patch')!
      expect(patched.type === 'item/delta' && patched.payload.value).toMatchObject({ startedAt, text: 'Repeated start' })
      await s.session.steer({ requestId: `finish-${turnId}`, sessionId: 'session', expectedTurnId: turnId, input: [{ type: 'text', text: 'Finish' }] })
      await s.waitFor(() => s.events.some(event => event.turnId === turnId && event.type === 'turn/completed'))
      const completed = s.events.find(event => event.turnId === turnId && event.type === 'item/completed')!
      expect(completed.type === 'item/completed' && completed.payload.item).toMatchObject({ startedAt, status: 'completed', text: 'authoritative final' })
    }
  })

  test('reads start anchors from paginated native history entries', async () => {
    const s = await setup('timing')
    const first = await s.session.readHistory({ requestId: 'timed-history', sessionId: 'session', limit: 1 })
    const second = await s.session.readHistory({ requestId: 'timed-history-next', sessionId: 'session', cursor: first.nextCursor!, snapshotToken: first.snapshotToken })
    expect(first.items[0]?.item).toMatchObject({ id: 'reused', text: 'one', startedAt: '2026-10-28T01:00:03.000Z' })
    expect(second.items[0]?.item).toMatchObject({ id: 'reused', text: 'two', startedAt: '2026-10-28T01:01:03.000Z' })
  })

  test('omits missing or invalid native timestamps without inventing an anchor', () => {
    const raw = { id: 'answer', type: 'agentMessage', text: 'Done' }
    for (const startedAtMs of [undefined, null, '123', -1, NaN, Infinity, Number.MAX_VALUE]) {
      expect(mapItems(raw, true, false, { startedAtMs })[0]).not.toHaveProperty('startedAt')
    }
    expect(mapItems(raw, true, false, { startedAtMs: 0 })[0]?.startedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(mapItems({ ...raw, startedAtMs: 1000 }, true, true)[0]?.startedAt).toBe('1970-01-01T00:00:01.000Z')
  })

  test('maps response-before/after events, full items, usage, plans, subagents and unknown messages', async () => {
    const s = await setup(); expect(await s.session.startTurn(start)).toEqual({ turnId: 'canonical', accepted: true })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect(s.events.filter(event => event.type === 'turn/started')).toHaveLength(1)
    const started = s.events.find(event => event.type === 'turn/started')!
    expect(started.payload).toEqual({ turnId: 'canonical', nativeTurnId: 'native-turn-1' })
    const final = s.events.find(event => event.type === 'item/completed' && event.payload.item.type === 'agentMessage')!
    expect(final.type === 'item/completed' && final.payload.item.type === 'agentMessage' && final.payload.item.text).toBe('authoritative final')
    expect(s.events.some(event => event.type === 'item/delta' && event.payload.text === 'hello 日本語')).toBe(true)
    const children = s.events.filter(event => event.type === 'item/completed' && event.payload.item.type === 'subagent')
    expect(children).toHaveLength(2)
    const terminal = s.events.find(event => event.type === 'turn/completed')!
    expect(terminal.type === 'turn/completed' && terminal.payload.usage?.total).toBe(12)
    const unknown = s.events.find(event => event.type === 'notice' && event.payload.message === 'future/newNotification')!
    expect(JSON.stringify(unknown)).not.toContain('never-public')
    expect(JSON.stringify(unknown)).toContain('retained')
    expect((await s.calls()).every(call => !Object.hasOwn(call, 'jsonrpc'))).toBe(true)
    expect(s.events.every((event, index) => event.seq === index + 1)).toBe(true)
  })
  test('steer uses the same native turn and explicit interrupt finishes it', async () => {
    const s = await setup('hold'); await s.session.startTurn(start)
    expect(await rejectionOf(s.session.startTurn({ ...start, requestId: 'another', turnId: 'another' }))).toMatchObject({ code: 'SESSION_BUSY' })
    expect(await s.session.steer({ requestId: 'steer', sessionId: 'session', expectedTurnId: 'canonical', input: [{ type: 'text', text: 'adjust' }] })).toEqual({ turnId: 'canonical', accepted: true })
    await s.session.interrupt({ requestId: 'interrupt', sessionId: 'session', turnId: 'canonical' })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const call = (await s.calls()).find(call => call.method === 'turn/steer')!
    expect(call.params?.expectedTurnId).toBe('native-turn-1')
    expect(s.events.filter(event => event.type === 'turn/started')).toHaveLength(1)
  })
})

describe('independent account readiness', () => {
  test('missing account blocks dispatch and exposes only an actionable auth error', async () => {
    const s = await setup('auth-required')
    expect(await s.adapter.readAuthStatus()).toBe('required')
    expect(await rejectionOf(s.session.startTurn(start))).toMatchObject({ code: 'AUTH_REQUIRED', outcomeUnknown: false })
    expect((await s.calls()).some(call => call.method === 'turn/start')).toBe(false)
    expect(s.events.some(event => event.type === 'turn/started')).toBe(false)
  })
  for (const mode of ['auth-unavailable', 'auth-not-required']) test(`${mode} does not invent a requirement for native authentication`, async () => {
    const s = await setup(mode)
    expect(await s.adapter.readAuthStatus()).toBe(mode === 'auth-unavailable' ? 'unknown' : 'ready')
    await expect(s.session.startTurn(start)).resolves.toMatchObject({ accepted: true })
    expect((await s.calls()).filter(call => call.method === 'turn/start')).toHaveLength(1)
  })
  test('an account preflight timeout stays visible but cannot mark an undispatched turn unknown', async () => {
    const s = await setup('auth-timeout', '0.164.0', 100)
    expect(await rejectionOf(s.session.startTurn(start))).toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: false })
    expect((await s.calls()).some(call => call.method === 'turn/start')).toBe(false)
  })
  test('invalid account status is not treated as an anonymous provider', async () => {
    const s = await setup('auth-malformed')
    let failure: unknown; try { await s.session.startTurn(start) } catch (cause) { failure = cause }
    expect(failure).toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect((await s.calls()).some(call => call.method === 'turn/start')).toBe(false)
  })
  test('a mid-turn native unauthorized failure remains an auth error without leaking provider details', async () => {
    const s = await setup('auth-expired'); await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const terminal = s.events.find(event => event.type === 'turn/completed')!
    expect(terminal.type === 'turn/completed' && terminal.payload.error).toMatchObject({ code: 'AUTH_REQUIRED', outcomeUnknown: false })
    expect(JSON.stringify(s.events)).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC')
    expect(JSON.stringify(s.events)).not.toContain('token=private')
  })
})

describe('native interactions', () => {
  for (const [mode, response] of [
    ['approval', { kind: 'approval', optionId: 'decline' }],
    ['fileapproval', { kind: 'approval', optionId: 'decline' }],
    ['permission', { kind: 'approval', optionId: 'decline' }],
    ['questions', { kind: 'userInput', answers: { q: '0' } }],
    ['elicitation', { kind: 'elicitation', action: 'cancel' }],
    ['dynamic', { kind: 'dynamicTool', content: [{ type: 'text', text: 'tool output' }] }],
  ] as Array<[string, InteractionResponse]>) test(`${mode} keeps native request id and structured response`, async () => {
    const s = await setup(mode); await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'interaction/requested'))
    const request = s.events.find(event => event.type === 'interaction/requested')!
    if (request.type !== 'interaction/requested') throw new Error()
    await s.session.respond({ requestId: 'respond', sessionId: 'session', interactionId: request.payload.interactionId, response })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const calls = await s.calls(); const reply = calls.find(call => call.id === (mode === 'permission' ? 901 : 'server-request') && !call.method)
    expect(reply).toBeDefined()
    expect(s.events.filter(event => event.type === 'interaction/resolved')).toHaveLength(1)
    if (mode === 'approval') expect(reply?.result).toEqual({ decision: 'decline' })
    if (mode === 'permission') expect(reply?.result).toEqual({ permissions: {}, scope: 'turn' })
    if (mode === 'questions') expect(reply?.result).toEqual({ answers: { q: { answers: ['A'] } } })
  })
  test('unknown native request receives method-not-found, never approval', async () => {
    const s = await setup('unknown-request'); await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const reply = (await s.calls()).find(call => call.id === 'server-request' && !call.method)
    expect(reply?.error).toEqual({ code: -32601, message: 'Unsupported native request' })
    expect(s.events.some(event => event.type === 'interaction/requested')).toBe(false)
  })
})

describe('versioned controls and history', () => {
  test('retains the selected model in capability snapshots and subsequent configuration results', async () => {
    const s = await setup('no-history', '0.164.0', 1000, {}, 'initial-model')
    expect(await rejectionOf(s.session.readHistory({ requestId: 'history', sessionId: 'session' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await s.waitFor(() => s.events.some(event => event.type === 'session/state' && event.payload.capabilities.session?.history === false))
    expect(s.events.filter(event => event.type === 'session/state').every(event => event.type === 'session/state' && event.payload.model === 'initial-model')).toBe(true)
    expect((await s.session.setConfig({ requestId: 'model', sessionId: 'session', patch: { model: 'next-model' } })).model).toBe('next-model')
    expect((await s.session.setConfig({ requestId: 'speed', sessionId: 'session', patch: { fastMode: false } })).model).toBe('next-model')
    expect((await s.calls()).find(call => call.method === 'thread/start')?.params?.model).toBe('initial-model')
  })
  test('modern native history pages become a bounded stable snapshot', async () => {
    const s = await setup('hold')
    const one = await s.session.readHistory({ requestId: 'h1', sessionId: 'session', limit: 1 })
    expect(one.items).toHaveLength(1); expect(one.nextCursor).toBeTruthy()
    const two = await s.session.readHistory({ requestId: 'h2', sessionId: 'session', cursor: one.nextCursor!, snapshotToken: one.snapshotToken, limit: 1 })
    expect(two.items[0]?.nativeTurnId).toBe('native-turn-2'); expect(two.nextCursor).toBeNull()
    expect((await s.calls()).filter(call => call.method === 'thread/items/list')).toHaveLength(2)
    expect(await rejectionOf(s.session.readHistory({ requestId: 'badcursor', sessionId: 'session', cursor: 'bad' }))).toMatchObject({ code: 'CURSOR_INVALID' })
  })
  test('revokes an absent optional history method while keeping the new session usable for its first turn', async () => {
    const s = await setup('no-history')
    let failure: unknown; try { await s.session.readHistory({ requestId: 'history', sessionId: 'session' }) } catch (cause) { failure = cause }
    expect(failure).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', outcomeUnknown: false })
    expect(s.session.capabilities.session?.history).toBe(false)
    expect(await s.session.startTurn(start)).toEqual({ turnId: 'canonical', accepted: true })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect((await s.calls()).filter(call => call.method === 'turn/start')).toHaveLength(1)
    expect(await rejectionOf(s.session.readHistory({ requestId: 'history-again', sessionId: 'session' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect((await s.calls()).filter(call => call.method === 'thread/items/list')).toHaveLength(1)
  })
  test('legacy revert calculates rollback only from authoritative native turns', async () => {
    const s = await setup('hold', '0.148.0')
    expect(codexCapabilities('0.148.0').session?.fork).toEqual(['through'])
    await s.session.revert({ requestId: 'revert', sessionId: 'session', boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' }, scope: 'conversation' })
    const calls = await s.calls()
    expect(calls.find(call => call.method === 'thread/rollback')?.params).toEqual({ threadId: 'native-thread', numTurns: 2 })
    expect(calls.some(call => call.method === 'thread/revert')).toBe(false)
    expect(await rejectionOf(s.session.revert({ requestId: 'bad-scope', sessionId: 'session', boundary: { turnId: 'canonical-old', relation: 'before' }, scope: 'both' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  })
  test('modern revert timeout does not try rollback', async () => {
    const s = await setup('timeout-revert', '0.164.0', 150)
    expect(await rejectionOf(s.session.revert({ requestId: 'r', sessionId: 'session', boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' }, scope: 'conversation' }))).toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true })
    expect((await s.calls()).some(call => call.method === 'thread/rollback')).toBe(false)
  })
  test('explicit method-not-found updates capability without a destructive probe', async () => {
    const s = await setup('missing-optional')
    expect((await s.calls()).some(call => call.method === 'thread/revert')).toBe(false)
    expect(await rejectionOf(s.session.revert({ requestId: 'r', sessionId: 'session', boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' }, scope: 'conversation' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect(s.session.capabilities.session?.revert).toEqual([])
    expect((await s.calls()).filter(call => call.method === 'thread/revert')).toHaveLength(1)
  })
  test('config, goals and compaction are native operations with maintenance completion', async () => {
    const s = await setup('hold')
    await s.session.setConfig({ requestId: 'cfg', sessionId: 'session', patch: { model: 'test-model' } })
    expect(await s.session.setGoal({ requestId: 'goal', sessionId: 'session', goal: { objective: 'finish' } })).toEqual({ goal: { objective: 'finish', status: 'active' }, status: 'active' })
    expect(await s.session.clearGoal({ requestId: 'clear', sessionId: 'session' })).toEqual({ goal: null, status: 'cleared' })
    expect((await s.session.compact({ requestId: 'compact', sessionId: 'session' })).status).toBe('completed')
    expect(s.events.some(event => event.type === 'notice' && event.payload.code === 'CONTEXT_COMPACTED')).toBe(true)
    expect(s.events.some(event => event.type === 'turn/started')).toBe(false)
  })
  test('newer unverified versions keep the baseline and profiled methods; only pre-profile versions stay conservative', () => {
    const newer = codexCapabilities('0.165.0')
    expect(newer.config?.options.map(option => option.id)).toEqual(['permissionMode', 'model', 'effort', 'summary', 'approvalPolicy', 'fastMode'])
    expect(newer.session?.fork).toEqual(['before', 'through'])
    expect(newer.turn?.steer).toBe(true)
    expect(newer.review).toBe(true)
    const old = codexCapabilities('0.100.0')
    expect(old.session?.fork).toEqual([]); expect(old.turn?.steer).toBe(false); expect(old.review).toBeUndefined(); expect(old.config?.options).toEqual([])
  })
})

test('mapping unknown items preserves safe payload and usage fields remain optional', () => {
  const item = mapItems({ id: 'x', type: 'future', safe: 1, apiKey: 'private' }, true)[0]!
  expect(item.type === 'toolCall' && item.kind).toBe('other')
  expect(JSON.stringify(item)).not.toContain('private')
  expect(mapUsage({ outputTokens: 4 })).toEqual({ provider: 'codex', scope: 'turn', source: 'native', output: 4 })
})


test('resume and fork use persisted native identities, and review has one turn', async () => {
  const s = await setup('hold')
  const binding = { sessionId: 'resumed', adapterId: 'codex', runtimeConfigId: 'codex-test', nativeRef: { provider: 'codex', value: 'native-thread' } }
  const resumed = await s.runtime.openSession({ requestId: 'resume', mode: 'resume', binding, cwd: s.dir })
  expect(resumed.binding.nativeRef?.value).toBe('native-thread')
  await resumed.close()
  const forked = await s.runtime.openSession({ requestId: 'fork', mode: 'fork', binding: { ...binding, sessionId: 'forked' }, cwd: s.dir, fork: { sourceSessionId: 'session', nativeRef: binding.nativeRef, boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' } } })
  expect(forked.binding.sessionId).toBe('forked'); await forked.close()
  await s.session.review({ requestId: 'review', sessionId: 'session', turnId: 'review-ahp', target: { type: 'uncommittedChanges' } })
  await s.session.interrupt({ requestId: 'interrupt-review', sessionId: 'session', turnId: 'review-ahp' })
  await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
  expect(s.events.filter(event => event.type === 'turn/started')).toHaveLength(1)
  const calls = await s.calls()
  expect(calls.find(call => call.method === 'thread/resume')?.params?.threadId).toBe('native-thread')
  expect(calls.find(call => call.method === 'thread/fork')?.params?.beforeTurnId).toBe('native-turn-1')
})

test('maps every native content family without relying on titles', () => {
  const examples = [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
    { id: 'p', type: 'plan', text: 'plan' }, { id: 'r', type: 'reasoning', summary: ['s'] },
    { id: 'f', type: 'fileChange', changes: [{ path: '/workspace/a', kind: 'add' }] },
    { id: 'm', type: 'mcpToolCall', server: 'server', tool: 'tool', arguments: {}, result: { content: [] } },
    { id: 'd', type: 'dynamicToolCall', tool: 'custom', arguments: {}, result: 'done' },
    { id: 'w', type: 'webSearch', query: 'search', results: [] },
    { id: 'i', type: 'imageGeneration', result: 'image' },
    { id: 'rv', type: 'enteredReviewMode', review: 'review' },
    { id: 'cp', type: 'contextCompaction', summary: 'compact' },
  ]
  expect(examples.map(value => mapItems(value, true)[0]!.type)).toEqual(['userMessage','plan','reasoning','toolCall','toolCall','toolCall','toolCall','toolCall','review','compaction'])
})


test('model discovery is read-only and owns its short-lived process', async () => {
  const s = await setup('hold'); expect(await s.adapter.listModels(s.dir)).toEqual([
    { id: 'test-model', name: 'Test model' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: [{ id: 'low', description: 'Fast' }, { id: 'ultra', description: 'Deepest' }], defaultEffort: 'low', serviceTiers: ['standard', 'priority'] },
    { id: 'gpt-reserve', name: 'GPT-Reserve', hidden: true },
  ]);
  const calls = await s.calls(); expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'model/list')).toHaveLength(1);
  expect(calls.find(call => call.method === 'model/list')?.params).toMatchObject({ includeHidden: true });
})


test('read-only reconciliation requires explicit idle and exact terminal native turn evidence', async () => {
  const s = await setup('hold'); expect(await s.adapter.inspectExecution(s.session.binding,'native-turn-1')).toEqual({stopped:true,status:'completed',turnId:'native-turn-1'});
  expect(await s.adapter.inspectExecution(s.session.binding)).toEqual({stopped:false});
  expect(await s.adapter.inspectExecution(s.session.binding,'missing-turn')).toEqual({stopped:false});
  for(const mode of ['not-loaded','still-active']){const other=await setup(mode);expect(await other.adapter.inspectExecution(other.session.binding,'native-turn-1')).toEqual({stopped:false});}
  expect((await s.calls()).filter(call=>call.method==='thread/resume')).toHaveLength(0);
})

test('turn errors classify only native categories and HTTP status, never untrusted diagnostic text', async () => {
  const { mapTurnError } = await import('../src/mapping')
  expect(mapTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, message: 'PRIVATE' })).toMatchObject({ code: 'AUTH_REQUIRED', details: { httpStatusCode: 401 } })
  expect(mapTurnError({ codexErrorInfo: 'usageLimitExceeded' }).code).toBe('USAGE_LIMIT_EXCEEDED')
  expect(mapTurnError({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } })).toMatchObject({ code: 'RATE_LIMITED', retryable: true, outcomeUnknown: false })
  expect(mapTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }).code).toBe('NATIVE_SERVICE_UNAVAILABLE')
  const unknown = mapTurnError({ codexErrorInfo: 'PRIVATE_UNKNOWN_CATEGORY', message: 'secret text', additionalDetails: 'private URL' })
  expect(unknown.code).toBe('NATIVE_TURN_FAILED'); expect(JSON.stringify(unknown)).not.toMatch(/PRIVATE|secret text|private URL/)
})


test('file-change output arriving first stays a typed tool log and later snapshots retain source and diagnostics', async () => {
  const s = await setup('file-change')
  await s.session.startTurn(start)
  await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
  const started = s.events.find(event => event.type === 'item/started' && event.payload.item.id === 'edit')
  expect(started).toMatchObject({ payload: { item: { type: 'toolCall', kind: 'fileChange' } } })
  const log = s.events.find(event => event.type === 'item/delta' && event.payload.itemId === 'edit' && event.payload.text)
  expect(log).toMatchObject({ payload: { kind: 'output', text: 'Applying patch…\n' } })
  const snapshot = s.events.find(event => event.type === 'item/delta' && event.payload.itemId === 'edit' && event.payload.kind === 'patch')
  expect(snapshot).toMatchObject({ payload: { value: { fileChanges: [{ path: '/workspace/new.ts', oldPath: '/workspace/old.ts', operation: 'rename' }], output: 'Applying patch…\n' } } })
  expect(s.events.find(event => event.type === 'item/completed' && event.payload.item.id === 'edit')).toMatchObject({ payload: { item: { status: 'completed', output: 'Applying patch…\n', fileChanges: [{ materials: [{ format: 'unified' }] }] } } })
})

describe('Codex fast mode', () => {
  test('fastMode is a boolean session option mapped to the priority service tier and never sent as native config', async () => {
    const s = await setup('normal', '0.164.0', 1000, { fastMode: true })
    await s.session.startTurn(start); await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const calls = await s.calls()
    expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ serviceTier: 'priority' })
    expect(JSON.stringify(calls.find(call => call.method === 'thread/start')?.params?.config ?? {})).not.toContain('fastMode')
    expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ serviceTier: 'priority' })
    await s.session.setConfig({ requestId: 'off', sessionId: 'session', patch: { fastMode: false } } as never)
    expect((await s.calls()).filter(call => call.method === 'thread/settings/update').at(-1)?.params).toMatchObject({ serviceTier: null })
    expect(await rejectionOf(s.session.setConfig({ requestId: 'bad', sessionId: 'session', patch: { fastMode: 'yes' } } as never))).toMatchObject({ code: 'INVALID_PARAMS' })
  })
  test('standard speed sends no tier before fast mode is configured', async () => {
    const s = await setup('normal')
    await s.session.startTurn(start); await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect((await s.calls()).find(call => call.method === 'turn/start')?.params).not.toHaveProperty('serviceTier')
  })
})

describe('Codex version profiles', () => {
  test('a version uses the newest profile it reaches and is verified only when it is an exact verified version', () => {
    expect(resolveCodexProfile('0.147.9')).toEqual({ profile: undefined, verified: false })
    expect(resolveCodexProfile('0.148.0')).toMatchObject({ profile: { since: '0.148.0', revert: 'thread/rollback', settings: 'per-turn' }, verified: true })
    expect(resolveCodexProfile('0.149.2')).toMatchObject({ profile: { since: '0.148.0' }, verified: false })
    expect(resolveCodexProfile('0.164.0')).toMatchObject({ profile: { since: '0.164.0', revert: 'thread/revert' }, verified: true })
    expect(resolveCodexProfile('0.164.1')).toMatchObject({ profile: { since: '0.164.0' }, verified: false })
    expect(resolveCodexProfile('0.164.0')).toMatchObject({ verified: true })
    expect(resolveCodexProfile('0.165.0')).toMatchObject({ profile: { since: '0.164.0', settings: 'thread/settings/update' }, verified: false })
  })
  test('a newer unverified Codex still applies settings through the profile and reports itself once', async () => {
    const s = await setup('normal', '0.165.0')
    expect(await s.session.startTurn(start)).toEqual({ turnId: 'canonical', accepted: true })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect(s.events.filter(event => event.type === 'notice' && event.payload.code === 'CODEX_VERSION_UNVERIFIED')).toHaveLength(1)
    await s.session.setConfig({ requestId: 'c1', sessionId: 'session', patch: { effort: 'high' } } as never)
    expect((await s.calls()).some(call => call.method === 'thread/settings/update')).toBe(true)
  })
})


test('native titles hydrate on open, ignore other threads, dedupe, and clear after turn completion', async () => {
  const f = await setup('titles')
  await f.waitFor(() => f.events.some(event => event.type === 'session/metadata'))
  expect(f.events.find(event => event.type === 'session/state')).toMatchObject({ payload: { metadata: { title: 'Restored title' } } })
  await f.session.startTurn(start)
  await f.waitFor(() => f.events.some(event => event.type === 'session/metadata' && event.payload.title === null))
  expect(f.events.filter(event => event.type === 'session/metadata').map(event => event.payload)).toEqual([
    { title: 'Restored title' }, { title: 'Native title' }, { title: null },
  ])
  expect(f.events.filter(event => event.type === 'turn/completed')).toHaveLength(1)
})

test('rejectionOf surfaces the cause and rejects when an operation resolves instead', async () => {
  expect(await rejectionOf(Promise.reject(new Error('boom')))).toMatchObject({ message: 'boom' })
  await expect(rejectionOf(Promise.resolve('unexpectedly fine'))).rejects.toThrow('Expected the operation to reject')
})

describe('native error paths and edge boundaries', () => {
  test('steering requires the native turn map; a mismatched native steer is rejected', async () => {
    const s = await setup('normal')
    await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect(await rejectionOf(s.session.steer({ requestId: 'unmapped', sessionId: 'session', expectedTurnId: 'never-started', input: [{ type: 'text', text: 'x' }] }))).toMatchObject({ code: 'TURN_MISMATCH' })
    expect(await rejectionOf(s.session.interrupt({ requestId: 'unmapped-interrupt', sessionId: 'session', turnId: 'never-started' }))).toMatchObject({ code: 'TURN_MISMATCH' })
    const mismatch = await setup('steer-mismatch')
    await mismatch.session.startTurn(start)
    await mismatch.waitFor(() => mismatch.events.some(event => event.type === 'turn/started'))
    expect(await rejectionOf(mismatch.session.steer({ requestId: 'steer', sessionId: 'session', expectedTurnId: 'canonical', input: [{ type: 'text', text: 'x' }] }))).toMatchObject({ code: 'TURN_MISMATCH' })
  })
  test('history snapshots expire after a revert invalidates them', async () => {
    const s = await setup('normal')
    await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const page = await s.session.readHistory({ requestId: 'h1', sessionId: 'session' })
    expect(page.items.length).toBeGreaterThan(0)
    await s.session.revert({ requestId: 'revert', sessionId: 'session', boundary: { turnId: 'canonical', nativeTurnId: 'native-turn-1', relation: 'through' }, scope: 'conversation' })
    expect(await rejectionOf(s.session.readHistory({ requestId: 'h2', sessionId: 'session', snapshotToken: page.snapshotToken }))).toMatchObject({ code: 'CURSOR_EXPIRED' })
  })
  test('compaction without a native completion is a bounded unknown outcome', async () => {
    const s = await setup('compact-hang', '0.164.0', 300)
    expect(await rejectionOf(s.session.compact({ requestId: 'compact', sessionId: 'session' }))).toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true })
  })
  test('a failed thread open never registers the session', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex open-fail ')); dirs.push(dir)
    const adapter = createCodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))], version: '0.164.0', env: { ...process.env, FAKE_SCENARIO: 'open-fail' }, timeoutMs: 1000 })
    const runtime = createHarnessRuntime(adapter); resources.push(runtime)
    await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' }, clientCapabilities: { interactions: [] } })
    await expect(runtime.openSession({ requestId: 'open', mode: 'new', binding: { sessionId: 'doomed', adapterId: 'codex', runtimeConfigId: 'codex-test' }, cwd: dir })).rejects.toMatchObject({ code: 'NATIVE_RPC_ERROR' })
  })
  test('native error notifications surface as error-severity notices', async () => {
    const s = await setup('error-notice')
    await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const notice = s.events.find(event => event.type === 'notice' && event.payload.severity === 'error')
    expect(notice?.payload).toMatchObject({ code: 'NATIVE_NOTIFICATION' })
  })
  test('policy-rule approval options map to native execpolicy amendments', async () => {
    const s = await setup('policy')
    await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'interaction/requested'))
    const request = s.events.find(event => event.type === 'interaction/requested')!
    if (request.type !== 'interaction/requested') throw new Error()
    expect(request.payload).toMatchObject({ kind: 'approval', options: [{ id: 'rule:0', label: 'Apply supplied policy rule', semantic: 'allowWithRule' }] })
    const calls = await s.calls()
    const outbound = calls.filter(call => call.method === undefined && call.result)
    expect(outbound).toHaveLength(0)
    await s.session.respond({ requestId: 'respond', sessionId: 'session', interactionId: request.payload.interactionId, response: { kind: 'approval', optionId: 'rule:0' } })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const answered = await s.calls()
    const reply = answered.find(call => call.method === undefined && call.id === 'server-request' && call.result)
    expect(reply?.result).toEqual({ decision: { acceptWithExecpolicyAmendment: { rule: 'trust' } } })
  })
  test('paged native turn lists drive through-boundary reverts', async () => {
    const s = await setup('turns-paged', '0.164.0')
    await s.session.startTurn(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    await s.session.revert({ requestId: 'revert', sessionId: 'session', boundary: { turnId: 'canonical', nativeTurnId: 'native-turn-1', relation: 'through' }, scope: 'conversation' })
    const calls = await s.calls()
    const pages = calls.filter(call => call.method === 'thread/turns/list')
    expect(pages).toHaveLength(2)
    expect(pages[1]?.params).toMatchObject({ cursor: 'page-two' })
    expect(calls.some(call => call.method === 'thread/revert')).toBe(true)
  })
  test('repeating native model cursors fail closed', async () => {
    const s = await setup('model-loop')
    expect(await rejectionOf(s.adapter.listModels(s.dir))).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

describe('version probe', () => {
  function fakeProbeProcess(output: string, code: number, hang = false): HarnessProcess {
    return {
      pid: 4242, owned: true,
      stdout: hang ? (async function* () { await new Promise(() => {}) })() : (async function* () { yield new TextEncoder().encode(output); })(),
      stderr: (async function* () {})(),
      exited: Promise.resolve({ code, signal: null }),
      async write() { throw new Error('probe process is read-only') },
      async closeInput() {}, async dispose() {},
    }
  }
  const initializeWith = (processFactory: NonNullable<CodexAdapterOptions['processFactory']>) => {
    const adapter = createCodexAdapter({ command: process.execPath, args: ['app-server'], version: undefined, timeoutMs: 2000, processFactory })
    const runtime = createHarnessRuntime(adapter); resources.push(runtime)
    return runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' }, clientCapabilities: { interactions: [] } })
  }
  test('an unpinned version resolves from a short-lived --version process', async () => {
    const initialized = await initializeWith(async options => options.args?.[options.args.length - 1] === '--version' ? fakeProbeProcess('codex-cli 0.164.0 (probe build)\n', 0) : spawnHarnessProcess(options))
    expect(initialized.runtime.version).toBe('0.164.0')
  })
  test('probe failures surface HARNESS_UNAVAILABLE and runaway output fails PROTOCOL_ERROR', async () => {
    await expect(initializeWith(async () => fakeProbeProcess('codex-cli 0.148.0\n', 3))).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' })
    await expect(initializeWith(async () => fakeProbeProcess('x'.repeat(5000) + '\n', 0))).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
  test('a hung probe is bounded by the version timeout', async () => {
    const adapter = createCodexAdapter({ command: process.execPath, args: ['app-server'], version: undefined, timeoutMs: 30, processFactory: async () => fakeProbeProcess('', 0, true) })
    const runtime = createHarnessRuntime(adapter); resources.push(runtime)
    await expect(runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'test', version: '1' }, clientCapabilities: { interactions: [] } })).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE' })
  })
})
