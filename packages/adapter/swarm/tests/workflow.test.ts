import { expect, test } from 'bun:test'
import { createClient, HarnessSdkError, type Client, type HarnessAdapter, type SessionMethod } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, type AhpRequestMap, type AhpResultMap, type Capabilities, type SessionOpenParams } from '@anureo/protocol'
import { createSwarmAdapter, parseSwarmWorkflowOptions } from '../src'
import { beer } from '../src/workflow'
import { agent, parallel } from '@anureo/workflow'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = process.cwd()

/** In-test fake backend mirroring swarm.test.ts: respond decides every member/main answer. */
async function fixture(
  respond: (input: string, structured: boolean, prior: readonly string[], params: SessionOpenParams) => string | Promise<string>,
) {
  const opened: SessionOpenParams[] = []
  const submitted: string[] = []
  const capabilities: Capabilities = { input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } }, turn: { inputModalities: ['text'], outputSchema: true } }
  let nextTurn = 0
  const adapter: HarnessAdapter = {
    async initialize() { return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: 'backend', version: '1', adapter: 'backend' }, capabilities } },
    async openSession(params, sink) {
      opened.push(params)
      const prior: string[] = []
      return {
        binding: { ...params.binding, nativeRef: { provider: 'backend', value: params.binding.sessionId } }, capabilities,
        async execute<M extends SessionMethod>(method: M, request: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
          if (method === 'session/close') return { closed: true, observationClosed: true, executionStopped: 'confirmed' } as AhpResultMap[M]
          if (method !== 'input/submit') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
          const { input, submissionId, outputSchema: schema } = request as AhpRequestMap['input/submit']
          const prompt = input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          const answer = await respond(prompt, !!schema, prior, params)
          submitted.push(prompt)
          prior.push(prompt)
          const turnId = `backend-turn-${++nextTurn}`
          const scope = { turnId }
          await sink.emit({ type: 'turn/started', payload: { ...scope, nativeTurnId: `native-${turnId}` } })
          const item = { id: `reused-${turnId}`, type: 'agentMessage' as const, phase: 'final' as const }
          await sink.emit({ type: 'item/started', payload: { item: { ...item, text: '' } } }, scope)
          await sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: answer } }, scope)
          await sink.emit({ type: 'item/completed', payload: { item: { ...item, text: answer } } }, scope)
          await sink.emit({ type: 'turn/completed', payload: { ...scope, status: 'completed' } })
          await sink.bindSubmission(submissionId, turnId)
          return { submissionId, disposition: 'dispatched' } as AhpResultMap[M]
        },
        async dispose() {},
      }
    },
    async dispose() {},
  }
  const client = await createClient({ adapter, identity: { adapterId: 'backend', runtimeConfigId: 'workflow-test' } })
  return { client, opened, submitted }
}

/** Answer with `done: <task>` by parsing the assignment JSON members receive. */
const echoTask = (log: string[], prefix = 'done: ') => async (input: string) => {
  const line = input.split('\n').find(candidate => candidate.startsWith('{'))
  const task = line ? (JSON.parse(line) as { task: string }).task : input
  log.push(task)
  return prefix + task
}

const memberServer = (params: SessionOpenParams) => {
  const config = params.mcpServers?.find(server => server.name === 'anureo-swarm-member' && server.type === 'http')
  if (!config || config.type !== 'http') throw new Error('member server missing')
  return config
}

const management = (params: SessionOpenParams) => {
  const config = params.mcpServers?.find(server => server.name === 'anureo-swarm' && server.type === 'http')
  if (!config || config.type !== 'http') throw new Error('management server missing')
  return config
}

async function withMcp(config: { url: string; headers?: Record<string, string> }, body: (call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<void>) {
  const client = new McpClient({ name: 'workflow-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }))
  try {
    await body(async (name, args) => {
      const result = await client.callTool({ name, arguments: args ?? {} })
      const text = (result.content as { type: string; text?: string }[]).find(block => block.type === 'text')?.text ?? ''
      if (result.isError) throw new Error(text)
      return JSON.parse(text) as Record<string, unknown>
    })
  } finally { await client.close() }
}

const swarmClient = (backend: Client, workflows: Parameters<typeof createSwarmAdapter>[0]['workflows']) =>
  createClient({ adapter: createSwarmAdapter({ backend, workflows }), identity: { adapterId: 'swarm', runtimeConfigId: 'workflow-test' } })

test('host directive runs workflow steps as bees with journaled results and nested items', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-workflow-'))
  const tasks: string[] = []
  const backend = await fixture(echoTask(tasks))
  const client = await swarmClient(backend.client, {
    registrations: [{
      id: 'gather', description: 'Two step gather', revision: '1',
      run: async (args: { n: number }, ctx) => {
        const first = await beer(`first step ${args.n}`, { client: ctx.client, cwd: ctx.cwd })
        const second = await beer('second step', { client: ctx.client, cwd: ctx.cwd, instructions: 'Be concise.' })
        return { first, second }
      },
    }],
    journalDirectory: directory,
  })
  const session = await client.sessions.create({ cwd })
  const result = await (await session.submit({ input: '/workflow run gather {"n":7}' })).result({ timeoutMs: null })
  expect(result.status).toBe('completed')
  const payload = JSON.parse(result.text!) as { runId: string; status: string; steps: { started: number; settled: number; queued: number }; result: string }
  expect(payload.status).toBe('completed')
  expect(payload.steps).toEqual({ started: 2, settled: 2, queued: 0 })
  expect(JSON.parse(payload.result)).toEqual({ first: 'done: first step 7', second: 'done: second step' })
  expect(tasks).toEqual(['first step 7', 'second step'])
  const subagents = result.items.filter(item => item.type === 'subagent')
  expect(subagents).toHaveLength(2)
  expect(subagents.every(item => (item as { extensions?: { swarm?: { workflow?: { runId: string; depth: number } } } }).extensions?.swarm?.workflow?.runId === payload.runId)).toBe(true)
  expect((await readdir(join(directory, payload.runId))).sort()).toEqual(['journal.json', 'result.json', 'run.json'])
  await client.dispose()
})

test('steps queue behind the concurrency limit and pooled bees reuse one member session', async () => {
  const tasks: string[] = []
  const backend = await fixture(echoTask(tasks))
  const client = await swarmClient(backend.client, {
    registrations: [{
      id: 'pair', description: 'Parallel pair', revision: '1',
      run: async (_args: Record<string, never>, ctx) => parallel([1, 2].map(n => () => beer(`step ${n}`, { client: ctx.client, cwd: ctx.cwd, instructions: 'Same.' }))),
    }],
    maxConcurrentSteps: 1,
  })
  const session = await client.sessions.create({ cwd })
  const result = await (await session.submit({ input: '/workflow run pair' })).result({ timeoutMs: null })
  expect(result.status).toBe('completed')
  const payload = JSON.parse(result.text!) as { steps: { started: number; settled: number; queued: number } }
  expect(payload.steps).toEqual({ started: 2, settled: 2, queued: 0 })
  expect(tasks).toEqual(['step 1', 'step 2'])
  // Same pool key (backend route + model + instructions) reuses one bee and its member session.
  expect(backend.opened.filter(params => params.mcpServers?.some(server => server.name === 'anureo-swarm-member'))).toHaveLength(1)
  await client.dispose()
})

test('workflow bees inherit the swarm session permission mode', async () => {
  const tasks: string[] = []
  const backend = await fixture(echoTask(tasks))
  const client = await swarmClient(backend.client, {
    registrations: [{
      id: 'inherit', description: 'Two pool keys', revision: '1',
      run: async (_args: Record<string, never>, ctx) => ({
        a: await beer('step a', { client: ctx.client, cwd: ctx.cwd }),
        b: await beer('step b', { client: ctx.client, cwd: ctx.cwd, instructions: 'Different.' }),
      }),
    }],
  })
  const session = await client.sessions.create({ cwd, permissionMode: 'read-only' })
  const result = await (await session.submit({ input: '/workflow run inherit' })).result({ timeoutMs: null })
  expect(result.status).toBe('completed')
  expect(tasks).toEqual(['step a', 'step b'])
  // The main session and every workflow step bee (both pool keys) carry the swarm session's permission mode verbatim.
  expect(backend.opened.map(params => params.permissionMode)).toEqual(['read-only', 'read-only', 'read-only'])
  await client.dispose()
})

test('façade sessions reject permission-mode overrides so steps inherit the swarm mode', async () => {
  const backend = await fixture(echoTask([]))
  const client = await swarmClient(backend.client, {
    registrations: [{
      id: 'override', description: 'Rejects overrides', revision: '1',
      run: async (_args: Record<string, never>, ctx) => await agent('step', { client: ctx.client, cwd: ctx.cwd, permissionMode: 'bypassPermissions' }),
    }],
  })
  const session = await client.sessions.create({ cwd, permissionMode: 'read-only' })
  const result = await (await session.submit({ input: '/workflow run override' })).result({ timeoutMs: null })
  expect(result.status).toBe('failed')
  expect((result as { error?: { code?: string } }).error?.code).toBe('SWARM_OPTION_UNSUPPORTED')
  // Only the main session opened; the rejected step never reached a bee.
  expect(backend.opened.map(params => params.permissionMode)).toEqual(['read-only'])
  await client.dispose()
})

test('resume replays journaled steps without new member submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-workflow-'))
  const tasks: string[] = []
  const backend = await fixture(echoTask(tasks))
  const registration = {
    id: 'alpha', description: 'Single step', revision: '1',
    run: async (_args: Record<string, never>, ctx: import('../src/workflow/types').SwarmWorkflowRunContext) => ({ a: await beer('alpha', { client: ctx.client, cwd: ctx.cwd }) }),
  }
  const client = await swarmClient(backend.client, { registrations: [registration], journalDirectory: directory })
  const session = await client.sessions.create({ cwd })
  const first = await (await session.submit({ input: '/workflow run alpha' })).result({ timeoutMs: null })
  const firstPayload = JSON.parse(first.text!) as { runId: string; result: string }
  expect(JSON.parse(firstPayload.result)).toEqual({ a: 'done: alpha' })
  expect(tasks).toEqual(['alpha'])
  const resumed = await (await session.submit({ input: `/workflow resume alpha ${firstPayload.runId}` })).result({ timeoutMs: null })
    const resumePayload = JSON.parse(resumed.text!) as { runId: string; result: string; steps: { started: number; settled: number } }
  expect(resumePayload.runId).toBe(firstPayload.runId)
  expect(JSON.parse(resumePayload.result)).toEqual({ a: 'done: alpha' })
  // The journal replayed the step: no new member submission happened.
  expect(tasks).toEqual(['alpha'])
  await client.dispose()
})

test('member-triggered runs nest under the triggering task through the member server', async () => {
  const tasks: string[] = []
  const backend = await fixture(async (input, _structured, _prior, params) => {
    if (input.includes('start-child')) {
      const config = memberServer(params)
      let childResult = 'unset'
      try {
        await withMcp(config, async call => {
          const started = await call('workflow_run', { workflowId: 'child', args: { x: 1 } }) as { runId: string }
          for (let attempt = 0; attempt < 30; attempt++) {
            const status = await call('workflow_status', { runId: started.runId, timeoutMs: 1000 }) as { status: string; result?: string; error?: unknown }
            if (status.status !== 'running') {
              if (status.status !== 'completed') throw new Error(`child ${status.status}: ${JSON.stringify(status.error)}`)
              childResult = JSON.parse(status.result!).value
              return
            }
          }
          throw new Error('child never settled')
        })
      } catch {
        throw new Error('member workflow tools failed')
      }
      return `child said ${childResult}`
    }
    return await echoTask(tasks)(input)
  })
  const client = await swarmClient(backend.client, {
    registrations: [
      {
        id: 'parent', description: 'Parent run', revision: '1',
        run: async (_args: Record<string, never>, ctx) => ({ trigger: await beer('ask the member to start-child', { client: ctx.client, cwd: ctx.cwd, instructions: 'Coordinate.' }) }),
      },
      {
        id: 'child', description: 'Child run', revision: '1',
        run: async (args: { x: number }, ctx) => ({ value: `${await beer(`child step ${args.x}`, { client: ctx.client, cwd: ctx.cwd, instructions: 'Coordinate.' })}` }),
      },
    ],
  })
  const session = await client.sessions.create({ cwd })
  const result = await (await session.submit({ input: '/workflow run parent' })).result({ timeoutMs: null })
    expect(result.status).toBe('completed')
  const payload = JSON.parse(result.text!) as { result: string }
  expect(JSON.parse(payload.result).trigger).toBe('child said done: child step 1')
  const subagents = result.items.filter(item => item.type === 'subagent') as unknown as Array<{ id: string; parentItemId?: string; extensions?: { swarm?: { workflow?: { runId: string; depth: number } } } }>
  expect(subagents).toHaveLength(2)
  const parentItem = subagents.find(item => item.extensions?.swarm?.workflow?.depth === 0)!
  const childItem = subagents.find(item => item.extensions?.swarm?.workflow?.depth === 1)!
  expect(parentItem).toBeDefined()
  expect(childItem).toBeDefined()
  expect(childItem.parentItemId).toBe(parentItem.id)
  await client.dispose()
})

test('main agent starts and polls workflows through the anureo-swarm tools', async () => {
  const tasks: string[] = []
  const backend = await fixture(async (input, _structured, _prior, params) => {
    if (input.includes('run the workflow now')) {
      const config = management(params)
      let summary = ''
      try {
        await withMcp(config, async call => {
          const list = await call('workflow_list') as { workflows: Array<{ id: string }> }
          expect(list.workflows.map(workflow => workflow.id)).toEqual(['single'])
          const started = await call('workflow_run', { workflowId: 'single', args: { q: 42 } }) as { runId: string }
          const status = await call('workflow_status', { runId: started.runId, timeoutMs: 15000 }) as { status: string; result?: string; error?: unknown }
          if (status.status !== 'completed') throw new Error(`run ${status.status}: ${JSON.stringify(status.error)}`)
          summary = JSON.parse(status.result!).answer
        })
      } catch {
        throw new Error('main workflow tools failed')
      }
      return `main saw ${summary}`
    }
    return await echoTask(tasks)(input)
  })
  const client = await swarmClient(backend.client, {
    registrations: [{
      id: 'single', description: 'Single step', revision: '1',
      run: async (args: { q: number }, ctx) => ({ answer: await beer(`answer ${args.q}`, { client: ctx.client, cwd: ctx.cwd }) }),
    }],
  })
  const session = await client.sessions.create({ cwd })
  const result = await (await session.submit({ input: 'Please run the workflow now and report.' })).result({ timeoutMs: null })
    expect(result.status).toBe('completed')
  expect(result.text).toContain('main saw done: answer 42')
  await client.dispose()
})

test('invalid directives and unknown workflows fail the turn explicitly', async () => {
  const backend = await fixture(echoTask([]))
  const client = await swarmClient(backend.client, { registrations: [{ id: 'noop', description: 'Noop', revision: '1', run: async () => 'ok' }] })
  const session = await client.sessions.create({ cwd })
  const malformed = await (await session.submit({ input: '/workflow run' })).result({ timeoutMs: null })
  expect(malformed.status).toBe('failed')
  expect((malformed as { error?: { code?: string } }).error?.code).toBe('SWARM_INVALID_ARGUMENTS')
  const unknown = await (await session.submit({ input: '/workflow run missing' })).result({ timeoutMs: null })
  expect(unknown.status).toBe('failed')
  expect((unknown as { error?: { code?: string } }).error?.code).toBe('SWARM_UNKNOWN_WORKFLOW')
  // Options parse rejects duplicates and unknown limit types.
  const code = (fn: () => unknown) => { try { fn() } catch (cause) { return (cause as { code?: string }).code } }
  expect(code(() => parseSwarmWorkflowOptions({ registrations: [] }))).toBe('SWARM_INVALID_WORKFLOW')
  expect(code(() => parseSwarmWorkflowOptions({ registrations: [{ id: 'noop', description: 'Noop', revision: '1', run: async () => 'ok' }, { id: 'noop', description: 'Noop', revision: '1', run: async () => 'ok' }] }))).toBe('SWARM_INVALID_WORKFLOW')
  expect(code(() => parseSwarmWorkflowOptions({ registrations: [{ id: 'noop', description: 'Noop', revision: '1', run: async () => 'ok' }], maxConcurrentSteps: 0 }))).toBe('SWARM_INVALID_WORKFLOW')
  await client.dispose()
})
