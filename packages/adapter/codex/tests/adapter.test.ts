/** Exercises Codex adapter and SDK integration against fake native processes. */
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@anureo/sdk'
import type { HarnessProcess } from '@anureo/sdk/process'
import { type AhpEvent, type InitializeParams, type InteractionResponse, type JsonObject } from '@anureo/protocol'
import { createCodexAdapter, codexCapabilities, mapItems, mapUsage, resolveCodexProfile, type CodexAdapterOptions } from '../src'
import { rejectionOf } from './test-helpers'

const resources: Array<{ dispose(): Promise<void> }> = []
const dirs: string[] = []

/** Release registered runtimes before removing directories their processes may still use. */
afterEach(async () => {
  await Promise.all(resources.splice(0).map(resource => resource.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Fake scenario and operation settings accepted by setup; bootstrap uses a separate timeout so process startup does not consume timeout-test budgets. */
type SetupOptions = {
  scenario?: string
  version?: string
  timeoutMs?: number
  config?: JsonObject
  model?: string
}

/** Open a fake Codex session, register its runtime and cwd for cleanup, and expose the event stream and wire log for assertions. Startup failures reject. */
async function setup({ scenario = 'normal', version = '0.164.0', timeoutMs = 1000, config, model }: SetupOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'codex adapter '))
  dirs.push(dir)
  const log = path.join(dir, 'calls.jsonl')
  // Bootstrap is not the operation under timeout test; Windows process startup may exceed 100ms.
  const bootstrapTimeoutMs = Math.max(1000, timeoutMs)
  const identity = { adapterId: 'codex', runtimeConfigId: 'codex-test' }
  const adapter = createCodexAdapter({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
    version,
    env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_LOG_FILE: log },
    timeoutMs: bootstrapTimeoutMs,
  })
  const runtime = await createClient({
    adapter, identity, interactions: { approval: undefined, userInput: undefined, elicitation: undefined, dynamicTool: undefined },
  })
  resources.push(runtime)
  const session = await runtime.openSession({
    requestId: 'open', mode: 'new', binding: { sessionId: 'session', ...identity }, cwd: dir,
    config, ...(model ? { model } : {}),
  })
  adapter.options.timeoutMs = timeoutMs
  /** Read the fake process log in wire order for assertions; filesystem/JSON errors reject and afterEach owns temporary directory removal. */
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method?: string; params?: Record<string, unknown>; id?: string|number; result?: unknown; error?: unknown })
  return { adapter, runtime, session, calls, dir, ...collectSessionEvents(session) }
}
/** For setup, collect one SDK session's events and return predicate waiters plus collector completion. Each waiter owns its timer/listener; stream failures remain visible as unmet-condition timeouts, while afterEach owns session disposal. */
function collectSessionEvents(session: Awaited<ReturnType<Client['openSession']>>) {
  const events: AhpEvent[] = []
  const listeners = new Set<() => void>()
  const consume = (async () => {
    try {
      for await (const event of session.events()) {
        events.push(event)
        for (const listener of [...listeners]) {
          listener()
        }
      }
    } catch {
      // Ignore all collector failures, including stream closure during teardown.
      // Unmet waitFor conditions still fail through the normal timeout.
    }
  })()
  /** Wait for collected events to satisfy a predicate, removing the listener on completion or a two-second rejection; tests must dispose the shared runtime after use. */
  const waitFor = (condition: () => boolean) => new Promise<void>((resolve, reject) => {
    if (condition()) {
      resolve()
      return
    }
    const done = () => {
      if (condition()) {
        clearTimeout(timer)
        listeners.delete(done)
        resolve()
      }
    }
    const timer = setTimeout(() => {
      listeners.delete(done)
      reject(new Error('Event timeout'))
    }, 2000)
    listeners.add(done)
  })
  return { events, waitFor, consume }
}

const start = { input: [{ type: 'text' as const, text: 'hello' }] }

/** Pure projection assertions keep generated attachments distinguishable from viewed inputs, including empty generated data; matcher failures expose lost provenance. */
test('retains image provenance and distinguishes generated output from viewed inputs', () => {
  expect(mapItems({ id: 'g', type: 'imageGeneration', result: 'base64-data', savedPath: '/tmp/g.png', revisedPrompt: 'A tree' }, true)[0]).toMatchObject({
    type: 'toolCall', kind: 'image', image: { kind: 'generated', data: 'base64-data', path: '/tmp/g.png', revisedPrompt: 'A tree' },
  })
  expect(mapItems({ id: 'g', type: 'imageGeneration', result: '', fileId: 'attachment' }, true)[0]).toMatchObject({ image: { kind: 'generated', fileId: 'attachment' } })
  expect(mapItems({ id: 'v', type: 'imageView', path: '/tmp/input.png' }, true)[0]).toMatchObject({ image: { kind: 'view', path: '/tmp/input.png' } })
})

/** Register both supported native profiles against the same permission matrix so thread defaults and later turn settings cannot diverge. */
describe('Codex permission controls', () => {
  const modes = [
    ['read-only', 'on-request', 'read-only', 'readOnly'],
    ['agent', 'on-request', 'workspace-write', 'workspaceWrite'],
    ['agent-full-access', 'never', 'danger-full-access', 'dangerFullAccess'],
  ] as const
  for (const version of ['0.148.0', '0.164.0']) for (const [mode, approvalPolicy, sandbox, type] of modes) {
    /** Use setup-owned fake I/O to verify draft policy reaches both native scopes; reject any drift between public schema and wire settings. */
    test(`${version} applies draft ${mode} to thread and subsequent turns`, async () => {
      const s = await setup({ version, config: { permissionMode: mode } })
      await s.session.submit(start)
      const calls = await s.calls()
      expect(codexCapabilities(version).config?.options.find(option => option.id === 'permissionMode')?.schema).toMatchObject({ enum: ['read-only', 'agent', 'agent-full-access'] })
      expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ approvalPolicy, sandbox, config: { sandbox_mode: sandbox, approval_policy: approvalPolicy } })
      expect(calls.find(call => call.method === 'thread/start')?.params?.config).not.toHaveProperty('permissionMode')
      expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ approvalPolicy, sandboxPolicy: { type } })
    })
    /** Apply policy after opening, then dispatch: older profiles must retain per-turn enforcement even without a settings RPC. */
    test(`${version} applies session ${mode} to native settings and the next turn`, async () => {
      const s = await setup({ version })
      const state = await s.session.request('session/config/set', { requestId: 'permissions', sessionId: 'session', patch: { permissionMode: mode } })
      expect(state.config.permissionMode).toBe(mode)
      await s.session.submit(start)
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

/** Register event-order and identity regressions together because projections depend on native evidence rather than RPC acknowledgement order. */
describe('Codex native lifecycle', () => {
  /** Drive two reused-item turns through fake I/O and wait for evidence before asserting; patching or finalization must not replace their original start anchors. */
  test('retains native start anchors through deltas, repeated starts, completion and reused IDs', async () => {
    const s = await setup({ scenario: 'timing' })
    for (const [turnId, startedAt] of [['native-turn-1', '2026-10-28T01:00:03.000Z'], ['native-turn-2', '2026-10-28T01:01:03.000Z']] as const) {
      await s.session.submit(start)
      await s.waitFor(() => s.events.some(event => event.turnId === turnId && event.type === 'item/delta' && event.payload.kind === 'patch'))
      const started = s.events.find(event => event.turnId === turnId && event.type === 'item/started')!
      expect(started.type === 'item/started' && started.payload.item.startedAt).toBe(startedAt)
      const patched = s.events.find(event => event.turnId === turnId && event.type === 'item/delta' && event.payload.kind === 'patch')!
      expect(patched.type === 'item/delta' && patched.payload.value).toMatchObject({ startedAt, text: 'Repeated start' })
      await s.session.request('turn/steer', { submissionId: `finish-${turnId}`, requestId: `finish-${turnId}`, sessionId: 'session', expectedTurnId: turnId, input: [{ type: 'text', text: 'Finish' }] })
      await s.waitFor(() => s.events.some(event => event.turnId === turnId && event.type === 'turn/completed'))
      const completed = s.events.find(event => event.turnId === turnId && event.type === 'item/completed')!
      expect(completed.type === 'item/completed' && completed.payload.item).toMatchObject({ startedAt, status: 'completed', text: 'authoritative final' })
    }
  })

  /** Read successive fake history pages to ensure timestamp projection uses each entry rather than live-session state; setup owns cleanup. */
  test('reads start anchors from paginated native history entries', async () => {
    const s = await setup({ scenario: 'timing' })
    const first = await s.session.request('history/read', { requestId: 'timed-history', sessionId: 'session', limit: 1 })
    const second = await s.session.request('history/read', { requestId: 'timed-history-next', sessionId: 'session', cursor: first.nextCursor!, snapshotToken: first.snapshotToken })
    expect(first.items[0]?.item).toMatchObject({ id: 'reused', text: 'one', startedAt: '2026-10-28T01:00:03.000Z' })
    expect(second.items[0]?.item).toMatchObject({ id: 'reused', text: 'two', startedAt: '2026-10-28T01:01:03.000Z' })
  })

  /** Exercise timestamp boundaries without I/O: invalid values must not fabricate provenance, while zero remains a valid native epoch. */
  test('omits missing or invalid native timestamps without inventing an anchor', () => {
    const raw = { id: 'answer', type: 'agentMessage', text: 'Done' }
    for (const startedAtMs of [undefined, null, '123', -1, NaN, Infinity, Number.MAX_VALUE]) {
      expect(mapItems(raw, true, false, { startedAtMs })[0]).not.toHaveProperty('startedAt')
    }
    expect(mapItems(raw, true, false, { startedAtMs: 0 })[0]?.startedAt).toBe('1970-01-01T00:00:00.000Z')
    expect(mapItems({ ...raw, startedAtMs: 1000 }, true, true)[0]?.startedAt).toBe('1970-01-01T00:00:01.000Z')
  })

  /** Wait for terminal fake evidence before checking the full stream, so late projections, usage and redaction remain part of the integration contract. */
  test('maps response-before/after events, full items, usage, plans, subagents and unknown messages', async () => {
    const s = await setup(); expect(await s.session.submit(start)).toMatchObject({ id: 'native-turn-1' })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect(s.events.filter(event => event.type === 'turn/started')).toHaveLength(1)
    const started = s.events.find(event => event.type === 'turn/started')!
    expect(started.payload).toEqual({ turnId: 'native-turn-1', nativeTurnId: 'native-turn-1' })
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
    expect(s.events.every((event, index) => event.seq === s.events[0]!.seq + index)).toBe(true)
  })
  /** Keep the fake turn active across steering and interruption; a rejected concurrent submit must not manufacture a second turn identity. */
  test('steer uses the same native turn and explicit interrupt finishes it', async () => {
    const s = await setup({ scenario: 'hold' }); await s.session.submit(start)
    expect(await rejectionOf(s.session.submit(start))).toMatchObject({ code: 'NATIVE_RPC_ERROR' })
    expect(await s.session.request('turn/steer', { submissionId: 'steer', requestId: 'steer', sessionId: 'session', expectedTurnId: 'native-turn-1', input: [{ type: 'text', text: 'adjust' }] })).toMatchObject({ turnId: 'native-turn-1', accepted: true })
    await s.session.request('turn/interrupt', { requestId: 'interrupt', sessionId: 'session', turnId: 'native-turn-1' })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const call = (await s.calls()).find(call => call.method === 'turn/steer')!
    expect(call.params?.expectedTurnId).toBe('native-turn-1')
    expect(s.events.filter(event => event.type === 'turn/started')).toHaveLength(1)
  })
})

/** Register preflight and mid-turn auth cases separately because an undispatched failure cannot imply an uncertain execution outcome. */
describe('independent account readiness', () => {
  /** Inspect fake wire calls as well as the surfaced error: AUTH_REQUIRED is useful only if dispatch never happened. */
  test('missing account blocks dispatch and exposes only an actionable auth error', async () => {
    const s = await setup({ scenario: 'auth-required' })
    expect(await s.adapter.readAuthStatus()).toBe('required')
    expect(await rejectionOf(s.session.submit(start))).toMatchObject({ code: 'AUTH_REQUIRED', outcomeUnknown: false })
    expect((await s.calls()).some(call => call.method === 'turn/start')).toBe(false)
    expect(s.events.some(event => event.type === 'turn/started')).toBe(false)
  })
  /** For each fake account mode, require a real turn/start call so permissive readiness cannot silently skip execution; setup owns both fixtures. */
  for (const mode of ['auth-unavailable', 'auth-not-required']) test(`${mode} does not invent a requirement for native authentication`, async () => {
    const s = await setup({ scenario: mode })
    expect(await s.adapter.readAuthStatus()).toBe(mode === 'auth-unavailable' ? 'unknown' : 'ready')
    await expect(s.session.submit(start)).resolves.toMatchObject({ id: 'native-turn-1' })
    expect((await s.calls()).filter(call => call.method === 'turn/start')).toHaveLength(1)
  })
  /** Let only the account read time out and inspect fake calls; the timeout remains visible without assigning uncertainty to an undispatched turn. */
  test('an account preflight timeout stays visible but cannot mark an undispatched turn unknown', async () => {
    const s = await setup({ scenario: 'auth-timeout', timeoutMs: 100 })
    expect(await rejectionOf(s.session.submit(start))).toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: false })
    expect((await s.calls()).some(call => call.method === 'turn/start')).toBe(false)
  })
  /** Return malformed fake readiness evidence and require failure before dispatch rather than silently assuming an anonymous provider. */
  test('invalid account status is not treated as an anonymous provider', async () => {
    const s = await setup({ scenario: 'auth-malformed' })
    expect(await rejectionOf(s.session.submit(start))).toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect((await s.calls()).some(call => call.method === 'turn/start')).toBe(false)
  })
  /** Wait for terminal fake evidence to verify auth classification and diagnostic redaction after dispatch; setup owns process cleanup. */
  test('a mid-turn native unauthorized failure remains an auth error without leaking provider details', async () => {
    const s = await setup({ scenario: 'auth-expired' }); await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const terminal = s.events.find(event => event.type === 'turn/completed')!
    expect(terminal.type === 'turn/completed' && terminal.payload.error).toMatchObject({ code: 'AUTH_REQUIRED', outcomeUnknown: false })
    expect(JSON.stringify(s.events)).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC')
    expect(JSON.stringify(s.events)).not.toContain('token=private')
  })
})

/** Register response fixtures across interaction families; native correlation IDs and structured answers must survive public interaction routing. */
describe('native interactions', () => {
  const cases: Array<{
    scenario: string
    response: InteractionResponse
    nativeRequestId: string | number
    expectedResult?: JsonObject
  }> = [
    {
      scenario: 'approval',
      response: { kind: 'approval', optionId: 'decline' },
      nativeRequestId: 'server-request',
      expectedResult: { decision: 'decline' },
    },
    {
      scenario: 'fileapproval',
      response: { kind: 'approval', optionId: 'decline' },
      nativeRequestId: 'server-request',
    },
    {
      scenario: 'permission',
      response: { kind: 'approval', optionId: 'decline' },
      nativeRequestId: 901,
      expectedResult: { permissions: {}, scope: 'turn' },
    },
    {
      scenario: 'questions',
      response: { kind: 'userInput', answers: { q: '0' } },
      nativeRequestId: 'server-request',
      expectedResult: { answers: { q: { answers: ['A'] } } },
    },
    {
      scenario: 'elicitation',
      response: { kind: 'elicitation', action: 'cancel' },
      nativeRequestId: 'server-request',
    },
    {
      scenario: 'dynamic',
      response: { kind: 'dynamicTool', content: [{ type: 'text', text: 'tool output' }] },
      nativeRequestId: 'server-request',
    },
  ]
  /** Await the requested interaction before answering through the SDK, then check fake wire correlation after completion; setup owns cleanup. */
  for (const { scenario, response, nativeRequestId, expectedResult } of cases) test(`${scenario} keeps native request id and structured response`, async () => {
    const s = await setup({ scenario }); await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'interaction/requested'))
    const request = s.events.find(event => event.type === 'interaction/requested')!
    if (request.type !== 'interaction/requested') throw new Error()
    await s.session.request('interaction/respond', { requestId: 'respond', sessionId: 'session', interactionId: request.payload.interactionId, response })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const calls = await s.calls()
    const reply = calls.find(call => call.id === nativeRequestId && !call.method)
    expect(reply).toBeDefined()
    expect(s.events.filter(event => event.type === 'interaction/resolved')).toHaveLength(1)
    if (expectedResult !== undefined) expect(reply?.result).toEqual(expectedResult)
  })
  /** Run the fake future-method case through completion: rejecting an unknown request must never expose an approval surface. */
  test('unknown native request receives method-not-found, never approval', async () => {
    const s = await setup({ scenario: 'unknown-request' }); await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const reply = (await s.calls()).find(call => call.id === 'server-request' && !call.method)
    expect(reply?.error).toEqual({ code: -32601, message: 'Unsupported native request' })
    expect(s.events.some(event => event.type === 'interaction/requested')).toBe(false)
  })
})

/** Register native control and history regressions together so optional-method discovery cannot silently change unrelated session behavior. */
describe('versioned controls and history', () => {
  /** Revoke fake history support before changing config; capability publication must retain model selection across unrelated updates. */
  test('retains the selected model in capability snapshots and subsequent configuration results', async () => {
    const s = await setup({ scenario: 'no-history', config: {}, model: 'initial-model' })
    expect(await rejectionOf(s.session.request('history/read', { requestId: 'history', sessionId: 'session' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    await s.waitFor(() => s.events.some(event => event.type === 'session/state' && event.payload.capabilities.session?.history === false))
    expect(s.events.filter(event => event.type === 'session/state').every(event => event.type === 'session/state' && event.payload.model === 'initial-model')).toBe(true)
    expect((await s.session.request('session/config/set', { requestId: 'model', sessionId: 'session', patch: { model: 'next-model' } })).model).toBe('next-model')
    expect((await s.session.request('session/config/set', { requestId: 'speed', sessionId: 'session', patch: { fastMode: false } })).model).toBe('next-model')
    expect((await s.calls()).find(call => call.method === 'thread/start')?.params?.model).toBe('initial-model')
  })
  /** Read a second page from the same snapshot and reject an invalid cursor; fake wire counts prevent accidentally refetching a stable snapshot. */
  test('modern native history pages become a bounded stable snapshot', async () => {
    const s = await setup({ scenario: 'hold' })
    const one = await s.session.request('history/read', { requestId: 'h1', sessionId: 'session', limit: 1 })
    expect(one.items).toHaveLength(1); expect(one.nextCursor).toBeTruthy()
    const two = await s.session.request('history/read', { requestId: 'h2', sessionId: 'session', cursor: one.nextCursor!, snapshotToken: one.snapshotToken, limit: 1 })
    expect(two.items[0]?.nativeTurnId).toBe('native-turn-2'); expect(two.nextCursor).toBeNull()
    expect((await s.calls()).filter(call => call.method === 'thread/items/list')).toHaveLength(2)
    expect(await rejectionOf(s.session.request('history/read', { requestId: 'badcursor', sessionId: 'session', cursor: 'bad' }))).toMatchObject({ code: 'CURSOR_INVALID' })
  })
  /** Call an absent fake method twice around a successful turn: only definite method absence may revoke the capability and suppress later probes. */
  test('revokes an absent optional history method while keeping the new session usable for its first turn', async () => {
    const s = await setup({ scenario: 'no-history' })
    const failure = await rejectionOf(s.session.request('history/read', { requestId: 'history', sessionId: 'session' }))
    expect(failure).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', outcomeUnknown: false })
    expect(s.session.capabilities.session?.history).toBe(false)
    expect(await s.session.submit(start)).toMatchObject({ id: 'native-turn-1' })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect((await s.calls()).filter(call => call.method === 'turn/start')).toHaveLength(1)
    expect(await rejectionOf(s.session.request('history/read', { requestId: 'history-again', sessionId: 'session' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect((await s.calls()).filter(call => call.method === 'thread/items/list')).toHaveLength(1)
  })
  /** Assert fake rollback arguments from explicit native evidence; canonical labels alone cannot justify a destructive rollback count. */
  test('legacy revert calculates rollback only from authoritative native turns', async () => {
    const s = await setup({ scenario: 'hold', version: '0.148.0' })
    expect(codexCapabilities('0.148.0').session?.fork).toEqual(['through'])
    await s.session.request('session/revert', { requestId: 'revert', sessionId: 'session', boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' }, scope: 'conversation' })
    const calls = await s.calls()
    expect(calls.find(call => call.method === 'thread/rollback')?.params).toEqual({ threadId: 'native-thread', numTurns: 2 })
    expect(calls.some(call => call.method === 'thread/revert')).toBe(false)
    expect(await rejectionOf(s.session.request('session/revert', { requestId: 'bad-scope', sessionId: 'session', boundary: { turnId: 'canonical-old', relation: 'before' }, scope: 'both' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  })
  /** Use a fake timeout with an unknown outcome to forbid a second destructive fallback; setup owns teardown of the stalled process. */
  test('modern revert timeout does not try rollback', async () => {
    const s = await setup({ scenario: 'timeout-revert', timeoutMs: 150 })
    expect(await rejectionOf(s.session.request('session/revert', { requestId: 'r', sessionId: 'session', boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' }, scope: 'conversation' }))).toMatchObject({ code: 'REQUEST_TIMEOUT', outcomeUnknown: true })
    expect((await s.calls()).some(call => call.method === 'thread/rollback')).toBe(false)
  })
  /** Check fake calls before and after rejection to ensure optional support is learned on use rather than through a destructive startup probe. */
  test('explicit method-not-found updates capability without a destructive probe', async () => {
    const s = await setup({ scenario: 'missing-optional' })
    expect((await s.calls()).some(call => call.method === 'thread/revert')).toBe(false)
    expect(await rejectionOf(s.session.request('session/revert', { requestId: 'r', sessionId: 'session', boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' }, scope: 'conversation' }))).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect(s.session.capabilities.session?.revert).toEqual([])
    expect((await s.calls()).filter(call => call.method === 'thread/revert')).toHaveLength(1)
  })
  /** Drive fake controls through acknowledgement and maintenance evidence; completion assertions wait for native events rather than fabricating success. */
  test('config, goals and compaction are native operations with maintenance completion', async () => {
    const s = await setup({ scenario: 'hold' })
    await s.session.request('session/config/set', { requestId: 'cfg', sessionId: 'session', patch: { model: 'test-model' } })
    expect(await s.session.request('goal/set', { requestId: 'goal', sessionId: 'session', goal: { objective: 'finish' } })).toEqual({ goal: { objective: 'finish', status: 'active' }, status: 'active' })
    expect(await s.session.request('goal/clear', { requestId: 'clear', sessionId: 'session' })).toEqual({ goal: null, status: 'cleared' })
    expect((await s.session.request('compact/start', { requestId: 'compact', sessionId: 'session' })).status).toBe('accepted')
    await s.waitFor(()=>s.events.some(event=>event.type==='notice'&&event.payload.code==='CONTEXT_COMPACTED'))
    expect(s.events.some(event => event.type === 'notice' && event.payload.code === 'CONTEXT_COMPACTED')).toBe(true)
    await s.waitFor(()=>s.events.some(event=>event.type==='turn/completed'));
    expect(s.events.filter(event=>event.type==='turn/started')).toMatchObject([{payload:{turnId:'compact-turn'}}])
  })
  /** Pure capability assertions distinguish pre-profile conservatism from newer unverified versions, which must retain the latest known controls. */
  test('newer unverified versions keep the baseline and profiled methods; only pre-profile versions stay conservative', () => {
    const newer = codexCapabilities('0.165.0')
    expect(newer.config?.options.map(option => option.id)).toEqual(['permissionMode', 'model', 'effort', 'summary', 'approvalPolicy', 'fastMode'])
    expect(newer.session?.fork).toEqual(['before', 'through'])
    expect(newer.input?.steer?.atomicMatch).toBe(true)
    expect(newer.review).toBe(true)
    const old = codexCapabilities('0.100.0')
    expect(old.session?.fork).toEqual([]); expect(old.input?.steer).toBeUndefined(); expect(old.review).toBeUndefined(); expect(old.config?.options).toEqual([])
  })
})

/** Pure assertions allow safe future fields while excluding secrets and invented usage totals; no process resources are created. */
test('mapping unknown items preserves safe payload and usage fields remain optional', () => {
  const item = mapItems({ id: 'x', type: 'future', safe: 1, apiKey: 'private' }, true)[0]!
  expect(item.type === 'toolCall' && item.kind).toBe('other')
  expect(JSON.stringify(item)).not.toContain('private')
  expect(mapUsage({ outputTokens: 4 })).toEqual({ provider: 'codex', scope: 'turn', source: 'native', output: 4 })
})


/** Open and close fake resumed/forked sessions before review, then inspect wire identities; persisted native references must drive all three operations. */
test('resume and fork use persisted native identities, and review has one turn', async () => {
  const s = await setup({ scenario: 'hold' })
  const binding = { sessionId: 'resumed', adapterId: 'codex', runtimeConfigId: 'codex-test', nativeRef: { provider: 'codex', value: 'native-thread' } }
  const resumed = await s.runtime.openSession({ requestId: 'resume', mode: 'resume', binding, cwd: s.dir })
  expect(resumed.binding.nativeRef?.value).toBe('native-thread')
  await resumed.close()
  const forked = await s.runtime.openSession({ requestId: 'fork', mode: 'fork', binding: { ...binding, sessionId: 'forked' }, cwd: s.dir, fork: { sourceSessionId: 'session', nativeRef: binding.nativeRef, boundary: { turnId: 'canonical-old', nativeTurnId: 'native-turn-1', relation: 'before' } } })
  expect(forked.binding.sessionId).toBe('forked'); await forked.close()
  await s.session.review({ target: { type: 'uncommittedChanges' } })
  await s.session.request('turn/interrupt', { requestId: 'interrupt-review', sessionId: 'session', turnId: 'native-review' })
  await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
  expect(s.events.filter(event => event.type === 'turn/started')).toHaveLength(1)
  const calls = await s.calls()
  expect(calls.find(call => call.method === 'thread/resume')?.params?.threadId).toBe('native-thread')
  expect(calls.find(call => call.method === 'thread/fork')?.params?.beforeTurnId).toBe('native-turn-1')
})

/** Pure projection coverage uses native discriminators rather than display titles so every supported content family remains typed. */
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


/** Query a separate fake probe after session opening and inspect wire calls; discovery must include hidden entries without creating another thread. */
test('model discovery is read-only and owns its short-lived process', async () => {
  const s = await setup({ scenario: 'hold' }); expect(await s.adapter.listModels(s.dir)).toEqual([
    { id: 'test-model', name: 'Test model' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: [{ id: 'low', description: 'Fast' }, { id: 'ultra', description: 'Deepest' }], defaultEffort: 'low', serviceTiers: ['standard', 'priority'] },
    { id: 'gpt-reserve', name: 'GPT-Reserve', hidden: true },
  ]);
  const calls = await s.calls(); expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'model/list')).toHaveLength(1);
  expect(calls.find(call => call.method === 'model/list')?.params).toMatchObject({ includeHidden: true });
})


/** Compare idle, absent and active fake evidence without resuming a thread; setup registers every fixture for teardown. */
test('read-only reconciliation requires explicit idle and exact terminal native turn evidence', async () => {
  const s = await setup({ scenario: 'hold' }); expect(await s.adapter.inspectExecution(s.session.binding,'native-turn-1')).toEqual({stopped:true,status:'completed',turnId:'native-turn-1'});
  expect(await s.adapter.inspectExecution(s.session.binding)).toEqual({stopped:false});
  expect(await s.adapter.inspectExecution(s.session.binding,'missing-turn')).toEqual({stopped:false});
  for(const mode of ['not-loaded','still-active']){const other=await setup({ scenario: mode });expect(await other.adapter.inspectExecution(other.session.binding,'native-turn-1')).toEqual({stopped:false});}
  expect((await s.calls()).filter(call=>call.method==='thread/resume')).toHaveLength(0);
})

/** Pure error projection assertions trust structured categories and status codes only; arbitrary provider text must neither classify errors nor escape redaction. */
test('turn errors classify only native categories and HTTP status, never untrusted diagnostic text', async () => {
  const { mapTurnError } = await import('../src/mapping')
  expect(mapTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, message: 'PRIVATE' })).toMatchObject({ code: 'AUTH_REQUIRED', details: { httpStatusCode: 401 } })
  expect(mapTurnError({ codexErrorInfo: 'usageLimitExceeded' }).code).toBe('USAGE_LIMIT_EXCEEDED')
  expect(mapTurnError({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 429 } } })).toMatchObject({ code: 'RATE_LIMITED', retryable: true, outcomeUnknown: false })
  expect(mapTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }).code).toBe('NATIVE_SERVICE_UNAVAILABLE')
  const unknown = mapTurnError({ codexErrorInfo: 'PRIVATE_UNKNOWN_CATEGORY', message: 'secret text', additionalDetails: 'private URL' })
  expect(unknown.code).toBe('NATIVE_TURN_FAILED'); expect(JSON.stringify(unknown)).not.toMatch(/PRIVATE|secret text|private URL/)
})


/** Wait for fake completion before comparing out-of-order output and later snapshots; early logs must retain their typed identity and merge into final evidence. */
test('file-change output arriving first stays a typed tool log and later snapshots retain source and diagnostics', async () => {
  const s = await setup({ scenario: 'file-change' })
  await s.session.submit(start)
  await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
  const started = s.events.find(event => event.type === 'item/started' && event.payload.item.id === 'edit')
  expect(started).toMatchObject({ payload: { item: { type: 'toolCall', kind: 'fileChange' } } })
  const log = s.events.find(event => event.type === 'item/delta' && event.payload.itemId === 'edit' && event.payload.text)
  expect(log).toMatchObject({ payload: { kind: 'output', text: 'Applying patch…\n' } })
  const snapshot = s.events.find(event => event.type === 'item/delta' && event.payload.itemId === 'edit' && event.payload.kind === 'patch')
  expect(snapshot).toMatchObject({ payload: { value: { fileChanges: [{ path: '/workspace/new.ts', oldPath: '/workspace/old.ts', operation: 'rename' }], output: 'Applying patch…\n' } } })
  expect(s.events.find(event => event.type === 'item/completed' && event.payload.item.id === 'edit')).toMatchObject({ payload: { item: { status: 'completed', output: 'Applying patch…\n', fileChanges: [{ materials: [{ format: 'unified' }] }] } } })
})

/** Register speed selection at the adapter boundary because a public boolean must become a native service tier rather than leak into native config. */
describe('Codex fast mode', () => {
  /** Drive fake startup, dispatch and config updates, then reject invalid input; priority selection and explicit clearing must agree across native scopes. */
  test('fastMode is a boolean session option mapped to the priority service tier and never sent as native config', async () => {
    const s = await setup({ config: { fastMode: true } })
    await s.session.submit(start); await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const calls = await s.calls()
    expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({ serviceTier: 'priority' })
    expect(JSON.stringify(calls.find(call => call.method === 'thread/start')?.params?.config ?? {})).not.toContain('fastMode')
    expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ serviceTier: 'priority' })
    await s.session.request('session/config/set', { requestId: 'off', sessionId: 'session', patch: { fastMode: false } } as never)
    expect((await s.calls()).filter(call => call.method === 'thread/settings/update').at(-1)?.params).toMatchObject({ serviceTier: null })
    expect(await rejectionOf(s.session.request('session/config/set', { requestId: 'bad', sessionId: 'session', patch: { fastMode: 'yes' } } as never))).toMatchObject({ code: 'INVALID_PARAMS' })
  })
  /** Dispatch through the fake server without configuring fast mode; omitting a tier preserves native defaults rather than selecting a speed implicitly. */
  test('standard speed sends no tier before fast mode is configured', async () => {
    const s = await setup()
    await s.session.submit(start); await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect((await s.calls()).find(call => call.method === 'turn/start')?.params).not.toHaveProperty('serviceTier')
  })
})

/** Register profile selection and its live fake-session consequence together so version fallback remains usable as well as numerically correct. */
describe('Codex version profiles', () => {
  /** Pure profile assertions separate reaching a supported baseline from exact-version verification; a newer build must not claim verification. */
  test('a version uses the newest profile it reaches and is verified only when it is an exact verified version', () => {
    expect(resolveCodexProfile('0.147.9')).toEqual({ profile: undefined, verified: false })
    expect(resolveCodexProfile('0.148.0')).toMatchObject({ profile: { since: '0.148.0', revert: 'thread/rollback', settings: 'per-turn' }, verified: true })
    expect(resolveCodexProfile('0.149.2')).toMatchObject({ profile: { since: '0.148.0' }, verified: false })
    expect(resolveCodexProfile('0.164.0')).toMatchObject({ profile: { since: '0.164.0', revert: 'thread/revert' }, verified: true })
    expect(resolveCodexProfile('0.164.1')).toMatchObject({ profile: { since: '0.164.0' }, verified: false })
    expect(resolveCodexProfile('0.164.0')).toMatchObject({ verified: true })
    expect(resolveCodexProfile('0.165.0')).toMatchObject({ profile: { since: '0.164.0', settings: 'thread/settings/update' }, verified: false })
  })
  /** Pure boundary assertions preserve existing handling of incomplete and unmatched version text instead of introducing stricter parsing during refactoring. */
  test('numeric comparison retains missing-component and unmatched-text fallback behavior', () => {
    expect(resolveCodexProfile('0.164')).toMatchObject({ profile: { since: '0.164.0' }, verified: false })
    expect(resolveCodexProfile('0.164.0.0')).toMatchObject({ profile: { since: '0.164.0' }, verified: false })
    expect(resolveCodexProfile('custom build')).toEqual({ profile: undefined, verified: false })
    // An invalid patch cannot match 0.164.0, but the lower profile differs at the numeric minor part.
    expect(resolveCodexProfile('0.164.custom')).toMatchObject({ profile: { since: '0.148.0' }, verified: false })
  })
  /** Dispatch on a fake newer version before updating settings; retain profiled behavior while reporting the verification warning exactly once. */
  test('a newer unverified Codex still applies settings through the profile and reports itself once', async () => {
    const s = await setup({ version: '0.165.0' })
    expect(await s.session.submit(start)).toMatchObject({ id: 'native-turn-1' })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect(s.events.filter(event => event.type === 'notice' && event.payload.code === 'CODEX_VERSION_UNVERIFIED')).toHaveLength(1)
    await s.session.request('session/config/set', { requestId: 'c1', sessionId: 'session', patch: { effort: 'high' } } as never)
    expect((await s.calls()).some(call => call.method === 'thread/settings/update')).toBe(true)
  })
})


/** Observe fake title hydration and later updates through the SDK; unrelated scopes and duplicate notifications must not publish extra metadata. */
test('native titles hydrate on open, ignore other threads, dedupe, and clear after turn completion', async () => {
  const f = await setup({ scenario: 'titles' })
  expect(f.session.snapshot.metadata).toEqual({title:'Restored title'})
  await f.session.submit(start)
  await f.waitFor(() => f.events.some(event => event.type === 'session/metadata' && event.payload.title === null))
  expect(f.events.filter(event => event.type === 'session/metadata').map(event => event.payload)).toEqual([
    { title: 'Native title' }, { title: null },
  ])
  expect(f.events.filter(event => event.type === 'turn/completed')).toHaveLength(1)
})

/** Exercise the shared observer without I/O so resolved operations cannot accidentally satisfy rejection assertions in adapter or catalog tests. */
test('rejectionOf surfaces the cause and rejects when an operation resolves instead', async () => {
  expect(await rejectionOf(Promise.reject(new Error('boom')))).toMatchObject({ message: 'boom' })
  await expect(rejectionOf(Promise.resolve('unexpectedly fine'))).rejects.toThrow('Expected the operation to reject')
})

/** Register failed-boundary and optional-method scenarios that must leave fake sessions usable or reject without inventing native evidence. */
describe('native error paths and edge boundaries', () => {
  /** Exercise both missing identity evidence and a definite fake mismatch; neither path may target a different native execution. */
  test('steering requires the native turn map; a mismatched native steer is rejected', async () => {
    const s = await setup()
    await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    expect(await rejectionOf(s.session.request('turn/steer', { submissionId: 'unmapped', requestId: 'unmapped', sessionId: 'session', expectedTurnId: 'never-started', input: [{ type: 'text', text: 'x' }] }))).toMatchObject({ code: 'TURN_MISMATCH' })
    expect(await rejectionOf(s.session.request('turn/interrupt', { requestId: 'unmapped-interrupt', sessionId: 'session', turnId: 'never-started' }))).toMatchObject({ code: 'TURN_MISMATCH' })
    const mismatch = await setup({ scenario: 'steer-mismatch' })
    await mismatch.session.submit(start)
    await mismatch.waitFor(() => mismatch.events.some(event => event.type === 'turn/started'))
    expect(await rejectionOf(mismatch.session.request('turn/steer', { submissionId: 'steer', requestId: 'steer', sessionId: 'session', expectedTurnId: 'native-turn-1', input: [{ type: 'text', text: 'x' }] }))).toMatchObject({ code: 'TURN_MISMATCH' })
  })
  /** Create fake history evidence before reverting it; a cached snapshot must become unusable after the underlying conversation changes. */
  test('history snapshots expire after a revert invalidates them', async () => {
    const s = await setup()
    await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const page = await s.session.request('history/read', { requestId: 'h1', sessionId: 'session' })
    expect(page.items.length).toBeGreaterThan(0)
    await s.session.request('session/revert', { requestId: 'revert', sessionId: 'session', boundary: { turnId: 'native-turn-1', nativeTurnId: 'native-turn-1', relation: 'through' }, scope: 'conversation' })
    expect(await rejectionOf(s.session.request('history/read', { requestId: 'h2', sessionId: 'session', snapshotToken: page.snapshotToken }))).toMatchObject({ code: 'CURSOR_EXPIRED' })
  })
  /** Stop at fake acknowledgement with completion withheld; accepted maintenance work cannot be reported as finished without native evidence. */
  test('a compact acknowledgement does not fabricate native completion', async () => {
    const s = await setup({ scenario: 'compact-hang', timeoutMs: 300 })
    expect(await s.session.request('compact/start',{requestId:'compact',sessionId:'session'})).toMatchObject({status:'accepted'});
    expect(s.events.some(event=>event.type==='turn/completed'||event.type==='notice'&&event.payload.code==='CONTEXT_COMPACTED')).toBe(false)
  })
  /** Register the fake runtime before a deliberately failed open so teardown still owns its resources; the SDK must receive the native failure. */
  test('a failed thread open never registers the session', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'codex open-fail ')); dirs.push(dir)
    const adapter = createCodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))], version: '0.164.0', env: { ...process.env, FAKE_SCENARIO: 'open-fail' }, timeoutMs: 1000 })
    const runtime = await createClient({adapter,identity:{adapterId:'codex',runtimeConfigId:'codex-test'}}); resources.push(runtime)
    await expect(runtime.openSession({ requestId: 'open', mode: 'new', binding: { sessionId: 'doomed', adapterId: 'codex', runtimeConfigId: 'codex-test' }, cwd: dir })).rejects.toMatchObject({ code: 'NATIVE_RPC_ERROR' })
  })
  /** Await fake terminal evidence before inspecting notices so native error severity survives event projection without becoming a turn failure. */
  test('native error notifications surface as error-severity notices', async () => {
    const s = await setup({ scenario: 'error-notice' })
    await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const notice = s.events.find(event => event.type === 'notice' && event.payload.severity === 'error')
    expect(notice?.payload).toMatchObject({ code: 'NATIVE_NOTIFICATION' })
  })
  /** Inspect fake calls before answering, then require the supplied policy amendment in the native reply; no amendment may be applied speculatively. */
  test('policy-rule approval options map to native execpolicy amendments', async () => {
    const s = await setup({ scenario: 'policy' })
    await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'interaction/requested'))
    const request = s.events.find(event => event.type === 'interaction/requested')!
    if (request.type !== 'interaction/requested') throw new Error()
    expect(request.payload).toMatchObject({ kind: 'approval', options: [{ id: 'rule:0', label: 'Apply supplied policy rule', semantic: 'allowWithRule' }] })
    const calls = await s.calls()
    const outbound = calls.filter(call => call.method === undefined && call.result)
    expect(outbound).toHaveLength(0)
    await s.session.request('interaction/respond', { requestId: 'respond', sessionId: 'session', interactionId: request.payload.interactionId, response: { kind: 'approval', optionId: 'rule:0' } })
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    const answered = await s.calls()
    const reply = answered.find(call => call.method === undefined && call.id === 'server-request' && call.result)
    expect(reply?.result).toEqual({ decision: { acceptWithExecpolicyAmendment: { rule: 'trust' } } })
  })
  /** Revert after fake execution and inspect both turn-list pages; the boundary decision must include authoritative evidence beyond the first page. */
  test('paged native turn lists drive through-boundary reverts', async () => {
    const s = await setup({ scenario: 'turns-paged' })
    await s.session.submit(start)
    await s.waitFor(() => s.events.some(event => event.type === 'turn/completed'))
    await s.session.request('session/revert', { requestId: 'revert', sessionId: 'session', boundary: { turnId: 'native-turn-1', nativeTurnId: 'native-turn-1', relation: 'through' }, scope: 'conversation' })
    const calls = await s.calls()
    const pages = calls.filter(call => call.method === 'thread/turns/list')
    expect(pages).toHaveLength(2)
    expect(pages[1]?.params).toMatchObject({ cursor: 'page-two' })
    expect(calls.some(call => call.method === 'thread/revert')).toBe(true)
  })
  /** Use a fake repeated cursor to require protocol rejection instead of unbounded model pagination; setup owns the probe environment. */
  test('repeating native model cursors fail closed', async () => {
    const s = await setup({ scenario: 'model-loop' })
    expect(await rejectionOf(s.adapter.listModels(s.dir))).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})

/** Register isolated version-process cases without opening sessions; these tests own process fakes while adapters own their disposal. */
describe('version probe', () => {
  /** For version-probe tests, return a deterministic read-only process with a finite stdout or an explicitly stalled stream. Performs no real I/O; the adapter owns disposal and tests may replace its no-op disposer to count cleanup. */
  function fakeProbeProcess({ output, code, stdout = 'finite' }: { output: string; code: number; stdout?: 'finite' | 'stalled' }): HarnessProcess {
    return {
      pid: 4242, owned: true,
      stdout: stdout === 'stalled' ? (async function* () { await new Promise(() => {}) })() : (async function* () { yield new TextEncoder().encode(output); })(),
      stderr: (async function* () {})(),
      exited: Promise.resolve({ code, signal: null }),
      /** Reject attempted writes so probe tests detect any accidental interactive use. */
      async write() { throw new Error('probe process is read-only') },
      async closeInput() {}, async dispose() {},
    }
  }
  /** Initialize against the supplied fake launcher. afterEach owns the adapter even if the probe rejects. */
  function initializeWith({
    processFactory, version, timeoutMs = 2000, clientCapabilities,
  }: Pick<CodexAdapterOptions, 'version' | 'timeoutMs'> & {
    processFactory: NonNullable<CodexAdapterOptions['processFactory']>
    clientCapabilities?: InitializeParams['clientCapabilities']
  }) {
    const adapter = createCodexAdapter({ command: process.execPath, args: ['app-server'], version, timeoutMs, processFactory })
    resources.push(adapter)
    return adapter.initialize({
      protocolVersions: [1], protocolContract: 'native-lifecycle', clientInfo: { name: 'test', version: '1' },
      ...(clientCapabilities && { clientCapabilities }),
    })
  }
  /** Inject finite probe stdout and count cleanup before accepting initialization; app-server arguments must not leak into the version command. */
  test('an unpinned version resolves from a short-lived --version process', async () => {
    let disposals = 0
    const initialized = await initializeWith({
      processFactory: async options => {
        expect(options).toMatchObject({ command: process.execPath, args: ['--version'] })
        const probe = fakeProbeProcess({ output: 'codex-cli 0.164.0 (probe build)\n', code: 0 })
        probe.dispose = async () => { disposals++ }
        return probe
      },
    })
    expect(initialized.runtime.version).toBe('0.164.0')
    expect(disposals).toBe(1)
  })
  /** Inject distinct exit and output-limit failures and require one cleanup each; resource release must not depend on successful version parsing. */
  test('probe failures surface HARNESS_UNAVAILABLE and runaway output fails PROTOCOL_ERROR', async () => {
    for (const [output, code, expectedCode] of [
      ['codex-cli 0.148.0\n', 3, 'HARNESS_UNAVAILABLE'],
      ['x'.repeat(5000) + '\n', 0, 'PROTOCOL_ERROR'],
    ] as const) {
      let disposals = 0
      await expect(initializeWith({
        processFactory: async () => {
          const probe = fakeProbeProcess({ output, code })
          probe.dispose = async () => { disposals++ }
          return probe
        },
      })).rejects.toMatchObject({ code: expectedCode })
      expect(disposals).toBe(1)
    }
  })
  /** Inject a launcher that fails on use so override normalization is proven to bypass process creation, even for unmatched text. */
  test('explicit version overrides normalize suffixes and retain unmatched text without launching a process', async () => {
    for (const [version, expected] of [
      ['codex-cli 0.164.0-dev+build', '0.164.0'],
      ['custom build', 'custom build'],
    ]) {
      const initialized = await initializeWith({
        version,
        processFactory: async () => { throw new Error('Override must bypass process creation') },
      })
      expect(initialized.runtime.version).toBe(expected)
    }
  })
  /** Inject adjacent decoded-text boundary sizes; accepting the exact limit must preserve unknown-version capability fallback without changing the limit unit. */
  test('probe output keeps the exact decoded-text limit and preserves unmatched version text', async () => {
    const accepted = await initializeWith({ processFactory: async () => fakeProbeProcess({ output: 'x'.repeat(4096), code: 0 }) })
    expect(accepted.runtime.version).toBe('x'.repeat(4096))
    expect(accepted.capabilities.session?.resume).toBe(false)
    await expect(initializeWith({ processFactory: async () => fakeProbeProcess({ output: 'x'.repeat(4097), code: 0 }) })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
  /** Inject stalled stdout and a counted disposer; initialization must reject at its deadline and finish cleanup before the rejection is observed. */
  test('a hung probe is bounded by the version timeout', async () => {
    let disposals = 0
    const initialized = initializeWith({
      timeoutMs: 30,
      clientCapabilities: { interactions: [] },
      processFactory: async () => {
        const probe = fakeProbeProcess({ output: '', code: 0, stdout: 'stalled' })
        probe.dispose = async () => { disposals++ }
        return probe
      },
    })
    await expect(initialized).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE', message: 'Codex version probe timed out' })
    expect(disposals).toBe(1)
  })
})
