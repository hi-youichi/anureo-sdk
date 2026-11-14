/** Exercises read-only discovery and connection ownership with fake native transports. */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import type { CatalogProbeEvent } from '@anureo/sdk/diagnostics'
import { createCodexCatalogSession } from '../src/catalog'
import type { NativeRecord } from '../src/native-values'
import { rejectionOf } from './test-helpers'

/** Concurrent preparation must share the process and handshake while repeated reads stay non-interactive; the test owns process disposal and its temporary log directory. */
test('directory refresh reuses one process/handshake and never opens a thread or turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex catalog ')), log = path.join(root, 'calls.jsonl')
  const children: HarnessProcess[] = [], phases: CatalogProbeEvent[] = []
  const session = createCodexCatalogSession({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
    env: { ...process.env, FAKE_LOG_FILE: log },
    /** Launch the existing fake server and retain each owned child so reuse and exit can be asserted. */
    processFactory: async options => { const child = await spawnHarnessProcess(options); children.push(child); return child } })
  try {
    await Promise.all([session.prepare({ onPhase: event => phases.push(event) }), session.prepare()])
    expect((await session.listModels()).some(model => model.id === 'test-model')).toBe(true)
    await session.listModels()
    expect(await session.readAuthStatus()).toBe('ready')
    expect(children).toHaveLength(1)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: unknown })
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'model/list')).toHaveLength(2)
    expect(calls.find(call => call.method === 'account/read')?.params).toEqual({ refreshToken: false })
    expect(calls.some(call => /^(thread|turn)\//.test(call.method))).toBe(false)
    expect(phases.map(event => [event.phase, event.outcome])).toEqual([['spawn', 'started'], ['spawn', 'success'], ['handshake', 'started'], ['handshake', 'success']])
  } finally {
    await session.dispose()
    // Intentionally dispose again to verify repeated disposal completes safely.
    await session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  expect((await children[0]!.exited).code).not.toBeUndefined()
})

/** Cancellation can arrive after process creation but before client publication; preparation must reject and release that otherwise unattached process. */
test('cancellation at spawn completion disposes the just-created process', async () => {
  const abort = new AbortController(); let child: HarnessProcess | undefined
  const session = createCodexCatalogSession({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
    /** Cancel at the launch handoff so the catalog must clean up a child without relying on a client. */
    processFactory: async options => {
      child = await spawnHarnessProcess(options)
      abort.abort() // Cancel after creation, before handing the process to the session.
      return child
    } })
  try {
    await expect(session.prepare({ signal: abort.signal })).rejects.toMatchObject({ code: 'RPC_ABORTED' })
    expect(child).toBeDefined()
    await child!.exited
  } finally { await session.dispose() }
}, 3_000)

/** Supply native reply envelopes over in-memory streams and capture catalog effects; initialize is automatic, undefined leaves an RPC pending. Tests must dispose the session; no OS process is created. */
function scriptedCatalog(reply: (call: NativeRecord) => NativeRecord | undefined) {
  const calls: NativeRecord[] = []
  const children: Array<{ stdout: PassThrough; disposals: number; disposed: Promise<void> }> = []
  const session = createCodexCatalogSession({
    command: 'scripted-codex',
    /** Create a fresh transport per connection, leaving response order under the test's control. */
    processFactory: async () => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      const disposed = Promise.withResolvers<void>()
      const child = { stdout, disposals: 0, disposed: disposed.promise }
      children.push(child)
      const process: HarnessProcess = {
        pid: children.length, owned: true, stdout, stderr,
        exited: Promise.resolve({ code: 0, signal: null }),
        /** Reply only to correlated requests; capture notifications without inventing a native response. */
        async write(chunk) {
          const call = JSON.parse(String(chunk)) as NativeRecord
          calls.push(call)
          if (call.id === undefined) return
          const response = call.method === 'initialize' ? { result: {} } : reply(call)
          if (response) stdout.write(JSON.stringify({ id: call.id, ...response }) + '\n')
        },
        async closeInput() {},
        /** End readers and count ownership release, allowing tests to observe racing cleanup. */
        async dispose() { child.disposals++; stdout.end(); stderr.end(); disposed.resolve() },
      }
      return process
    },
  })
  return { session, calls, children }
}

/** Native EOF must release the completed connection without explicit disposal and let the next read establish its own handshake. */
test('catalog reader EOF releases the process and the next query reconnects', async () => {
  const f = scriptedCatalog(() => ({ result: { data: [] } }))
  try {
    await f.session.prepare()
    const first = f.children[0]!
    first.stdout.end()
    await first.disposed
    expect(first.disposals).toBe(1)
    expect(await f.session.listModels()).toEqual([])
    expect(f.children).toHaveLength(2)
    expect(f.calls.filter(call => call.method === 'initialize')).toHaveLength(2)
  } finally { await f.session.dispose() }
  expect(f.children[1]?.disposals).toBe(1)
})

/** Pagination must retain native order and projection quirks while sending hidden-model and cursor parameters on the same connection. */
test('catalog projects ordered model pages without normalizing optional metadata', async () => {
  const f = scriptedCatalog(call => {
    const params = call.params as NativeRecord
    return { result: params.cursor === 'next' ? {
      data: [{ model: 'second', hidden: true, supportedReasoningEfforts: [], serviceTiers: [] }], nextCursor: '',
    } : {
      data: [{ id: 'first', displayName: '', isDefault: true, hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }, { reasoningEffort: '' }, null],
        defaultReasoningEffort: 'high', serviceTiers: [{ id: '' }, { id: 'priority' }, null] }], nextCursor: 'next',
    } }
  })
  try {
    expect(await f.session.listModels()).toEqual([
      { id: 'first', name: '', isDefault: true, efforts: [{ id: 'high', description: 'Deep' }], defaultEffort: 'high', serviceTiers: ['', 'priority'] },
      { id: 'second', name: 'second', hidden: true, efforts: [], serviceTiers: [] },
    ])
    expect(f.calls.filter(call => call.method === 'model/list').map(call => call.params)).toEqual([
      { limit: 100, includeHidden: true }, { limit: 100, includeHidden: true, cursor: 'next' },
    ])
    expect(f.children).toHaveLength(1)
  } finally { await f.session.dispose() }
})

/** Invalid pages and entries must keep their protocol errors; page decoding must still precede count and cursor validation. */
test('catalog rejects malformed models, cursor cycles and excess models with the original precedence', async () => {
  const entries = Array.from({ length: 10_001 }, () => ({ id: 'model' }))
  for (const [result, code, requests] of [
    [{ data: null }, 'PROTOCOL_ERROR', 1],
    [{ data: [{ id: '', model: 'fallback' }] }, 'PROTOCOL_ERROR', 1],
    [{ data: [], nextCursor: 'loop' }, 'PROTOCOL_ERROR', 2],
    [{ data: entries, nextCursor: 'loop' }, 'MODEL_LIMIT_EXCEEDED', 1],
    [{ data: [...entries, {}], nextCursor: 'loop' }, 'PROTOCOL_ERROR', 1],
  ] as const) {
    const f = scriptedCatalog(() => ({ result }))
    try {
      expect(await rejectionOf(f.session.listModels())).toMatchObject({ code })
      expect(f.calls.filter(call => call.method === 'model/list')).toHaveLength(requests)
    } finally { await f.session.dispose() }
  }
})

/** Aborting one user closes the shared transport and rejects concurrent RPCs; subsequent callers must reconnect after cleanup rather than reuse the disposed client. */
test('query cancellation closes shared users and permits reconnection', async () => {
  const reached = Promise.withResolvers<void>()
  let hold = true
  const f = scriptedCatalog(() => {
    if (hold) { reached.resolve(); return undefined }
    return { result: { data: [] } }
  })
  const abort = new AbortController()
  try {
    await f.session.prepare()
    const first = rejectionOf(f.session.listModels({ signal: abort.signal }))
    const second = rejectionOf(f.session.listModels())
    await reached.promise
    abort.abort()
    expect(await first).toMatchObject({ code: 'RUNTIME_DISPOSED', outcomeUnknown: true })
    expect(await second).toMatchObject({ code: 'RUNTIME_DISPOSED', outcomeUnknown: true })
    hold = false
    expect(await f.session.listModels()).toEqual([])
    expect(f.children).toHaveLength(2)
    expect(f.children[0]?.disposals).toBe(1)
  } finally { await f.session.dispose() }
  expect(f.children[1]?.disposals).toBe(1)
})

test('cancellation from the models phase observer skips the native query', async () => {
  const f = scriptedCatalog(() => ({ result: { data: [] } }))
  const abort = new AbortController()
  const phases: CatalogProbeEvent[] = []
  try {
    await f.session.prepare()
    const failure = await rejectionOf(f.session.listModels({
      signal: abort.signal,
      onPhase: event => {
        phases.push(event)
        if (event.outcome === 'started') abort.abort()
      },
    }))
    expect(failure).toMatchObject({ code: 'RPC_ABORTED' })
    expect(f.calls.some(call => call.method === 'model/list')).toBe(false)
    expect(phases.map(event => [event.phase, event.outcome])).toEqual([
      ['models', 'started'],
      ['models', 'cancelled'],
    ])
  } finally {
    await f.session.dispose()
  }
  expect(f.children[0]?.disposals).toBe(1)
})

/** Concurrent callers must observe one launch failure; explicit disposal after retry must also allow a new preparation instead of permanently closing the catalog. */
test('failed preparation and explicit disposal both allow a fresh connection', async () => {
  let launches = 0
  const session = createCodexCatalogSession({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
    /** Fail only the first launch so the next preparation proves the shared failure was retired. */
    processFactory: async options => {
      if (++launches === 1) throw new Error('launch failed')
      return spawnHarnessProcess(options)
    },
  })
  try {
    const failures = await Promise.all([rejectionOf(session.prepare()), rejectionOf(session.prepare())])
    expect(failures[0]).toBe(failures[1])
    expect(failures[0]).toMatchObject({ message: 'launch failed' })
    expect(launches).toBe(1)
    await session.prepare()
    await Promise.all([session.dispose(), session.dispose()])
    expect(await session.readAuthStatus()).toBe('ready')
    expect(launches).toBe(3)
  } finally { await session.dispose() }
})
