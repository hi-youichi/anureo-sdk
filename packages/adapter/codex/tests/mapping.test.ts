/** Guards mapping contracts for native input, output, unknown data and redaction. */
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { itemStatus, json, mapItems, mapTurnError, mapUsage, nativeInput, safe } from '../src/mapping'
import { record, string } from '../src/native-values'

describe('native input mapping', () => {
  /** Assert mixed-block ordering and URL precedence without requiring the mentioned file to exist. */
  test('text, inline images, remote images and file mentions map to native records', () => {
    const file = new URL('file:///C:/work/dir/readme.md')
    expect(nativeInput([
      { type: 'text', text: 'inspect this' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'image', data: 'c2Vjb25k', mimeType: 'image/png', url: 'https://images.test/pic.png' },
      { type: 'file', uri: file.href },
    ])).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' },
      { type: 'image', url: 'https://images.test/pic.png' },
      { type: 'mention', path: fileURLToPath(file.href), name: 'readme.md' },
    ])
  })
  /** Unsupported sources must fail at translation, before any runtime can receive a partial input list. */
  test('non-file URIs are rejected before reaching the native runtime', () => {
    expect(() => nativeInput([{ type: 'file', uri: 'https://example.test/report' }])).toThrow('Codex file input requires a file URI')
  })

  /** Empty explicit fields are intentional, while invalid file URLs must retain the URL parser's failure. */
  test('explicit empty names and image URLs survive while malformed file URLs throw', () => {
    const uri = 'file:///C:/tmp/unopened'
    expect(nativeInput([
      { type: 'file', uri, name: '' },
      { type: 'image', url: '', data: 'ignored', mimeType: 'image/png' },
    ])).toEqual([
      { type: 'mention', path: fileURLToPath(uri), name: '' },
      { type: 'image', url: '' },
    ])
    expect(() => nativeInput([{ type: 'file', uri: 'file:///C:/tmp/invalid%2Fpath' }])).toThrow()
  })
})

describe('native item status vocabulary', () => {
  /** Both native denial spellings must stay distinguishable from failures for approval UI callers. */
  test('every denial word maps to declined', () => {
    expect(itemStatus('declined', false)).toBe('declined')
    expect(itemStatus('denied', false)).toBe('declined')
  })
})

describe('native userMessage content projection', () => {
  test('absolute file mentions round-trip with their name and escaped path', () => {
    const file = { type: 'file' as const, uri: 'file:///C:/work/notes%20%23.txt', name: 'Notes' }
    const [item] = mapItems({ id: 'user', type: 'userMessage', content: nativeInput([file]) }, true, true)
    if (item.type !== 'userMessage') throw new Error('unexpected item type')
    expect(item.content).toEqual([file])
  })
  /** Typed attachments and placeholders must preserve their positions without reading local image paths. */
  test('remote images, local images and unsupported blocks stay typed', () => {
    const [item] = mapItems({ id: 'u1', type: 'userMessage', content: [
      { type: 'text', text: 'see attached' },
      { type: 'image', url: 'https://images.test/chart.png' },
      { type: 'localImage', path: '/tmp/scratch/chart.png' },
      { type: 'futureBlock', anything: true },
    ] }, true)
    if (item.type !== 'userMessage') throw new Error('unexpected item type')
    expect(item.content).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'image', url: 'https://images.test/chart.png' },
      { type: 'file', uri: '/tmp/scratch/chart.png' },
      { type: 'text', text: '[unsupported native input]' },
    ])
  })
})

/** Explicit receiver order and per-agent state take priority over the parent envelope, including legacy state fields and duplicate receivers. */
test('collaboration expansion preserves identities, ordering and its own state vocabulary', () => {
  const items = mapItems({
    id: 'parent', type: 'collabToolCall', status: 'failed', prompt: '',
    receiverThreadIds: ['b', 1, 'a', 'b', 'c', 'd'],
    agentsStates: {
      a: { state: 'completed' },
      b: { status: 'cancelled', state: 'completed' },
      c: { status: 'declined' },
    },
  }, true)
  expect(items).toEqual([
    { id: 'parent:b', parentItemId: 'parent', type: 'subagent', subagentId: 'b', state: 'running', status: 'failed', task: '' },
    { id: 'parent:a', parentItemId: 'parent', type: 'subagent', subagentId: 'a', state: 'completed', status: 'failed', task: '' },
    { id: 'parent:b', parentItemId: 'parent', type: 'subagent', subagentId: 'b', state: 'running', status: 'failed', task: '' },
    { id: 'parent:c', parentItemId: 'parent', type: 'subagent', subagentId: 'c', state: 'running', status: 'failed', task: '' },
    { id: 'parent:d', parentItemId: 'parent', type: 'subagent', subagentId: 'd', state: 'failed', status: 'failed', task: '' },
  ])
  expect(mapItems({ id: 'fallback', type: 'collabAgentToolCall', receiverThreadIds: [null], agentsStates: { z: {}, a: {} } }, false, true))
    .toEqual([
      { id: 'fallback:z', parentItemId: 'fallback', type: 'subagent', subagentId: 'z', state: 'running' },
      { id: 'fallback:a', parentItemId: 'fallback', type: 'subagent', subagentId: 'a', state: 'running' },
    ])
})

/** Timing overrides can intentionally suppress invalid native data; history status depends on field presence rather than truthiness. */
test('metadata preserves nullish timing fallback and explicit unknown history status', () => {
  const native = { id: 'timed', type: 'agentMessage', startedAtMs: 1000, durationMs: 0, status: null }
  expect(mapItems(native, true, true, { startedAtMs: null })[0]).toMatchObject({
    status: 'completed', startedAt: '1970-01-01T00:00:01.000Z', durationMs: 0,
  })
  expect(mapItems(native, false, true, { startedAtMs: 'invalid' })[0]).not.toHaveProperty('startedAt')
  expect(() => mapItems({ type: 'agentMessage' }, true)).toThrow('Native item lacks identity')
})

/** Attachment identity must suppress inline bytes; viewing an image must never claim that its result was generated. */
test('image projection omits unsupplied fields and retains safe failure output', () => {
  const [generated] = mapItems({
    id: 'g', type: 'imageGeneration', fileId: 'attachment', result: 'ignored',
    savedPath: '', path: '/ignored', failure: { apiKey: 'secret', reason: 'failed' },
  }, true)
  expect(generated).toEqual({
    id: 'g', status: 'completed', type: 'toolCall', kind: 'image', nativeType: 'imageGeneration', title: 'Image', input: null,
    image: { kind: 'generated', fileId: 'attachment' },
    output: { failure: { apiKey: '[redacted]', reason: 'failed' } },
  })
  const [viewed] = mapItems({ id: 'v', type: 'imageView', result: 'ignored' }, false)
  expect(viewed).toMatchObject({ image: { kind: 'view' } })
  expect(viewed).not.toHaveProperty('image.data')
})

/** Missing tool names and explicit empty names differ; falsy native output still wins over a fallback field. */
test('tool projections keep empty titles, optional names and falsy output', () => {
  const [dynamic] = mapItems({ id: 'd', type: 'dynamicToolCall', tool: '', contentItems: false, result: 'ignored' }, true)
  expect(dynamic).toMatchObject({ title: '', output: false })
  expect(dynamic).not.toHaveProperty('toolName')
  expect(mapItems({ id: 'm', type: 'mcpToolCall', server: '', tool: '', result: 0, error: 'ignored' }, true)[0])
    .toMatchObject({ mcp: { server: '', tool: '' }, title: '/', output: 0 })
})

test.each([false, true])('tool projections keep execution evidence in live and history items (history=%s)', history => {
  const [command] = mapItems({
    id: 'command', type: 'commandExecution', command: 'test', status: 'failed',
    cwd: '/work', exitCode: 2, signal: 'SIGTERM', aggregatedOutput: 'original output',
  }, true, history)
  expect(command).toMatchObject({
    status: 'failed', output: 'original output',
    extensions: { toolExecution: { cwd: '/work', exitCode: 2, signal: 'SIGTERM' } },
  })

  const [fileChange] = mapItems({ id: 'edit', type: 'fileChange', changes: [], error: 'patch rejected' }, true, history)
  expect(fileChange.extensions).toEqual({ toolExecution: { error: { kind: 'tool', message: 'patch rejected' } } })
  const [dynamic] = mapItems({ id: 'dynamic', type: 'dynamicToolCall', success: false }, true, history)
  expect(dynamic.extensions).toEqual({ toolExecution: { success: false } })

  const [empty] = mapItems({ id: 'empty', type: 'commandExecution', exitCode: 0.5, success: 'true' }, true, history)
  expect(empty).not.toHaveProperty('extensions')
  expect(empty.status).toBe(history ? undefined : 'completed')
})

test.each([false, true])('MCP items keep the result, separate error and descriptive metadata (history=%s)', history => {
  const result = { content: [{ type: 'text', text: 'partial result' }] }
  const [item] = mapItems({
    id: 'mcp', type: 'mcpToolCall', server: 'documents', tool: 'lookup', status: 'failed', result,
    error: { message: 'permission denied', trace: 'private trace' },
    toolDisplay: { title: 'Lookup documents', invoking: 'Finding documents', secret: 'private label' },
    toolDefinition: {
      title: 'Find documents',
      _meta: { 'openai/toolInvocation/invoked': 'Found documents', unrelated: 'private metadata' },
    },
    appContext: { connectorId: 'connector_documents', appName: 'Documents', resourceUri: 'ui://documents/previous' },
    mcpAppUi: { resourceUri: 'ui://documents/result', preferredModelDisplayMode: 'inline' },
    mcpAppResourceUri: 'ui://documents/legacy',
    pluginId: 'documents-plugin',
    logoUrl: 'https://images.test/documents.png?token=private-query',
    logoDarkUrl: 'https://user:private-password@images.test/documents.png',
    source: { kind: 'connector', backend: 'documents', url: 'https://example.test/tools#private-fragment' },
  }, true, history)

  expect(item).toMatchObject({ type: 'toolCall', mcp: { server: 'documents', tool: 'lookup' }, output: result })
  expect(item.extensions).toEqual({
    toolExecution: { error: { kind: 'protocol', message: 'permission denied' } },
    mcp: {
      display: { title: 'Lookup documents', invoking: 'Finding documents', invoked: 'Found documents' },
      toolTitle: 'Find documents', connectorId: 'connector_documents', appName: 'Documents',
      resourceUri: 'ui://documents/result', isAppWidget: true, pluginId: 'documents-plugin',
      logoUrl: 'https://images.test/documents.png',
      source: { kind: 'connector', backend: 'documents', url: 'https://example.test/tools' },
    },
  })
})

test('MCP items accept legacy widget URIs and omit empty display data', () => {
  const item = { id: 'mcp', type: 'mcpToolCall', server: 'documents', tool: 'lookup' }
  expect(mapItems(item, true)[0]).not.toHaveProperty('extensions')
  expect(mapItems({ ...item, appContext: { resourceUri: 'ui://documents/older' } }, true)[0].extensions)
    .toEqual({ mcp: { resourceUri: 'ui://documents/older', isAppWidget: true } })
  expect(mapItems({ ...item, mcpAppResourceUri: 'ui://documents/legacy' }, true)[0].extensions)
    .toEqual({ mcp: { resourceUri: 'ui://documents/legacy', isAppWidget: true } })
})

/** Coercion must leave field validation to callers; sanitization clones native data and must not hide serialization failures. */
test('native value helpers preserve unknown handling, cloning, redaction and JSON errors', () => {
  const source = { nested: { apiKey: 'secret', value: 1 } }
  expect(record(source)).toBe(source)
  for (const value of [null, undefined, [], 0, 'text']) expect(record(value)).toEqual({})
  expect(string('')).toBe('')
  expect(string(1)).toBeUndefined()
  expect(json(undefined)).toBeNull()
  expect(json(source)).toEqual(source)
  expect(json(source)).not.toBe(source)
  expect(JSON.stringify(safe(source))).not.toContain('secret')
  expect(source.nested.apiKey).toBe('secret')
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(() => safe(circular)).toThrow(TypeError)
  expect(() => json(1n)).toThrow(TypeError)
  expect(() => json(() => undefined)).toThrow(SyntaxError)
  expect(() => mapItems({ id: 'unknown', type: 'future', payload: circular }, true)).toThrow(TypeError)
})

/** Usage cannot infer omitted totals, coerce strings or clamp invalid counters into apparently measured zeroes. */
test('usage keeps only finite nonnegative counters and retains the requested scope', () => {
  expect(mapUsage({ inputTokens: 0, outputTokens: 1.5, cachedInputTokens: '2', cacheWriteInputTokens: -1, totalTokens: Infinity }, 'session'))
    .toEqual({ provider: 'codex', scope: 'session', source: 'native', input: 0, output: 1.5 })
  expect(mapUsage({ cacheWriteInputTokens: 0 })).toMatchObject({ cacheWrite: 0 })
  for (const value of [null, [], { inputTokens: NaN }]) {
    expect(mapUsage(value)).toEqual({ provider: 'codex', scope: 'turn', source: 'native' })
  }
})

/** Register subagent lifecycle projections: subAgentActivity kinds, documented singular legacy wire words and per-agent terminal messages. */
test('subAgentActivity projects lifecycle kinds into the subagent vocabulary with sanitized evidence', () => {
  expect(mapItems({ id: 'a', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/scout', model: 'gpt-test', reasoningEffort: 'low' }, true)[0])
    .toMatchObject({ type: 'subagent', subagentId: 'child-1', state: 'running', name: 'scout', extensions: { native: { kind: 'started', agentPath: '/root/scout', model: 'gpt-test', reasoningEffort: 'low' } } })
  expect(mapItems({ id: 'b', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'c', agentPath: '/root' }, false)[0])
    .toMatchObject({ type: 'subagent', state: 'running', name: 'root' })
  expect(mapItems({ id: 'i', type: 'subAgentActivity', kind: 'interrupted', agentThreadId: 'c2' }, true)[0])
    .toMatchObject({ state: 'interrupted' })
  expect(mapItems({ id: 'd', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'c3' }, true)[0])
    .toMatchObject({ state: 'completed' })
  expect(() => mapItems({ id: 'e', type: 'subAgentActivity', kind: 'completed' }, true)).toThrow('Native subagent activity lacks agent identity')
})

test('documented singular collab wire words expand with dedupe and global status fallback', () => {
  const solo = mapItems({ id: 'legacy', type: 'collabToolCall', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'parent', receiverThreadId: 'solo', newThreadId: 'solo', prompt: 'do it', agentStatus: 'errored' }, true)[0]
  expect(solo).toEqual({ id: 'legacy:solo', parentItemId: 'legacy', type: 'subagent', subagentId: 'solo', state: 'failed', status: 'running', task: 'do it', extensions: { native: { tool: 'spawnAgent', senderThreadId: 'parent' } } })
  const pair = mapItems({ id: 'pair', type: 'collabToolCall', status: 'completed', senderThreadId: 'p', receiverThreadId: 'one', newThreadId: 'two', agentStatus: 'running' }, true)
  expect(pair.map(item => item.subagentId)).toEqual(['one', 'two'])
  expect(pair.every(item => item.state === 'running')).toBe(true)
})

test('per-agent terminal messages land in sanitized extensions by outcome', () => {
  const [failed] = mapItems({ id: 'x', type: 'collabAgentToolCall', status: 'completed', receiverThreadIds: ['c1'], agentsStates: { c1: { status: 'errored', message: 'child exploded' } } }, true)
  expect(failed).toMatchObject({ type: 'subagent', subagentId: 'c1', state: 'failed', extensions: { native: { errorMessage: 'child exploded' } } })
  const [done] = mapItems({ id: 'y', type: 'collabAgentToolCall', status: 'completed', receiverThreadIds: ['c2'], agentsStates: { c2: { status: 'completed', message: 'final answer' } } }, true)
  expect(done).toMatchObject({ state: 'completed', extensions: { native: { resultMessage: 'final answer' } } })
  const [live] = mapItems({ id: 'z', type: 'collabAgentToolCall', status: 'failed', receiverThreadIds: ['c3'] })
  expect(live).toMatchObject({ state: 'failed', status: 'failed' })
})

/** Connection evidence survives invalid status, but provider text and unrecognized object categories cannot determine a public error. */
test('turn error evidence uses native entry order and validates HTTP status without disclosure', () => {
  expect(mapTurnError({ codexErrorInfo: {
    responseStreamDisconnected: { httpStatusCode: 403 }, httpConnectionFailed: { httpStatusCode: 401 },
  } })).toMatchObject({ code: 'AUTH_FORBIDDEN', retryable: false, details: { httpStatusCode: 403 } })
  for (const httpStatusCode of [undefined, null, '401', 99, 600, 401.5, NaN, Infinity]) {
    expect(mapTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode } }, message: 'secret' }))
      .toEqual({ code: 'NATIVE_CONNECTION_FAILED', message: 'Codex connection to the model service failed', retryable: true, outcomeUnknown: false })
  }
  for (const codexErrorInfo of ['secret', { usageLimitExceeded: {} }, [], null]) {
    expect(mapTurnError({ codexErrorInfo, message: 'secret' }))
      .toEqual({ code: 'NATIVE_TURN_FAILED', message: 'Codex turn failed', retryable: false, outcomeUnknown: false })
  }
})
