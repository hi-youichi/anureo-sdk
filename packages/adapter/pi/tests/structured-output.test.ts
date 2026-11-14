import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { createClient, type Client, type StructuredOutputToolDefinition } from '@anureo/sdk'
import { createPiAdapter, createPiHost, type PiHostOpenOptions, type PiSessionHost } from '../src'
import { fakeFactory, type FakePiHost } from './fake-host'

type NativeOutputHost = PiSessionHost & Required<Pick<PiSessionHost, 'setOutputTool'>>

const SCHEMA = { type: 'object', properties: { sum: { type: 'integer' } }, required: ['sum'], additionalProperties: false }

test('Pi carries the business schema on a direct tool and normalizes its validated result without MCP', async () => {
  const feedback: unknown[] = []
  const fake = directFactory(async (host, tool) => {
    const output = requireOutputTool(tool)
    feedback.push(await output.execute({}))
    feedback.push(await output.execute({ sum: 42 }))
    feedback.push(await output.execute({ sum: 42 }))
    feedback.push(await output.execute({ sum: 43 }))
    await host.assistant('submitted')
  })
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    expect(session.capabilities.turn?.outputSchema).toBe(true)
    expect(session.capabilities.extensions).toContainEqual({ name: 'x-anureo/structured-output-tool', version: '1' })
    expect(session.capabilities.mcp).toBeUndefined()
    const result = await (await session.submit({ input: '17 + 25', outputSchema: SCHEMA })).result()
    expect(result).toMatchObject({ status: 'completed', text: '{"sum":42}' })
    expect(feedback).toMatchObject([{ accepted: false, error: { code: 'STRUCTURED_OUTPUT_INVALID' } }, { accepted: true }, { accepted: true }, { accepted: false, error: { code: 'STRUCTURED_OUTPUT_ALREADY_SUBMITTED' } }])
    expect(fake.definitions[0]?.schema).toEqual(SCHEMA)
    expect(fake.current).toBeUndefined()
    expect(fake.opens[0]).not.toHaveProperty('mcpServers')
    expect(fake.hosts[0]!.calls.find(call => call.method === 'prompt')?.value).not.toMatch(/MCP|outputId/)
    expect(result.items.filter(item => item.type === 'agentMessage' && item.phase === 'final')).toHaveLength(1)
  })
})

test('one Pi session transitions text → schema A → schema B → text and expires old callbacks', async () => {
  let first: StructuredOutputToolDefinition | undefined
  let stale: unknown
  const fake = directFactory(async (host, tool) => {
    if (tool) {
      if (!first) { first = tool; await tool.execute({ sum: 42 }) }
      else { stale = await first.execute({ sum: 999 }); await tool.execute([1, 2, 3]) }
    }
    await host.assistant('plain answer')
  })
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    expect((await (await session.submit({ input: 'before' })).result()).text).toBe('plain answer')
    expect(fake.definitions).toEqual([])
    expect((await (await session.submit({ input: 'A', outputSchema: SCHEMA })).result()).text).toBe('{"sum":42}')
    expect((await (await session.submit({ input: 'B', outputSchema: { type: 'array', items: { type: 'integer' } } })).result()).text).toBe('[1,2,3]')
    expect(stale).toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_EXPIRED' } })
    expect((await (await session.submit({ input: 'after' })).result()).text).toBe('plain answer')
    expect(fake.current).toBeUndefined()
    expect(fake.definitions.filter(tool => tool !== undefined).map(tool => tool.name)).toEqual(['anureo_submit_result', 'anureo_submit_result'])
  })
})

for (const outcome of ['failed', 'interrupted'] as const) test(`accepted Pi output preserves the real ${outcome} outcome`, async () => {
  const fake = directFactory(async (host, tool) => {
    await requireOutputTool(tool).execute({ sum: 42 })
    await host.assistant('', outcome === 'failed' ? { stopReason: 'error', errorMessage: 'native failed' } : { stopReason: 'aborted' })
  })
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    const result = await (await session.submit({ input: 'work', outputSchema: SCHEMA })).result()
    expect(result.status).toBe(outcome)
    expect(result.text).toBe('')
    expect(fake.current).toBeUndefined()
  })
})

test('Pi keeps a direct output slot until the actual terminal after observation timeout', async () => {
  const { fake, submitted } = heldDirectOutput()
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    const turn = await session.submit({ input: 'work', outputSchema: SCHEMA })
    await submitted
    await expect(turn.result({ timeoutMs: 5 })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(fake.current).toBeDefined()
    await expect(session.submit({ input: 'next' })).rejects.toMatchObject({ code: 'STRUCTURED_OUTPUT_BUSY' })
    fake.hosts[0]!.release!()
    expect(await turn.result()).toMatchObject({ status: 'completed', text: '{"sum":42}' })
    expect(fake.current).toBeUndefined()
  })
})

test('Pi clears a rejected pre-dispatch tool and accepts a later schema', async () => {
  const fake = directFactory(async (host, tool) => {
    await requireOutputTool(tool).execute({ sum: 42 })
    await host.assistant('done')
  })
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    fake.hosts[0]!.promptError = new Error('preflight rejected')
    await expect(session.submit({ input: 'work', outputSchema: SCHEMA })).rejects.toMatchObject({ code: 'PI_SUBMIT_FAILED' })
    expect(fake.current).toBeUndefined()
    fake.hosts[0]!.promptError = undefined
    expect((await (await session.submit({ input: 'retry', outputSchema: SCHEMA })).result()).text).toBe('{"sum":42}')
  })
})

for (const attempts of [0, 3]) test(`Pi reports ${attempts ? 'invalid' : 'missing'} direct output without replay`, async () => {
  const fake = directFactory(async (host, tool) => {
    for (let n = 0; n < attempts; n++) await requireOutputTool(tool).execute({})
    await host.assistant('done')
  })
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    expect(await (await session.submit({ input: 'work', outputSchema: SCHEMA })).result()).toMatchObject({ status: 'failed', error: { code: attempts ? 'STRUCTURED_OUTPUT_RETRIES_EXCEEDED' : 'STRUCTURED_OUTPUT_MISSING' } })
    expect(fake.hosts[0]!.calls.filter(call => call.method === 'prompt')).toHaveLength(1)
  })
})

test('Pi rejects MCP configuration before opening a host', async () => {
  const fake = directFactory(async () => {})
  await withDirectClient(fake.factory, async client => {
    await expect(client.sessions.create({ cwd: process.cwd(), mcpServers: [{ type: 'http', name: 'example', url: 'http://127.0.0.1:1/mcp' }] })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
    expect(fake.opens).toHaveLength(0)
  })
})

test('installed Pi SDK dynamically replaces and disables a direct output tool, preserving permission tools', async () => {
  await withNativeHost({ prefix: 'anureo-pi-output-', tools: ['read'], instructions: 'Test instructions.' }, async (host, native) => {
    expect(native.getActiveToolNames()).toEqual(['read'])
    await host.setOutputTool(outputDefinition({ schema: SCHEMA, result: { accepted: false, error: { code: 'INVALID', message: 'invalid', retryable: false, outcomeUnknown: false } } }))
    expect(native.getAllTools().find(tool => tool.name === 'anureo_submit_result')?.parameters).toEqual(SCHEMA)
    host.setActiveTools(['read', 'bash'])
    expect(native.getActiveToolNames()).toContain('anureo_submit_result')
    const tool = native.agent.state.tools.find(tool => tool.name === 'anureo_submit_result')!
    expect(await tool.execute('invalid', {})).toMatchObject({ isError: true })
    await host.setOutputTool(outputDefinition({ schema: { type: 'array', items: { type: 'integer' } }, result: { accepted: true } }))
    const replacement = native.agent.state.tools.find(tool => tool.name === 'anureo_submit_result')!
    expect(replacement.parameters).toHaveProperty('properties.value.type', 'array')
    expect(await replacement.execute('valid', { value: [1, 2, 3] })).toMatchObject({ terminate: true, details: { accepted: true } })
    expect(native.getAllTools().filter(tool => tool.name === 'anureo_submit_result')).toHaveLength(1)
    await host.setOutputTool()
    expect(native.getActiveToolNames()).toEqual(['read', 'bash'])
    host.setActiveTools(['read'])
    expect(native.getActiveToolNames()).toEqual(['read'])
  })
}, 15_000)

test('the real Pi agent loop invokes the direct tool, preserves raw arguments and terminates on acceptance', async () => {
  await withNativeHost({ prefix: 'anureo-pi-loop-', tools: [] }, async (host, native) => {
    const values: unknown[] = []
    let requests = 0
    await host.setOutputTool({ name: 'anureo_submit_result', description: 'Submit result', schema: SCHEMA,
      async execute(value) {
        values.push(value)
        return typeof (value as { sum: unknown }).sum === 'number' ? { accepted: true } : { accepted: false, error: { code: 'STRUCTURED_OUTPUT_INVALID', message: 'invalid', retryable: false, outcomeUnknown: false } }
      },
    })
    // Exercise the installed SDK's actual argument validation, tool hooks and termination loop.
    // The deterministic stream replaces only the provider network call and requires no credentials.
    const model = { id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } as const
    native.agent.state.model = { ...model, input: ['text'] }
    native.agent.streamFunction = () => {
      if (++requests > 2) throw new Error('Accepted output must end the agent loop')
      return toolStream({ model, id: `call-${requests}`, args: { sum: requests === 1 ? '42' : 42 } })
    }
    await native.agent.prompt('Calculate 17 + 25.')
    expect(requests).toBe(2)
    expect(values).toEqual([{ sum: '42' }, { sum: 42 }])
    expect(native.agent.state.messages.filter(message => message.role === 'toolResult').map(message => message.isError)).toEqual([true, false])
    const roots: Array<{ schema: StructuredOutputToolDefinition['schema']; value: unknown }> = [
      { schema: { type: 'array', items: { $ref: '#/$defs/entry' }, $defs: { entry: { type: 'integer' } } }, value: [1, 2, 3] },
      { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'integer' }], items: false }, value: [42] },
      { schema: { type: 'null' }, value: null },
      { schema: true, value: false },
    ]
    for (const root of roots) await assertRootOutput({ host, native, model, ...root })
  })
}, 15_000)

test('closing a Pi session revokes an accepted direct tool while execution is still active', async () => {
  const { fake, submitted } = heldDirectOutput()
  await withDirectClient(fake.factory, async client => {
    const session = await client.sessions.create({ cwd: process.cwd() })
    await session.submit({ input: 'work', outputSchema: SCHEMA })
    await submitted
    const callback = requireOutputTool(fake.current)
    await session.close()
    expect(fake.current).toBeUndefined()
    expect(fake.hosts[0]!.disposed).toBe(true)
    expect(await callback.execute({ sum: 42 })).toMatchObject({ accepted: false, error: { code: 'STRUCTURED_OUTPUT_EXPIRED' } })
  })
})


test('the real Pi host resolves model and authentication configuration from its explicit agentDir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anureo-pi-agent-dir-'))
  const agentDir = join(dir, 'agent')
  await mkdir(agentDir)
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: {
    'anureo-local-fixture': { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture-model' }] },
  } }))
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'anureo-local-fixture': { type: 'api_key', key: 'test-only-not-a-real-key' } }), { mode: 0o600 })
  try {
    const host = await createPiHost({ cwd: dir, agentDir, model: 'anureo-local-fixture/fixture-model', persist: false, mode: 'new', tools: [] })
    try {
      expect(host.model).toBe('anureo-local-fixture/fixture-model')
      expect((await host.listModels()).map(model => model.ref)).toContain('anureo-local-fixture/fixture-model')
    } finally { await host.dispose() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/**
 * Install a test output port on each host. OutputSession configures it through PiBackendSession
 * before dispatch and clears it during release. The script sees the definition current when the
 * run starts. These tests open one session per factory because the tool slot and log are shared.
 */
function directFactory(script: (host: FakePiHost, tool: StructuredOutputToolDefinition | undefined, text: string) => Promise<void>) {
  let current: StructuredOutputToolDefinition | undefined
  const definitions: Array<StructuredOutputToolDefinition | undefined> = []
  const fake = fakeFactory(host => {
    Object.assign(host, {
      async setOutputTool(tool?: StructuredOutputToolDefinition) {
        current = tool
        definitions.push(tool)
      },
    })
    host.script = (host, text) => script(host, current, text)
  })
  return { ...fake, definitions, get current() { return current } }
}

/** Fail a schema test that reaches tool use without a registered definition. */
function requireOutputTool(tool: StructuredOutputToolDefinition | undefined): StructuredOutputToolDefinition {
  if (!tool) throw new Error('Expected a registered direct output tool')
  return tool
}

/** Signal after submitting valid output, then hold the run for the test to release or close. */
function heldDirectOutput() {
  const submitted = Promise.withResolvers<void>()
  const fake = directFactory(async (host, tool) => {
    await requireOutputTool(tool).execute({ sum: 42 })
    submitted.resolve()
    await host.hold()
  })
  return { fake, submitted: submitted.promise }
}

/** Give the case an SDK client on the verified Pi profile and dispose it after the case settles. */
async function withDirectClient(createHost: ReturnType<typeof directFactory>['factory'], run: (client: Client) => Promise<void>): Promise<void> {
  const client = await createClient({
    adapter: createPiAdapter({ version: '1.5.2', createHost }),
    identity: { adapterId: 'pi', runtimeConfigId: 'direct-tool' },
  })
  try {
    await run(client)
  } finally {
    await client.dispose()
  }
}

/** Run the case against an isolated, nonpersistent Pi SDK session. Dispose the host before removing its directory. */
async function withNativeHost(
  { prefix, ...options }: Pick<PiHostOpenOptions, 'instructions' | 'tools'> & { prefix: string },
  run: (host: NativeOutputHost, native: AgentSession) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const host = await createPiHost({ cwd: dir, agentDir: join(dir, 'agent'), persist: false, mode: 'new', ...options })
  try {
    requireNativeOutput(host)
    await run(host, Reflect.get(host, 'session') as AgentSession)
  } finally {
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

/** Require the output port exposed by the embedded Pi host for these integration cases. */
function requireNativeOutput(host: PiSessionHost): asserts host is NativeOutputHost {
  if (!host.setOutputTool) throw new Error('Expected the embedded Pi host to support direct output')
}

/** Build a fixed-result definition for testing the native tool's feedback and termination mapping. */
function outputDefinition({ schema, result }: {
  schema: StructuredOutputToolDefinition['schema']
  result: Awaited<ReturnType<StructuredOutputToolDefinition['execute']>>
}): StructuredOutputToolDefinition {
  return { name: 'anureo_submit_result', description: 'Submit result', schema, async execute() { return result } }
}

/** Verify the native tool unwraps a root value and terminates the run after one provider call. */
async function assertRootOutput({ host, native, model, schema, value }: {
  host: NativeOutputHost
  native: AgentSession
  model: Parameters<typeof toolStream>[0]['model']
  schema: StructuredOutputToolDefinition['schema']
  value: unknown
}): Promise<void> {
  let submitted: unknown = 'missing'
  let requests = 0
  await host.setOutputTool({
    name: 'anureo_submit_result', description: 'Submit value', schema,
    async execute(value) {
      submitted = value
      return { accepted: true }
    },
  })
  native.agent.streamFunction = () => {
    if (++requests > 1) throw new Error('Output must terminate without another provider call')
    return toolStream({ model, id: 'root-call', args: { value } })
  }
  await native.agent.prompt('Submit the value.')
  expect(submitted).toEqual(value)
  expect(requests).toBe(1)
}

/**
 * Simulate one completed provider tool call. The installed Pi agent loop validates its arguments
 * and invokes the registered tool. Both iteration and result expose the same message.
 */
function toolStream({ model, id, args }: {
  model: { api: 'openai-completions'; provider: string; id: string }
  id: string
  args: Record<string, unknown>
}): ReturnType<AgentSession['agent']['streamFunction']> {
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: Date.now(),
    content: [{ type: 'toolCall', id, name: 'anureo_submit_result', arguments: args }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as const
  return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'toolUse', message } }, async result() { return message } } as unknown as ReturnType<AgentSession['agent']['streamFunction']>
}
