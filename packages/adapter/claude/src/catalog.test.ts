import { expect, test } from 'bun:test'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeCatalogSession } from './index'
import type { ClaudeQuery } from './options'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('directory Query stays resident, reinitializes models and receives no prompt', async () => {
  let queries = 0, handshakes = 0, refreshed = 0, inputs = 0, closed = 0
  let settings: Options | undefined
  const stream = { supportedModels: async () => { handshakes++; return [{ value: 'initial', displayName: 'Initial', description: '' }] },
    reinitialize: async () => { refreshed++; return { models: [{ value: 'updated', displayName: 'Updated', description: '' }] } }, close: () => { closed++ } } as unknown as ClaudeQuery
  const session = createClaudeCatalogSession({ queryFactory: ({ options, prompt }) => {
    queries++; settings = options
    void (async () => { for await (const _input of prompt as AsyncIterable<SDKUserMessage>) inputs++ })()
    return stream
  } })
  try {
    await Promise.all([session.prepare(), session.prepare()])
    expect((await session.listModels())[0]?.value).toBe('initial')
    expect((await session.listModels())[0]?.value).toBe('updated')
    expect({ queries, handshakes, refreshed, inputs }).toEqual({ queries: 1, handshakes: 1, refreshed: 1, inputs: 0 })
    expect(settings).toMatchObject({ persistSession: false, enableFileCheckpointing: false, mcpServers: {}, settingSources: [] })
    expect(settings?.sessionStore).toBeUndefined()
  } finally { await session.dispose(); await session.dispose() }
  expect(closed).toBe(1)
})

test('cancellation during Query creation closes it without submitting a message', async () => {
  const abort = new AbortController(); let closed = 0
  const session = createClaudeCatalogSession({ queryFactory: () => { abort.abort(); return { close: () => { closed++ } } as ClaudeQuery } })
  await expect(session.prepare({ signal: abort.signal })).rejects.toMatchObject({ code: 'RPC_ABORTED' })
  await session.dispose(); expect(closed).toBe(1)
})

test('the pinned SDK refreshes a real external directory process without user input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude catalog actual ')), log = join(root, 'calls.jsonl')
  const session = createClaudeCatalogSession({ command: fileURLToPath(new URL('../tests/fixtures/fake-claude.mjs', import.meta.url)), executableRuntime: 'node', stateDir: join(root, 'state'), env: { FAKE_CATALOG_LOG: log } })
  try {
    expect((await session.listModels())[0]?.value).toBe('catalog-1')
    expect((await session.listModels())[0]?.value).toBe('catalog-2')
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string })
    expect(calls.filter(call => call.type === 'control_request')).toHaveLength(2)
    expect(calls.some(call => call.type === 'user')).toBe(false)
  } finally { await session.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
}, 10_000)

test('older SDKs without reinitialize rebuild a fresh directory Query to refresh models', async () => {
  let queries = 0, closes = 0
  const session = createClaudeCatalogSession({ queryFactory: ({ prompt }) => {
    queries++
    void (async () => { for await (const _input of prompt as AsyncIterable<SDKUserMessage>) {} })().catch(() => {})
    return { supportedModels: async () => [{ value: `model-${queries}`, displayName: `M${queries}`, description: '' }], close: () => { closes++ } } as unknown as ClaudeQuery
  } })
  try {
    expect((await session.listModels())[0]?.value).toBe('model-1')
    expect((await session.listModels())[0]?.value).toBe('model-2')
    expect([queries, closes]).toEqual([2, 1])
  } finally { await session.dispose() }
})

test('an aborted probe disposes the live directory connection', async () => {
  const controller = new AbortController()
  const pendingProbeRejectors: Array<() => void> = []
  const session = createClaudeCatalogSession({
    queryFactory: ({ prompt }) => {
      void (async () => { for await (const _input of prompt as AsyncIterable<SDKUserMessage>) {} })().catch(() => {})
      // Keep probes pending until close rejects them, making connection closure observable.
      return {
        supportedModels: () => {
          return new Promise((_resolve, reject) => {
            pendingProbeRejectors.push(() => reject(new Error('probe closed')))
          })
        },
        close: () => {
          for (const rejectPendingProbe of pendingProbeRejectors) {
            rejectPendingProbe()
          }
        },
      } as unknown as ClaudeQuery
    },
  })
  try {
    const pending = session.listModels({ signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toThrow('probe closed')
  } finally { await session.dispose().catch(() => {}) }
})

test('spawn failures dispose the half-opened connection before surfacing', async () => {
  const session = createClaudeCatalogSession({ queryFactory: () => { throw new Error('spawn failed') } })
  await expect(session.listModels()).rejects.toThrow('spawn failed')
  await expect(session.listModels()).rejects.toThrow('spawn failed')
  await session.dispose()
})

test('disposal ends input, shares the native return wait and allows later discovery', async () => {
  let queries = 0, closes = 0, disposed = false
  let releaseReturn = () => {}, notifyReturn = () => {}
  const returnGate = new Promise<void>(resolve => { releaseReturn = resolve })
  const returnStarted = new Promise<void>(resolve => { notifyReturn = resolve })
  const pendingInputs: Array<Promise<IteratorResult<SDKUserMessage>>> = []
  const session = createClaudeCatalogSession({ queryFactory: ({ prompt }) => {
    const id = ++queries
    pendingInputs.push((prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next())
    return {
      supportedModels: async () => [{ value: `model-${id}`, displayName: `M${id}`, description: '' }],
      close: () => { closes++ },
      return: async () => {
        notifyReturn()
        await returnGate
        return { done: true, value: undefined }
      },
    } as unknown as ClaudeQuery
  } })
  try {
    await session.prepare()
    const pendingDispose = session.dispose()
    expect(session.dispose()).toBe(pendingDispose)
    void pendingDispose.then(() => { disposed = true })
    await returnStarted
    expect(await pendingInputs[0]).toEqual({ done: true, value: undefined })
    expect(closes).toBe(1)
    expect(disposed).toBe(false)

    releaseReturn()
    await pendingDispose
    expect((await session.listModels())[0]?.value).toBe('model-2')
    expect(queries).toBe(2)
  } finally { releaseReturn(); await session.dispose() }
  expect(closes).toBe(2)
  expect(await pendingInputs[1]).toEqual({ done: true, value: undefined })
})

test('a refresh failure awaits cleanup and surfaces a native return failure before retry', async () => {
  const refreshFailure = new Error('refresh failed'), cleanupFailure = new Error('cleanup failed')
  let queries = 0, closes = 0, returns = 0
  const session = createClaudeCatalogSession({ queryFactory: () => {
    const id = ++queries
    return {
      supportedModels: async () => [{ value: `model-${id}`, displayName: `M${id}`, description: '' }],
      reinitialize: async () => { throw refreshFailure },
      close: () => { closes++ },
      return: async () => {
        returns++
        if (id === 1) throw cleanupFailure
        return { done: true, value: undefined }
      },
    } as unknown as ClaudeQuery
  } })
  try {
    expect((await session.listModels())[0]?.value).toBe('model-1')
    await expect(session.listModels()).rejects.toBe(cleanupFailure)
    expect({ closes, returns }).toEqual({ closes: 1, returns: 1 })
    expect((await session.listModels())[0]?.value).toBe('model-2')
  } finally { await session.dispose() }
})
