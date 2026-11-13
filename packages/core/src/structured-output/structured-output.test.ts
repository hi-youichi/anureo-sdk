// Exercises native, direct-tool and MCP output integration. Admission and commitment policy remain in production modules.
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AHP_PROTOCOL_CONTRACT, type AhpEvent, type AhpRequestMap, type Capabilities, type McpServer, type SessionOpenParams } from '@anureo/protocol'
import { createClient, HarnessSdkError, type Client, type HarnessAdapter, type SessionEventSink, type StructuredOutputToolDefinition } from '../index'
import { OutputBridgeManager } from './bridge'
import { OUTPUT_TOOL } from './tool'

const disposals: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })
const SCHEMA = { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }
const rawCaps: Capabilities = { turn: { outputSchema: false, inputModalities: ['text'] }, input: { delivery: ['native', 'afterTurn'], steer: { target: 'turn', atomicMatch: true }, interrupt: { targets: ['turn'], reportsPendingInputs: false } }, mcp: { http: true, stdio: true }, compact: true, interactions: ['userInput'] }
/**
 * MCP integration cases await a real client connected with the fixture/manager lease's configuration.
 * Connection failures reject. Successful callers must close the client in finally to release its
 * HTTP transport or stdio process, separately from the fixture's bridge-lease cleanup.
 */
async function connect(config: McpServer) {
  const client = new McpClient({ name: 'harness-fixture', version: '1' })
  const transport = config.type === 'http'
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
    : new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env } as Record<string, string>, stderr: 'pipe' })
  await client.connect(transport)
  return client
}
/** MCP cases and their call helper read the injected fallback instructions here to construct tool envelopes. Return the exact opaque ID or throw when the expected contract is absent. */
function contract(params: AhpRequestMap['input/submit']) {
  const last = params.input.at(-1)
  const outputId = last?.type === 'text' ? last.text.match(/outputId: (anureo_output_[a-f0-9]{48})/)?.[1] : undefined
  if (!outputId) throw new Error('Missing output contract')
  return outputId
}
/**
 * Integration cases await this client/session with a scripted backend and real optional MCP bridge.
 * The backend invokes run before returning its receipt, exercising event-before-binding behavior.
 * Native tool tests inspect the configured definition through tool. afterEach disposes the client,
 * while each test still owns MCP clients and deferred execution gates it creates. Setup failures reject.
 */
async function fixture(run: (params: AhpRequestMap['input/submit'], sink: SessionEventSink, config?: McpServer) => Promise<void>, mode: 'http' | 'stdio' | 'native' | 'tool' = 'http', limits?: Parameters<typeof createClient>[0]['limits']) {
  let opened!: SessionOpenParams, sink!: SessionEventSink
  let tool: StructuredOutputToolDefinition | undefined
  let n = 0, calls = 0
  const adapter: HarnessAdapter = {
    outputBridgeTransport: () => mode === 'http' || mode === 'stdio' ? mode : undefined,
    /** withStructuredOutput.initialize awaits this scripted negotiation. Advertise native schemas only for native-mode cases so the other cases exercise fallback preparation. */
    async initialize() { return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'fixture', version: '1', adapter: 'fixture' }, capabilities: { ...rawCaps, turn: { ...rawCaps.turn, outputSchema: mode === 'native' } } } },
    /** OutputSession.open awaits this fake backend. Retain injected config and the supplied sink so run and tests can publish native events before the receipt. */
    async openSession(params, target) {
      opened = params; sink = target
      return {
        structuredOutputTool: mode === 'tool' ? {
          /** OutputSession awaits this fake native registration before dispatch or cleanup. Retain the exact callback so tests can also invoke stale definitions. */
          async configure(definition) { tool = definition },
        } : undefined,
        binding: params.binding, capabilities: { ...rawCaps, turn: { ...rawCaps.turn, outputSchema: mode === 'native' } },
        /** OutputSession dispatches here after policy setup. Publish a start, await the test's run callback, then return its receipt to exercise late association. run/publication failures reject dispatch. */
        async execute(method, params) {
          if (method === 'session/close') return { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as never
          if (method !== 'input/submit') return { maintenanceId: 'maintenance', status: 'completed' } as never
          calls++
          const input = params as AhpRequestMap['input/submit']
          const turnId = `turn-${++n}`
          await target.emit({ type: 'turn/started', payload: { turnId } })
          await run(input, target, opened.mcpServers?.find(server => server.name === 'anureo_output'))
          return { accepted: true, submissionId: input.submissionId, disposition: 'started', turnId } as never
        },
        /** OutputSession.dispose awaits this fulfilled fake native release. The client/output wrapper owns the real bridge resources used by these cases. */
        async dispose() {},
      }
    },
    /** withStructuredOutput.dispose awaits this fulfilled fake adapter release after session attempts. Real bridge transport cleanup stays with the wrapper. */
    async dispose() {},
  }
  const client: Client = await createClient({ adapter, identity: { adapterId: 'fixture', runtimeConfigId: 'test' }, limits, interactions: { userInput: undefined } })
  disposals.push(() => client.dispose())
  const session = await client.sessions.create({ cwd: process.cwd() })
  return { client, session,
    /** Integration cases read the native-open params here to connect independent clients to the injected bridge. */
    get opened() { return opened },
    /** Integration cases publish independently timed native events/interactions through the sink retained by openSession. */
    get sink() { return sink },
    /** Integration assertions read the number of input dispatch attempts made by the fake backend's execute. */
    get calls() { return calls },
    /** Expose current native tool registration to tool-mode cases, including cleanup removal. */
    get tool() { return tool },
  }
}
/** Integration run callbacks await item then terminal admission through the native sink. The wrapper may hold both until binding. Sink failures reject run, while status selects the simulated native completion outcome. */
async function final(sink: SessionEventSink, turnId: string, text = 'Task done', status: 'completed' | 'failed' | 'interrupted' = 'completed') {
  await sink.emit({ type: 'item/completed', payload: { item: { id: `message:${turnId}`, type: 'agentMessage', phase: 'final', text } } }, { turnId })
  await sink.emit({ type: 'turn/completed', payload: { turnId, status, ...(status === 'failed' ? { error: { code: 'NATIVE_FAILED', message: 'failed', retryable: false, outcomeUnknown: false } } : {}) } })
}

for (const transport of ['http', 'stdio'] as const) test(`${transport} discovers the actual tool and commits a result before a late native binding`, async () => {
  const f = await fixture(async (input, sink, config) => {
    expect(input.outputSchema).toBeUndefined()
    const mcp = await connect(config!)
    try {
      expect((await mcp.listTools()).tools).toEqual([OUTPUT_TOOL])
      expect(await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value: { sum: 42 } } })).not.toHaveProperty('isError', true)
      await final(sink, 'turn-1', 'Natural language must not enter JSON')
    } finally { await mcp.close() }
  }, transport)
  expect(f.session.capabilities.turn?.outputSchema).toBe(true)
  expect(f.session.capabilities.extensions).toContainEqual({ name: 'x-anureo/structured-output-mcp', version: '1' })
  const events: AhpEvent[] = []
  const read = (async () => { for await (const event of f.session.events()) { events.push(event); if (event.type === 'turn/completed') break } })()
  const result = await (await f.session.submit({ input: 'Calculate', outputSchema: SCHEMA })).result()
  await read
  expect(result).toMatchObject({ status: 'completed', text: '{"sum":42}' })
  expect(result.items.filter(item => item.type === 'agentMessage' && item.phase === 'final')).toHaveLength(1)
  expect(events.at(-1)?.type).toBe('turn/completed')
  expect(JSON.stringify(events)).not.toMatch(/anureo_output_[a-f0-9]{48}/)
})

test('validation corrections and structurally equal duplicate results are local to one execution', async () => {
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try {
      /** This correction case awaits each MCP decision for the current input, retaining one identity across candidate retries. Transport failures reject the test callback. */
      const call = (value: unknown) => mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value } })
      expect(await call({ sum: 'bad' })).toHaveProperty('isError', true)
      expect(await call({ sum: 42 })).not.toHaveProperty('isError', true)
      expect(await call({ sum: 42 })).not.toHaveProperty('isError', true)
      expect(await call({ sum: 43 })).toHaveProperty('isError', true)
      for (let n = 0; n < 3; n++) expect(await call({ sum: 'invalid after acceptance' })).toHaveProperty('isError', true)
      await sink.bindSubmission(input.submissionId, 'turn-1')
      await final(sink, 'turn-1')
    } finally { await mcp.close() }
  })
  expect((await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()).text).toBe('{"sum":42}')
  expect(f.calls).toBe(1)
})

test('direct-tool registration precedes dispatch and stale callbacks cannot satisfy a later submission', async () => {
  const firstSent = Promise.withResolvers<void>()
  const firstTerminal = Promise.withResolvers<void>()
  let firstTool: StructuredOutputToolDefinition | undefined
  let dispatches = 0
  const f = await fixture(async (input, sink, config) => {
    expect(config).toBeUndefined()
    expect(input.outputSchema).toBeUndefined()
    const tool = f.tool
    if (!tool) throw new Error('Missing native output tool')
    expect(tool.schema).toEqual(SCHEMA)
    if (++dispatches === 1) {
      firstTool = tool
      expect(await tool.execute({ sum: 'invalid' })).toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_INVALID' } })
      expect(await tool.execute({ sum: 42 })).toEqual({ accepted: true })
      expect(await tool.execute({ sum: 42 })).toEqual({ accepted: true })
      expect(await tool.execute({ sum: 43 })).toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_ALREADY_SUBMITTED' } })
      firstSent.resolve()
      await firstTerminal.promise
    } else {
      if (!firstTool) throw new Error('Missing earlier native output tool')
      expect(await firstTool.execute({ sum: 99 })).toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_EXPIRED' } })
      expect(await tool.execute({ sum: 43 })).toEqual({ accepted: true })
    }
    await final(sink, `turn-${dispatches}`)
    // Bind explicitly to replay the held terminal and disable the tool before the native receipt.
    await sink.bindSubmission(input.submissionId, `turn-${dispatches}`)
    expect(f.tool).toBeUndefined()
    expect(await tool.execute({ sum: 42 })).toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_EXPIRED' } })
  }, 'tool')
  const first = f.session.submit({ input: 'first', outputSchema: SCHEMA })
  try {
    await Promise.race([firstSent.promise, first])
    await expect(f.session.submit({ input: 'concurrent' })).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_BUSY' })
    firstTerminal.resolve()
    expect(await (await first).result()).toMatchObject({ status: 'completed', text: '{"sum":42}' })
    expect(await (await f.session.submit({ input: 'second', outputSchema: SCHEMA })).result()).toMatchObject({ status: 'completed', text: '{"sum":43}' })
  } finally { firstTerminal.resolve() }
})

for (const transport of ['http', 'stdio'] as const) test(`${transport} corrects a mistyped output ID without expiring the task or consuming schema retries`, async () => {
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try {
      const outputId = contract(input)
      const mistyped = outputId.slice(0, -1) + (outputId.endsWith('0') ? '1' : '0')
      for (let n = 0; n < 3; n++) {
        const response = await mcp.callTool({ name: 'submit_result', arguments: { outputId: mistyped, value: { sum: 42 } } })
        expect(response.isError).toBe(true)
        const content = response.content as Array<{ type: string; text: string }>
        const error = JSON.parse(content[0]!.text)
        expect(error.code).toBe('STRUCTURED_OUTPUT_ID_MISMATCH')
        expect(error.message).toMatch(/copy outputId exactly/i)
        expect(JSON.stringify(response)).not.toContain(outputId)
      }
      // Only business-schema failures count toward the three-invalid-value limit.
      for (let n = 0; n < 2; n++) {
        const response = await mcp.callTool({ name: 'submit_result', arguments: { outputId, value: {} } })
        expect(response).toHaveProperty('isError', true)
        expect(JSON.stringify(response)).toContain('STRUCTURED_OUTPUT_INVALID')
        expect(JSON.stringify(response)).not.toContain('STRUCTURED_OUTPUT_RETRIES_EXCEEDED')
      }
      expect(await mcp.callTool({ name: 'submit_result', arguments: { outputId, value: { sum: 42 } } })).not.toHaveProperty('isError', true)
      await sink.bindSubmission(input.submissionId, 'turn-1')
      await final(sink, 'turn-1')
      const expired = await mcp.callTool({ name: 'submit_result', arguments: { outputId, value: { sum: 42 } } })
      expect(expired).toHaveProperty('isError', true)
      expect(JSON.stringify(expired)).toContain('STRUCTURED_OUTPUT_EXPIRED')
    } finally { await mcp.close() }
  }, transport)
  expect(await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()).toMatchObject({ status: 'completed', text: '{"sum":42}' })
  expect(f.calls).toBe(1)
})

test('malformed MCP envelopes receive argument guidance and remain correctable', async () => {
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try {
      const outputId = contract(input)
      for (const args of [
        { value: { outputId, value: { sum: 42 } } },
        { outputId: 42, value: { sum: 42 } },
        { outputId: '', value: { sum: 42 } },
        { outputId },
        { outputId, value: { sum: 42 }, extra: true },
      ]) {
        const response = await mcp.callTool({ name: 'submit_result', arguments: args })
        expect(response).toHaveProperty('isError', true)
        const content = response.content as Array<{ type: string; text: string }>
        const error = JSON.parse(content[0]!.text)
        expect(error.code).toBe('STRUCTURED_OUTPUT_INVALID_ARGUMENTS')
        expect(error.message).toMatch(/top-level arguments/)
      }
      expect(await mcp.callTool({ name: 'submit_result', arguments: { outputId, value: { sum: 42 } } })).not.toHaveProperty('isError', true)
      await final(sink, 'turn-1')
    } finally { await mcp.close() }
  })
  expect(await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()).toMatchObject({ status: 'completed', text: '{"sum":42}' })
  expect(f.calls).toBe(1)
})

test('raw input requests dedupe and sequential schemas use isolated output identities', async () => {
  const ids: string[] = []
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try {
      const id = contract(input); ids.push(id)
      if (ids.length > 1) {
        const stale = await mcp.callTool({ name: 'submit_result', arguments: { outputId: ids[0], value: { sum: 999 } } })
        expect(stale).toHaveProperty('isError', true)
        expect(JSON.stringify(stale)).toContain('STRUCTURED_OUTPUT_ID_MISMATCH')
      }
      await mcp.callTool({ name: 'submit_result', arguments: { outputId: id, value: ids.length === 1 ? { sum: 42 } : false } })
      await final(sink, `turn-${ids.length}`)
    } finally { await mcp.close() }
  })
  const params: AhpRequestMap['input/submit'] = { sessionId: f.session.id, requestId: 'request', submissionId: 'submission', input: [{ type: 'text', text: 'work' }], delivery: 'native', outputSchema: SCHEMA }
  await Promise.all([f.session.request('input/submit', params), f.session.request('input/submit', params)])
  await expect(f.session.request('input/submit', { ...params, input: [{ type: 'text', text: 'changed' }] })).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' })
  const result = await (await f.session.submit({ input: 'false', outputSchema: { type: 'boolean' } })).result()
  expect(result).toMatchObject({ status: 'completed', text: 'false' })
  expect(f.calls).toBe(2)
  expect(new Set(ids).size).toBe(2)
})

for (const status of ['failed', 'interrupted'] as const) test(`an accepted MCP value cannot replace native ${status}`, async () => {
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try { await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value: { sum: 42 } } }); await final(sink, 'turn-1', 'failed', status) }
    finally { await mcp.close() }
  })
  const result = await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()
  expect(result.status).toBe(status)
  expect(result.text).toBe('')
})

test('missing output and exhausted correction budget become failed turns without replay', async () => {
  for (const attempts of [0, 3]) {
    const f = await fixture(async (input, sink, config) => {
      const mcp = await connect(config!)
      try {
        for (let n = 0; n < attempts; n++) await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value: {} } })
        await final(sink, 'turn-1')
      } finally { await mcp.close() }
    })
    expect(await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()).toMatchObject({ status: 'failed', error: { code: attempts ? 'STRUCTURED_OUTPUT_RETRIES_EXCEEDED' : 'STRUCTURED_OUTPUT_MISSING' } })
    expect(f.calls).toBe(1)
  }
})

test('MCP exclusivity survives a timed-out observer and ends only with the real terminal', async () => {
  const sent = Promise.withResolvers<void>()
  let current!: AhpRequestMap['input/submit']
  const f = await fixture(async input => { current = input; sent.resolve() })
  const waiting = f.session.submit({ input: 'work', outputSchema: SCHEMA }, { timeoutMs: 5 })
  // The receipt binds quickly; result observation timeout never releases the lane.
  await sent.promise
  const turn = await waiting
  await expect(turn.result({ timeoutMs: 5 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  await expect(f.session.submit({ input: 'another', outputSchema: SCHEMA })).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_BUSY' })
  await expect(f.session.submit({ input: 'text' })).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_BUSY' })
  const mcp = await connect(f.opened.mcpServers![0]!)
  try { await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(current), value: { sum: 42 } } }); await final(f.sink, turn.id) }
  finally { await mcp.close() }
  expect((await turn.result()).status).toBe('completed')
})

test('native schema validation normalizes finals and rejects malformed JSON without MCP', async () => {
  for (const text of ['{"sum":42}', 'not-json', '{}']) {
    const f = await fixture(async (input, sink, config) => { expect(input.outputSchema).toEqual(SCHEMA); expect(config).toBeUndefined(); await final(sink, 'turn-1', text) }, 'native')
    const result = await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()
    expect(result.status).toBe(text === '{"sum":42}' ? 'completed' : 'failed')
    if (result.status === 'failed') expect(result.error.code).toBe(text === '{}' ? 'STRUCTURED_OUTPUT_INVALID' : 'STRUCTURED_OUTPUT_NOT_JSON')
  }
})

test('invalid schema rejects before backend input and leaves the lane usable', async () => {
  const f = await fixture(async (_input, sink) => final(sink, 'turn-1'))
  await expect(f.session.submit({ input: 'invalid', outputSchema: { $ref: 'https://example.com/schema' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  expect(f.calls).toBe(0)
  expect((await (await f.session.submit({ input: 'ordinary' })).result()).text).toBe('Task done')
})

test('HTTP leases isolate sessions and reject invalid auth/origin; disposal revokes access', async () => {
  const manager = new OutputBridgeManager()
  disposals.push(() => manager.dispose())
  const a = await manager.create('http', async () => ({ content: [{ type: 'text', text: 'a' }] }))
  const b = await manager.create('http', async () => ({ content: [{ type: 'text', text: 'b' }] }))
  if (a.config.type !== 'http' || b.config.type !== 'http') throw new Error('HTTP required')
  expect(new URL(a.config.url).port).toBe(new URL(b.config.url).port)
  expect((await fetch(a.config.url, { method: 'POST' })).status).toBe(401)
  expect((await fetch(a.config.url, { method: 'POST', headers: { ...a.config.headers, Origin: 'https://evil.example' } })).status).toBe(403)
  const client = await connect(b.config)
  try {
    await a.dispose()
    expect((await fetch(a.config.url, { method: 'POST', headers: a.config.headers })).status).toBe(404)
    expect((await client.listTools()).tools[0]?.name).toBe('submit_result')
  } finally { await client.close() }
})

test('the packaged stdio entry runs on Node from an unrelated cwd and exits when its lease is revoked', async () => {
  const manager = new OutputBridgeManager()
  disposals.push(() => manager.dispose())
  const lease = await manager.create('stdio', async () => ({ content: [{ type: 'text', text: 'accepted' }] }))
  if (lease.config.type !== 'stdio') throw new Error('stdio required')
  const transport = new StdioClientTransport({ command: 'node', args: lease.config.args, env: { ...process.env, ...lease.config.env } as Record<string, string>, cwd: '/tmp', stderr: 'pipe' })
  const client = new McpClient({ name: 'node-consumer', version: '1' })
  const closed = Promise.withResolvers<void>()
  try {
    await client.connect(transport)
    expect((await client.listTools()).tools[0]?.name).toBe('submit_result')
    client.onclose = () => closed.resolve()
    await lease.dispose()
    await Promise.race([closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Proxy did not exit after lease revocation')), 6000))])
  } finally { await client.close() }
})

test('marked secrets cannot bypass the public output projection through an accepted MCP value', async () => {
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try { await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value: { sum: 42 } } }); await final(sink, 'turn-1') }
    finally { await mcp.close() }
  })
  const interaction = f.sink.requestInteraction({ interactionId: 'secret', kind: 'userInput', questions: [{ id: 'number', prompt: 'Private number', secret: true }] }, async () => {})
  await f.session.request('interaction/respond', { sessionId: f.session.id, requestId: 'secret-response', interactionId: 'secret', response: { kind: 'userInput', answers: { number: 42 } } })
  await interaction
  const result = await (await f.session.submit({ input: 'work', outputSchema: SCHEMA })).result()
  expect(result).toMatchObject({ status: 'failed', text: '', error: { code: 'STRUCTURED_OUTPUT_REDACTED' } })
  expect(JSON.stringify(result)).not.toContain('"sum":42')
})

test('output budgets bound candidate storage and preserve an observed native terminal', async () => {
  const f = await fixture(async (input, sink, config) => {
    const mcp = await connect(config!)
    try {
      expect(await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value: 'x'.repeat(512) } })).toHaveProperty('isError', true)
      await final(sink, 'turn-1')
    } finally { await mcp.close() }
  }, 'http', { maxResultBytes: 256 })
  expect(await (await f.session.submit({ input: 'work', outputSchema: { type: 'string' } })).result()).toMatchObject({ status: 'failed', error: { code: 'RESULT_BUDGET_EXCEEDED' } })
})

test('a timed-out unbound submission retains its MCP slot until the late binding and terminal', async () => {
  const sent = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let input!: AhpRequestMap['input/submit']
  const f = await fixture(async (params, sink) => { input = params; sent.resolve(); await release.promise; await final(sink, 'turn-1') })
  const events: AhpEvent[] = []
  const reader = (async () => { for await (const event of f.session.events()) { events.push(event); if (event.type === 'turn/completed') break } })()
  const waiting = f.session.submit({ input: 'work', outputSchema: SCHEMA }, { timeoutMs: 5 })
  void waiting.catch(() => {})
  try {
    await sent.promise
    await expect(waiting).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await expect(f.session.submit({ input: 'new' })).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_BUSY' })
    const mcp = await connect(f.opened.mcpServers![0]!)
    try { expect(await mcp.callTool({ name: 'submit_result', arguments: { outputId: contract(input), value: { sum: 42 } } })).not.toHaveProperty('isError', true) }
    finally { await mcp.close() }
    release.resolve(); await reader
    expect(events.at(-1)).toMatchObject({ type: 'turn/completed', payload: { status: 'completed' } })
    expect(events.filter(event => event.type === 'item/completed' && event.payload.item.type === 'agentMessage' && event.payload.item.phase === 'final')).toHaveLength(1)
    expect(f.calls).toBe(1)
  } finally { release.resolve() }
})
