import { expect, test } from 'bun:test'
import { createClient, HarnessSdkError, type HarnessAdapter, type SessionMethod } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, type AhpRequestMap, type AhpResultMap, type Capabilities, type SessionOpenParams } from '@anureo/protocol'
import { createSwarmAdapter, type BeeProfile, type BeeProfileReview } from '../src'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { FileEvolutionStore, createEvolutionController } from '../src/evolution'
import { publish, profile as evolutionProfile } from './evolution-fixture'

async function management(params: SessionOpenParams) {
  const config = params.mcpServers?.find(server => server.name === 'anureo-swarm')
  if (!config || config.type !== 'http') throw new Error('Missing management server')
  const client = new McpClient({ name: 'test-main', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }))
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as { type: string; text?: string }[]
      const text = content.find(block => block.type === 'text')?.text ?? ''
      if (result.isError) throw new Error(text)
      return JSON.parse(text)
    },
  }
}

const assignment = (beeId: string, task = 'Inspect tests') => ({ beeId, task, context: 'SDK repository', constraints: 'Read only', expectedOutput: 'Evidence and findings' })

const cwd = process.cwd()

async function fixture(
  respond: (input: string, structured: boolean, prior: readonly string[], params: SessionOpenParams) => string | Promise<string>,
  outputSchema = true,
  id = 'backend',
  holdBinding?: Promise<void>,
  supportsFork = false,
  conservativeClose = false,
  checkOpen?: (params: SessionOpenParams) => void | Promise<void>,
  atomicSteer = false,
  checkRelease?: (params: SessionOpenParams) => void,
) {
  const submitted: string[] = []
  const released: string[] = []
  const opened: SessionOpenParams[] = []
  const capabilities: Capabilities = {
    input: { delivery: ['native'], ...(atomicSteer ? { steer: { target: 'turn' as const, atomicMatch: true as const } } : {}), interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { inputModalities: ['text'], outputSchema },
    session: supportsFork ? { fork: ['through'] } : undefined,
  }
  let nextTurn = 0
  let interrupted = 0
  const steered: string[] = []
  const adapter: HarnessAdapter = {
    async initialize() {
      return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: id, version: '1', adapter: id }, capabilities }
    },
    async openSession(params, sink) {
      if (params.fork) expect(released).not.toContain(params.fork.sourceSessionId)
      opened.push(params)
      await checkOpen?.(params)
      const prior: string[] = []
      let active: string | undefined
      return {
        binding: { ...params.binding, nativeRef: { provider: id, value: `native-${params.binding.sessionId}` } }, capabilities,
        async execute<M extends SessionMethod>(method: M, request: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
          if (method === 'session/close') {
            return { closed: true, observationClosed: true, executionStopped: conservativeClose ? 'unconfirmed' : 'confirmed' } as AhpResultMap[M]
          }
          if (method === 'turn/interrupt') {
            if (!active) throw new HarnessSdkError('TURN_MISMATCH')
            const turnId = active
            active = undefined
            interrupted++
            await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'interrupted' } })
            return { accepted: true, turnId } as AhpResultMap[M]
          }
          if (method === 'turn/steer') {
            const steer = request as AhpRequestMap['turn/steer']
            if (!active || active !== steer.expectedTurnId) throw new HarnessSdkError('TURN_MISMATCH')
            const turnId = active
            steered.push(steer.input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
            await sink.emit({ type: 'item/started', payload: { item: { id: 'steered', type: 'agentMessage', phase: 'final', text: '' } } }, { turnId })
            await sink.emit({ type: 'item/completed', payload: { item: { id: 'steered', type: 'agentMessage', phase: 'final', text: 'Updated report' } } }, { turnId })
            await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
            active = undefined
            return { submissionId: steer.submissionId, turnId, accepted: true } as AhpResultMap[M]
          }
          if (method !== 'input/submit') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
          const { input, submissionId, outputSchema: schema } = request as AhpRequestMap['input/submit']
          const prompt = input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          const answer = await respond(prompt, !!schema, prior, params)
          submitted.push(prompt)
          prior.push(prompt)
          const turnId = active = `backend-turn-${++nextTurn}`
          const scope = { turnId }
          await sink.emit({ type: 'turn/started', payload: { ...scope, nativeTurnId: `native-${turnId}` } })
          if (answer === 'hold') {
            await holdBinding
            await sink.bindSubmission(submissionId, turnId)
          } else {
            if (answer === 'fail' || answer === 'unknown') {
              await sink.emit({ type: 'turn/completed', payload: {
                turnId, status: 'failed',
                error: { code: 'FIXTURE_FAILED', message: 'Failed', retryable: false, outcomeUnknown: answer === 'unknown' },
              } })
            } else {
              const item = { id: 'reused-message-id', type: 'agentMessage' as const, phase: 'final' as const }
              await sink.emit({ type: 'item/started', payload: { item: { ...item, text: '' } } }, scope)
              await sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: answer } }, scope)
              await sink.emit({ type: 'item/completed', payload: { item: { ...item, text: answer } } }, scope)
              const usage = params.mode === 'fork' ? { provider: id, scope: 'turn' as const, source: 'native' as const, cacheRead: 1024 } : undefined
              await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed', usage } })
            }
            active = undefined
            // Deliberately bind after all output, exercising early backend events.
            await sink.bindSubmission(submissionId, turnId)
          }
          return { submissionId, disposition: 'dispatched' } as AhpResultMap[M]
        },
        async dispose() { released.push(params.binding.sessionId); checkRelease?.(params) },
      }
    },
    async dispose() {},
  }
  const client = await createClient({ adapter, identity: { adapterId: id, runtimeConfigId: 'test' } })
  return { client, submitted, released, opened, steered, get interrupted() { return interrupted } }
}

const swarm = (backend: Awaited<ReturnType<typeof fixture>>, memberBackends?: Record<string, typeof backend.client>, profiles?: readonly BeeProfile[]) =>
  createClient({ adapter: createSwarmAdapter({ backend: backend.client, memberBackends, profiles }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })

const tester: BeeProfile = {
  id: 'tester',
  name: '测试工程师',
  description: 'Regression testing',
  instructions: 'List the missing assertions.',
  model: 'test-model',
}

test('scoped creation preserves instructions, status, snapshots, reviews and evolution identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-origins-'))
  const store = new FileEvolutionStore({ directory, scope: 'shared' })
  const controller = createEvolutionController({ store, proposer: () => undefined })
  const received: BeeProfileReview[] = []
  const snapshots: string[] = []
  const sources = {
    user: { scope: 'user' as const, namespace: '/home/.anureo/bees' },
    project: { scope: 'project' as const, namespace: '/repo/.anureo/bees' },
  }
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (params.mode === 'fork') return JSON.stringify({ decision: 'propose', reason: 'Observed omission', evidence: ['Member evidence'], patch: { op: 'append', anchor: null, text: 'Check the rollback.' }, check: 'Verify rollback assertions' })
    if (!params.mcpServers?.length) return params.instructions ?? ''
    expect(params.instructions).toContain('"profileScope":"user","default":false')
    expect(params.instructions).toContain('"profileScope":"project","default":true')
    const mcp = await management(params)
    try {
      await expect(mcp.call('bee_create', { profileId: 'tester', profileScope: 'other' })).rejects.toThrow('SWARM_INVALID_ARGUMENTS')
      await expect(mcp.call('bee_create', { role: 'tester', name: 'Temporary', profileScope: 'user' })).rejects.toThrow('SWARM_INVALID_ARGUMENTS')
      await expect(mcp.call('bee_create', { profileId: 'reviewer', profileScope: 'project' })).rejects.toThrow('SWARM_INVALID_PROFILE')
      for (const scope of ['user', 'project', undefined] as const) {
        const selected = scope ?? 'project'
        const bee = await mcp.call('bee_create', { profileId: 'tester', ...(scope ? { profileScope: scope } : {}) })
        expect(bee).toMatchObject({ profileId: 'tester', profileScope: selected, sourceFile: `/${selected}/tester.json` })
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        const report = await mcp.call('bee_wait', { taskId: task.taskId })
        expect(report).toMatchObject({ state: 'completed', profileScope: selected, profileSource: sources[selected] })
        expect(report.execution).toMatchObject({ requestedModel: `${selected}-model`, modelSource: 'profile', requestedEffort: selected === 'user' ? 'low' : 'high', effortSource: 'profile' })
        expect(report.text).toContain(`${selected} instructions`)
        expect((await mcp.call('bee_status')).bees.find((entry: { beeId: string }) => entry.beeId === bee.beeId).profileScope).toBe(selected)
        await mcp.call('bee_close', { beeId: bee.beeId })
        expect((await mcp.call('bee_status', { taskId: task.taskId })).profileScope).toBe(selected)
      }
      return 'Compared both origins'
    } finally { await mcp.client.close() }
  }, true, 'backend', undefined, true)
  const entries = (['user', 'project'] as const).map(scope => ({ profile: { ...tester, instructions: `${scope} instructions`, model: `${scope}-model`, effort: scope === 'user' ? 'low' : 'high' }, source: sources[scope], sourceFile: `/${scope}/tester.json` }))
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client,
    modelCatalog: { default: { status: 'unavailable', effortConfigKey: 'effort' } },
    profileEntries: [...entries, { profile: { ...tester, id: 'reviewer' }, source: sources.user }],
    evolution: { controller }, profileReview: { onResult(review) { received.push(review) } },
    hooks: { afterTask(event) { snapshots.push(event.profileSource!.scope); expect(event.sourceFile).toBe(`/${event.profileSource!.scope}/tester.json`); expect(event.execution?.requestedModel).toBe(`${event.profileSource!.scope}-model`) } },
  }), identity: { adapterId: 'swarm', runtimeConfigId: 'origins' } })
  try {
    expect(() => createSwarmAdapter({ backend: backend.client, profiles: [], profileEntries: [] })).toThrow('Use either profiles or profileEntries')
    const session = await client.sessions.create({ cwd })
    const result = await (await session.submit({ input: 'Compare profiles' })).result()
    expect(result.status).toBe('completed')
    expect(result.items.filter(item => item.type === 'subagent').map(item => item.extensions?.swarm)).toEqual([
      expect.objectContaining({ profileScope: 'user' }), expect.objectContaining({ profileScope: 'project' }), expect.objectContaining({ profileScope: 'project' }),
    ])
    expect(backend.opened.filter(p => !p.mcpServers?.length && p.mode !== 'fork').map(p => p.model)).toEqual(['user-model', 'project-model', 'project-model'])
    expect(backend.opened.filter(p => p.mode === 'fork').map(p => p.model)).toEqual(['user-model', 'project-model', 'project-model'])
    expect(backend.opened.filter(p => !p.mcpServers?.length && p.mode !== 'fork').map(p => p.config)).toEqual([{ effort: 'low' }, { effort: 'high' }, { effort: 'high' }])
    expect(backend.opened.filter(p => p.mode === 'fork').map(p => p.config)).toEqual([{ effort: 'low' }, { effort: 'high' }, { effort: 'high' }])
    await client.dispose()
    await controller.drain()
    expect(snapshots).toEqual(['user', 'project', 'project'])
    expect(received).toHaveLength(3)
    for (const review of received) {
      expect(review.status).toBe('proposed')
      expect(review.sourceFile).toBe(`/${review.profileSource!.scope}/tester.json`)
    }
    const user = (await controller.resolve({ id: 'tester', source: sources.user }))!
    const project = (await controller.resolve({ id: 'tester', source: sources.project }))!
    expect(user.revision.profile.instructions).toBe('user instructions')
    expect(project.revision.profile.instructions).toBe('project instructions')
    expect(user.revision.id).not.toBe(project.revision.id)
    expect(controller.diagnostics).toEqual([])
  } finally {
    await client.dispose(); await controller.close(); await backend.client.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('MCP assignments pin running revisions, rotate future sessions, reuse same version and rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-pins-'))
  const store = new FileEvolutionStore({ directory, scope: 'project' })
  const controller = createEvolutionController({ store, proposer: () => undefined })
  const baseline = await controller.seed(evolutionProfile)
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const pins: string[] = [], bees: string[] = []
  let memberRuns = 0, observations = 0
  const observerErrors: string[] = []
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) {
      if (++memberRuns === 1) { entered(); await gate }
      return 'Member evidence'
    }
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { profileId: evolutionProfile.id })
      for (let i = 0; i < 4; i++) {
        if (i === 3) {
          const head = (await controller.resolve(evolutionProfile.id))!
          await controller.rollback(evolutionProfile.id, baseline.revision.id, head.head.generation, 'Regression')
        }
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        if (i === 0) {
          await ready
          expect((await publish(store, baseline)).status).toBe('committed')
          release()
        }
        const report = await mcp.call('bee_wait', { taskId: task.taskId })
        expect(report.state).toBe('completed')
        pins.push(report.pin.revisionId); bees.push(report.beeId)
        await mcp.call('bee_assess', { taskId: task.taskId, verdict: 'accepted', reason: 'Inspected evidence', evidence: ['Member evidence'] })
      }
      return 'Reviewed'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, profiles: [evolutionProfile],
    evolution: { controller }, hooks: { afterTask() { observations++; throw new Error('Observer unavailable') } },
    onError(diagnostic) { observerErrors.push(diagnostic.hook) },
  }), identity: { adapterId: 'swarm', runtimeConfigId: 'pins' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect versions' })).result()).status).toBe('completed')
    await controller.drain()
    expect(pins[0]).toBe(baseline.revision.id)
    expect(pins[1]).not.toBe(pins[0])
    expect(pins[2]).toBe(pins[1]); expect(pins[3]).toBe(pins[0])
    expect(new Set(bees).size).toBe(1)
    expect(backend.opened.filter(p => !p.mcpServers?.length)).toHaveLength(3)
    expect(observations).toBe(4)
    expect(observerErrors).toEqual(['afterTask', 'afterTask', 'afterTask', 'afterTask'])
    expect(await store.listIds('evidence')).toHaveLength(10) // includes publication helper evidence
    expect(controller.diagnostics).toEqual([])
  } finally {
    release(); await client.dispose(); await controller.close(); await backend.client.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

test('slow legacy review analysis does not block reuse after fork acquisition', async () => {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (params.mode === 'fork') { entered(); await gate; return JSON.stringify({ decision: 'skip', reason: 'No lesson', patch: null, check: null }) }
    if (!params.mcpServers?.length) return 'Member evidence'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { profileId: tester.id })
      const first = await mcp.call('bee_delegate', assignment(bee.beeId))
      await mcp.call('bee_wait', { taskId: first.taskId })
      await ready
      const second = await mcp.call('bee_delegate', assignment(bee.beeId))
      expect((await mcp.call('bee_wait', { taskId: second.taskId, timeoutMs: 500 })).state).toBe('completed')
      release()
      return 'Done'
    } finally { release(); await mcp.client.close() }
  }, true, 'backend', undefined, true)
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, profiles: [tester], profileReview: { onResult() {} } }), identity: { adapterId: 'swarm', runtimeConfigId: 'slow-review' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Review' })).result()).status).toBe('completed')
  } finally { release(); await client.dispose(); await backend.client.dispose() }
})

test('adapter disposal closes only an explicitly adapter-owned evolution controller', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-owner-'))
  const backend = await fixture(() => 'Done')
  try {
    for (const ownership of ['caller', 'adapter'] as const) {
      const store = new FileEvolutionStore({ directory, scope: ownership })
      const controller = createEvolutionController({ store, proposer: () => undefined })
      const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, evolution: { controller, ownership } }), identity: { adapterId: 'swarm', runtimeConfigId: ownership } })
      await client.dispose()
      if (ownership === 'caller') expect((await controller.seed(evolutionProfile)).head.generation).toBe(1)
      else expect(() => controller.seed(evolutionProfile)).toThrow('EVOLUTION_CLOSED')
      await controller.close()
    }
  } finally { await backend.client.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('status stays running until afterTask completes and terminal tasks are assessable', async () => {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) return 'Evidence'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      await ready
      expect((await mcp.call('bee_status', { taskId: task.taskId })).state).toBe('running')
      expect((await mcp.call('bee_wait', { taskId: task.taskId, timeoutMs: 0 })).state).toBe('running')
      await expect(mcp.call('bee_delegate', assignment(bee.beeId))).rejects.toThrow('SWARM_BEE_UNAVAILABLE')
      release()
      expect((await mcp.call('bee_wait', { taskId: task.taskId })).state).toBe('completed')
      expect((await mcp.call('bee_assess', { taskId: task.taskId, verdict: 'accepted', reason: 'Inspected', evidence: [] })).verdict).toBe('accepted')
      return 'Done'
    } finally { release(); await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, hooks: { async afterTask() { entered(); await gate } } }), identity: { adapterId: 'swarm', runtimeConfigId: 'terminal' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
  } finally { release(); await client.dispose(); await backend.client.dispose() }
})

test('main receives default and application instructions, preserves conversation without a router', async () => {
  const backend = await fixture((_input, structured, prior) => { expect(structured).toBe(false); return `reply ${prior.length}` })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd, instructions: 'Respond in Chinese' })
    expect((await (await session.submit({ input: 'hello' })).result()).text).toBe('reply 0')
    expect((await (await session.submit({ input: 'continue' })).result()).text).toBe('reply 1')
    expect(backend.opened).toHaveLength(1)
    expect(backend.opened[0].instructions).toContain('bee_delegate')
    expect(backend.opened[0].instructions).toContain('Respond in Chinese')
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('repeated assignments emit nested evidence with stable bee IDs and isolated item IDs', async () => {
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'Member evidence'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      for (let i = 0; i < 2; i++) {
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        await mcp.call('bee_wait', { taskId: task.taskId })
      }
      await mcp.call('bee_close', { beeId: bee.beeId })
      return 'Main conclusion'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const stream = session.events()
    const reading = (async () => { const events = []; for await (const event of stream) { events.push(event); if (event.type === 'turn/completed') break } return events })()
    const turn = await session.submit({ input: 'Inspect and follow up' })
    const result = await turn.result()
    const events = await reading
    expect(result.text).toBe('Main conclusion')
    const tasks = result.items.filter(item => item.type === 'subagent')
    expect(tasks).toHaveLength(2)
    expect(tasks[0].subagentId).toBe(tasks[1].subagentId)
    expect(tasks[0].id).not.toBe(tasks[1].id)
    for (const task of tasks) {
      expect(task).toMatchObject({ state: 'completed', status: 'completed', nativeRef: { provider: 'backend', value: expect.any(String) }, startedAt: expect.any(String), durationMs: expect.any(Number) })
      const children = result.items.filter(item => item.parentItemId === task.id)
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ type: 'agentMessage', text: 'Member evidence', phase: 'final' })
      const start = events.findIndex(event => event.type === 'item/started' && event.payload.item.id === task.id)
      const end = events.findIndex(event => event.type === 'item/completed' && event.payload.item.id === task.id)
      expect(events.filter(event => event.type === 'item/completed' && event.payload.item.id === task.id)).toHaveLength(1)
      const childEvents = events.filter(event => event.type === 'item/delta' ? event.payload.itemId === children[0].id : (event.type === 'item/started' || event.type === 'item/completed') && event.payload.item.id === children[0].id)
      expect(childEvents).toHaveLength(3)
      expect(childEvents.every(event => event.turnId === turn.id && events.indexOf(event) > start && events.indexOf(event) < end)).toBe(true)
    }
    expect(new Set(result.items.map(item => item.id)).size).toBe(result.items.length)
    expect(events.filter(event => event.type === 'turn/started')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/completed')).toHaveLength(1)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('main creates fixed and temporary bees, delegates concurrently and reuses sessions across turns', async () => {
  let beeId: string | undefined
  let mainTurns = 0
  const alternate = await fixture(input => `alternate ${JSON.parse(input).task}`, true, 'alternate')
  const backend = await fixture(async (input, _structured, prior, params) => {
    if (!params.mcpServers?.some(server => server.name === 'anureo-swarm')) return `worker ${prior.length}: ${JSON.parse(input).task}`
    mainTurns++
    const mcp = await management(params)
    try {
      const listed = await mcp.client.listTools()
      expect(listed.tools).toHaveLength(10)
      if (!beeId) {
        beeId = (await mcp.call('bee_create', { profileId: 'tester' })).beeId
        const other = await mcp.call('bee_create', { role: 'reviewer', name: 'Reviewer' })
        const a = await mcp.call('bee_delegate', assignment(beeId!))
        const b = await mcp.call('bee_delegate', assignment(other.beeId, 'Check API'))
        expect((await mcp.call('bee_wait', { taskId: a.taskId })).text).toContain('alternate')
        expect((await mcp.call('bee_wait', { taskId: b.taskId })).text).toContain('worker 0')
        await mcp.call('bee_close', { beeId: other.beeId })
      } else {
        const task = await mcp.call('bee_delegate', assignment(beeId, 'Follow up'))
        expect((await mcp.call('bee_wait', { taskId: task.taskId })).state).toBe('completed')
      }
      return 'Integrated answer'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend, { tester: alternate.client }, [tester])
  try {
    const session = await client.sessions.create({ cwd })
    for (const input of ['Investigate', 'Follow up']) expect((await (await session.submit({ input })).result()).status).toBe('completed')
    expect(mainTurns).toBe(2)
    expect(alternate.opened).toHaveLength(1)
    expect(alternate.opened[0].instructions).toContain(tester.instructions)
    expect(alternate.submitted).toHaveLength(2)
  } finally { await client.dispose(); await backend.client.dispose(); await alternate.client.dispose() }
  expect(alternate.released).toHaveLength(1)
})

test('validates tools, enforces limits, cancels a member and expires the endpoint', async () => {
  let endpoint: SessionOpenParams | undefined
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'hold'
    endpoint = params
    const mcp = await management(params)
    try {
      await expect(mcp.call('bee_create', { role: 'bad role', name: 'Bad' })).rejects.toThrow('SWARM_INVALID_ARGUMENTS')
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      await expect(mcp.call('bee_create', { role: 'other', name: 'Other' })).rejects.toThrow('SWARM_BEE_LIMIT')
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      expect((await mcp.call('bee_wait', { taskId: task.taskId, timeoutMs: 0 })).state).toBe('running')
      await expect(mcp.call('bee_delegate', assignment(bee.beeId))).rejects.toThrow('SWARM_BEE_UNAVAILABLE')
      expect((await mcp.call('bee_cancel', { taskId: task.taskId })).state).toBe('interrupted')
      return 'Cancelled'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, limits: { maxBees: 1 } }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Investigate' })).result()).status).toBe('completed')
    expect(backend.interrupted).toBe(1)
    await session.close()
    await expect(management(endpoint!)).rejects.toThrow()
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('explicit mentions guide the main and invalid mentions fail before submission', async () => {
  const backend = await fixture(input => input)
  const client = await swarm(backend, undefined, [tester])
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: '@tester inspect' })).result()).text).toContain('Delegate this request to fixed bee tester')
    const unknown = await (await session.submit({ input: '@missing inspect' })).result()
    expect(unknown.status).toBe('failed')
    const scoped = await (await session.submit({ input: '@user/tester inspect' })).result()
    expect(scoped).toMatchObject({ status: 'failed', error: { code: 'SWARM_UNKNOWN_BEE' } })
    const empty = await (await session.submit({ input: '@tester' })).result()
    expect(empty).toMatchObject({ status: 'failed', error: { code: 'SWARM_BEE_TASK_REQUIRED' } })
    expect(backend.submitted).toHaveLength(1)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('ending a main turn cancels uncollected work', async () => {
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'hold'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      await mcp.call('bee_wait', { taskId: task.taskId, timeoutMs: 10 })
      return 'Done'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
    expect(backend.interrupted).toBe(1)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('unknown member outcome fails the outer turn and requires session recovery', async () => {
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'unknown'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      expect((await mcp.call('bee_wait', { taskId: task.taskId })).error.outcomeUnknown).toBe(true)
      return 'Partial'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const result = await (await session.submit({ input: 'Inspect' })).result()
    expect(result.status).toBe('failed')
    if (result.status !== 'completed') expect(result.error?.outcomeUnknown).toBe(true)
    await expect(session.submit({ input: 'Continue' })).rejects.toThrow()
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('fixed bee review forks the completed boundary and preserves the reusable parent', async () => {
  const received: BeeProfileReview[] = []
  let beeId: string | undefined
  const backend = await fixture(async (input, _structured, _prior, params) => {
    if (params.mode === 'fork') return JSON.stringify({ decision: 'propose', reason: 'Improve evidence', evidence: ['A missing assertion was identified'], patch: { op: 'append', anchor: null, text: 'Cite test locations.' }, check: 'Next report includes test locations' })
    if (!params.mcpServers?.length) return 'Evidence'
    const mcp = await management(params)
    try {
      beeId ??= (await mcp.call('bee_create', { profileId: tester.id })).beeId
      const task = await mcp.call('bee_delegate', assignment(beeId!))
      await mcp.call('bee_wait', { taskId: task.taskId })
      return 'Answer'
    } finally { await mcp.client.close() }
  }, true, 'backend', undefined, true)
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, profiles: [tester], profileReview: { onResult: review => { received.push(review) } } }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    for (const input of ['Inspect', 'Follow up']) expect((await (await session.submit({ input })).result()).status).toBe('completed')
  } finally { await client.dispose(); await backend.client.dispose() }
  expect(backend.opened.filter(params => params.mode === 'fork')).toHaveLength(2)
  expect(backend.opened.filter(params => params.instructions?.includes(tester.instructions) && params.mode === 'new')).toHaveLength(1)
  expect(received).toHaveLength(2)
  expect(received.every(review => review.status === 'proposed')).toBe(true)
})

test('outer interrupt stops both main and member and rejects overlapping work', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'hold'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      await mcp.call('bee_wait', { taskId: task.taskId, timeoutMs: 10 })
      started()
      return 'hold'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const turn = await session.submit({ input: 'Inspect' })
    await ready
    await expect(session.submit({ input: 'Overlap' })).rejects.toThrow()
    await turn.interrupt()
    expect((await turn.result()).status).toBe('interrupted')
    expect(backend.interrupted).toBe(2)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('management credentials and bee IDs are isolated between sessions', async () => {
  const endpoints: SessionOpenParams[] = []
  let firstBee: string | undefined
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    endpoints.push(params)
    const mcp = await management(params)
    try {
      if (firstBee) await expect(mcp.call('bee_delegate', assignment(firstBee))).rejects.toThrow('SWARM_UNKNOWN_BEE')
      else firstBee = (await mcp.call('bee_create', { role: 'tester', name: 'Tester' })).beeId
      return 'Answer'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    for (let i = 0; i < 2; i++) {
      const session = await client.sessions.create({ cwd })
      expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
    }
    const a = endpoints[0].mcpServers![0], b = endpoints[1].mcpServers![0]
    if (a.type === 'http' && b.type === 'http') {
      expect(a.url).not.toBe(b.url)
      expect(a.headers).not.toEqual(b.headers)
      expect((await fetch(a.url, { method: 'POST', headers: b.headers })).status).toBe(401)
    }
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('concurrency and per-turn assignment budgets are enforced independently', async () => {
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'hold'
    const mcp = await management(params)
    try {
      const bees = []
      for (const role of ['first', 'second', 'third']) bees.push(await mcp.call('bee_create', { role, name: role }))
      const tasks = []
      for (const bee of bees.slice(0, 2)) tasks.push(await mcp.call('bee_delegate', assignment(bee.beeId)))
      await expect(mcp.call('bee_delegate', assignment(bees[2].beeId))).rejects.toThrow('SWARM_TASK_LIMIT')
      const status = await mcp.call('bee_status')
      expect(status.tasks.filter((task: { state: string }) => task.state === 'running')).toHaveLength(2)
      for (const task of tasks) await mcp.call('bee_cancel', { taskId: task.taskId })
      await expect(mcp.call('bee_delegate', assignment(bees[2].beeId))).rejects.toThrow('SWARM_TASK_LIMIT')
      return 'Done'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, limits: { maxConcurrentTasks: 2, maxTasksPerTurn: 2 } }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('a known terminal member can close even when its backend close is conservatively unconfirmed', async () => {
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'Evidence'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      expect((await mcp.call('bee_wait', { taskId: task.taskId })).state).toBe('completed')
      expect((await mcp.call('bee_close', { beeId: bee.beeId })).closed).toBe(true)
      return 'Answer'
    } finally { await mcp.client.close() }
  }, true, 'backend', undefined, false, true)
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('hooks enrich immutable snapshots, assess idempotently and preserve hook order across turns', async () => {
  const order: string[] = []
  let oldTask = ''
  let turn = 0
  const turns: import('../src').TurnSnapshot[] = []
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'Evidence'
    const mcp = await management(params)
    try {
      if (turn++) await expect(mcp.call('bee_assess', { taskId: oldTask, verdict: 'accepted', reason: 'ok', evidence: [] })).rejects.toThrow('SWARM_UNKNOWN_TASK')
      await expect(mcp.call('bee_assess', { taskId: 'missing', verdict: 'accepted', reason: 'ok', evidence: [] })).rejects.toThrow('SWARM_UNKNOWN_TASK')
      const bee = await mcp.call('bee_create', { profileId: tester.id })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      oldTask = task.taskId
      await mcp.call('bee_wait', { taskId: task.taskId })
      const args = { taskId: task.taskId, verdict: 'accepted', reason: 'checked', evidence: ['Observed output'] }
      const first = await mcp.call('bee_assess', args)
      expect(await mcp.call('bee_assess', args)).toEqual(first)
      await expect(mcp.call('bee_assess', { ...args, verdict: 'rejected' })).rejects.toThrow('SWARM_ASSESSMENT_CONFLICT')
      return 'Answer'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, profiles: [tester], hooks: {
    beforeDelegate(event) {
      order.push('before')
      expect(Object.isFrozen(event.assignment)).toBe(true)
      return { enrich: { context: 'Additional evidence', constraints: 'Cite files' } }
    },
    afterTask(event) {
      order.push('task')
      expect(event.assignment.context).toContain('Additional evidence')
      expect(event.assignment.constraints).toBe('Read only\n\nCite files')
      expect(event.profile?.id).toBe(tester.id)
      expect(event.result.status).toBe('completed')
      expect(Object.isFrozen(event.result.items)).toBe(true)
      expect(event.sessionId).toBeTruthy()
    },
    afterAssessment(event) { order.push('assessment'); expect(Object.isFrozen(event.evidence)).toBe(true) },
    afterTurn(event) { order.push('turn'); turns.push(event); expect(Object.isFrozen(event.tasks)).toBe(true) },
  } }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    for (const input of ['one', 'two']) expect((await (await session.submit({ input })).result()).status).toBe('completed')
    expect(order).toEqual(['before', 'task', 'assessment', 'turn', 'before', 'task', 'assessment', 'turn'])
    expect(turns.map(t => [t.tasks.length, t.assessments.length])).toEqual([[1, 1], [1, 1]])
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('pending beforeDelegate reserves bee and concurrency; cancellation prevents late submission', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) throw new Error('Must not submit member')
    const mcp = await management(params)
    try {
      const a = await mcp.call('bee_create', { role: 'a', name: 'A', model: 'cancelled-model' })
      const b = await mcp.call('bee_create', { role: 'b', name: 'B' })
      const task = await mcp.call('bee_delegate', assignment(a.beeId))
      await ready
      await expect(mcp.call('bee_delegate', assignment(a.beeId))).rejects.toThrow('SWARM_BEE_UNAVAILABLE')
      await expect(mcp.call('bee_delegate', assignment(b.beeId))).rejects.toThrow('SWARM_TASK_LIMIT')
      await expect(mcp.call('bee_assess', { taskId: task.taskId, verdict: 'accepted', reason: 'early', evidence: [] })).rejects.toThrow('SWARM_TASK_RUNNING')
      expect((await mcp.call('bee_cancel', { taskId: task.taskId })).state).toBe('interrupted')
      release()
      return 'Answer'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, limits: { maxConcurrentTasks: 1 }, hookTimeoutMs: 50,
    hooks: { async beforeDelegate(event, context) { expect(event.execution?.requestedModel).toBe('cancelled-model'); entered(); await gate; expect(context.signal.aborted).toBe(true) } },
  }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'run' })).result()).status).toBe('completed')
    expect(backend.opened).toHaveLength(1)
  } finally { release(); await client.dispose(); await backend.client.dispose() }
})

test('hanging observers and error handlers are bounded and diagnostics preserve completed results', async () => {
  const never = new Promise<void>(() => {})
  let diagnostics: unknown[] = []
  let turnSeen = false
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (!params.mcpServers?.length) return 'Evidence'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      expect((await mcp.call('bee_wait', { taskId: task.taskId })).state).toBe('completed')
      diagnostics = (await mcp.call('bee_status')).diagnostics
      return 'Answer'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, hookTimeoutMs: 10,
    hooks: { afterTask: () => never, afterTurn: () => { turnSeen = true; return never } }, onError: () => never,
  }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'run' })).result()).status).toBe('completed')
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ hook: 'afterTask', code: 'SWARM_HOOK_TIMEOUT' }), expect.objectContaining({ hook: 'onError' })]))
    expect(turnSeen).toBe(true)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('beforeDelegate timeout and denial never open member sessions', async () => {
  for (const mode of ['timeout', 'deny']) {
    const backend = await fixture(async (_input, _structured, _prior, params) => {
      const mcp = await management(params)
      try {
        const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        expect((await mcp.call('bee_wait', { taskId: task.taskId })).state).toBe('failed')
        return 'Answer'
      } finally { await mcp.client.close() }
    })
    const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, hookTimeoutMs: 10,
      hooks: { beforeDelegate: () => mode === 'deny' ? { deny: 'No' } : new Promise(() => {}) },
    }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
    try {
      const session = await client.sessions.create({ cwd })
      expect((await (await session.submit({ input: 'run' })).result()).status).toBe('completed')
      expect(backend.opened).toHaveLength(1)
    } finally { await client.dispose(); await backend.client.dispose() }
  }
})

test('afterTurn runs once for invalid requests with an empty current-turn snapshot', async () => {
  const seen: import('../src').TurnSnapshot[] = []
  const backend = await fixture(() => 'unused')
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, hooks: { afterTurn(event) { seen.push(event) } } }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: '@missing inspect' })).result()).status).toBe('failed')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ status: 'failed', tasks: [], assessments: [] })
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('guided concurrent model choices retain reasons and revisions through hooks, reports, events and reuse', async () => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  let started = 0
  const ids: string[] = []
  const choices = ['fast', 'deep', undefined]
  const reasons = ['Bounded extraction matches fast guidance', 'Cross-module reasoning needs deep model', 'Task-specific guidance is incomplete; use backend default']
  const selections: (string | undefined)[] = []
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) {
      if (++started === 3) entered()
      await gate
      return params.model ?? 'backend default'
    }
    expect(params.instructions).toContain('"id":"fast"')
    expect(params.instructions).not.toContain('hidden-model')
    expect(params.instructions).not.toContain('mutated-model')
    expect(params.instructions).toContain('Bounded tasks')
    const mcp = await management(params)
    try {
      if (!ids.length) {
        for (const model of choices) await expect(mcp.call('bee_create', { role: 'worker', name: 'Worker', ...(model ? { model } : {}) })).rejects.toThrow('selectionReason')
        expect((await mcp.call('bee_status')).bees).toHaveLength(0)
      }
      if (!ids.length) for (const [index, model] of choices.entries()) {
        const bee = await mcp.call('bee_create', { role: 'worker', name: 'Worker', ...(model ? { model } : {}), selectionReason: reasons[index] })
        expect(bee.execution).toMatchObject({ backend: backend.client.identity, route: { kind: 'default' }, modelSource: model ? 'bee' : 'backend-default' })
        expect(bee.execution.requestedModel).toBe(model)
        expect(bee.execution.selectionReason).toBe(reasons[index])
        if (model === 'fast') expect(bee.execution.guidanceRevision).toMatch(/^[a-f0-9]{64}$/)
        else expect(bee.execution.guidanceRevision).toBeUndefined()
        ids.push(bee.beeId)
      }
      expect(backend.opened.filter(p => !p.mcpServers?.length)).toHaveLength(started ? 3 : 0)
      const tasks = []
      for (const id of ids) tasks.push(await mcp.call('bee_delegate', assignment(id)))
      await ready
      if (started === 3) expect((await mcp.call('bee_status')).tasks.map((task: { state: string }) => task.state)).toEqual(['running', 'running', 'running'])
      release()
      for (const [index, task] of tasks.entries()) {
        expect(await mcp.call('bee_wait', { taskId: task.taskId })).toMatchObject({ state: 'completed', text: choices[index] ?? 'backend default', execution: { selectionReason: reasons[index] } })
      }
      return 'Model choices checked'
    } finally { release(); await mcp.client.close() }
  })
  const catalog = { default: { status: 'available' as const, policy: 'allowlist' as const, models: [{ id: 'fast', guidance: { summary: 'Bounded tasks', preferredTasks: ['extraction'], source: 'Application policy', reviewedAt: '2026-11-17' } }, { id: 'deep' }, { id: 'hidden-model', hidden: true }] } }
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, modelCatalog: catalog, hooks: {
    beforeDelegate(event) { expect(event.execution?.backend).toEqual(backend.client.identity); expect(reasons).toContain(event.execution?.selectionReason ?? '') },
    afterTask(event) { selections.push(event.execution?.requestedModel); expect(reasons).toContain(event.execution?.selectionReason ?? '') },
  } }), identity: { adapterId: 'swarm', runtimeConfigId: 'model-selection' } })
  catalog.default.models[0].id = 'mutated-model'
  try {
    const session = await client.sessions.create({ cwd, model: 'main-only' })
    for (let index = 0; index < 2; index++) {
      const result = await (await session.submit({ input: 'Inspect' })).result()
      expect(result.status).toBe('completed')
      const members = result.items.filter(item => item.type === 'subagent')
      expect(members.map(item => (item.extensions?.swarm as { execution: { requestedModel?: string } }).execution.requestedModel)).toEqual(choices)
      expect(members.map(item => (item.extensions?.swarm as { execution: { selectionReason?: string } }).execution.selectionReason)).toEqual(reasons)
    }
    expect(backend.opened.filter(p => !p.mcpServers?.length).map(p => p.model)).toEqual(choices)
    expect(selections).toEqual([...choices, ...choices])
  } finally { release(); await client.dispose(); await backend.client.dispose() }
})

test('model catalogs follow backend routes and never override fixed profiles', async () => {
  const alternate = await fixture((_input, _schema, _prior, params) => params.model ?? 'alternate default', true, 'alternate')
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) return params.model ?? 'main backend default'
    const mcp = await management(params)
    try {
      for (const invalid of [
        { role: 'worker', name: 'Worker', model: 'member-only' },
        { role: 'reviewer', name: 'Reviewer', model: 'default-only' },
        { role: 'worker', name: 'Worker', model: ' ' },
        { role: 'worker', name: 'Worker', model: 5 },
        { profileId: tester.id, model: 'override' },
        { role: 'worker', name: 'Worker', profileScope: 'project' },
        { profileScope: 'user' },
      ]) await expect(mcp.call('bee_create', invalid)).rejects.toThrow()
      expect((await mcp.call('bee_status')).bees).toHaveLength(0)
      expect(backend.opened).toHaveLength(1)
      expect(alternate.opened).toHaveLength(0)
      const tools = await mcp.client.listTools()
      expect(tools.tools.find(tool => tool.name === 'bee_create')?.inputSchema.oneOf).toHaveLength(2)
      for (const [args, model, identity, routeKind] of [
        [{ role: 'unmapped', name: 'Default', model: 'default-only' }, 'default-only', backend.client.identity, 'default'],
        [{ role: 'reviewer', name: 'Reviewer', model: 'member-only' }, 'member-only', alternate.client.identity, 'member'],
        [{ role: 'uncatalogued', name: 'Unknown catalog', model: 'not-in-default' }, 'not-in-default', alternate.client.identity, 'member'],
        [{ profileId: tester.id }, tester.model, backend.client.identity, 'default'],
      ] as const) {
        const bee = await mcp.call('bee_create', args)
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        const report = await mcp.call('bee_wait', { taskId: task.taskId })
        expect(report).toMatchObject({ state: 'completed', execution: { backend: identity, requestedModel: model, route: { kind: routeKind } } })
        await mcp.call('bee_close', { beeId: bee.beeId })
        expect((await mcp.call('bee_status', { taskId: task.taskId })).execution).toEqual(report.execution)
      }
      return 'Routing checked'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, profiles: [tester], memberBackends: { reviewer: alternate.client, uncatalogued: alternate.client },
    modelCatalog: { default: { status: 'available', policy: 'allowlist', models: [{ id: 'default-only' }] }, members: { reviewer: { status: 'available', policy: 'allowlist', models: [{ id: 'member-only' }] } } },
  }), identity: { adapterId: 'swarm', runtimeConfigId: 'routes' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
    expect(backend.opened.filter(p => !p.mcpServers?.length).map(p => p.model)).toEqual(['default-only', tester.model])
    expect(alternate.opened.map(p => p.model)).toEqual(['member-only', 'not-in-default'])
  } finally { await client.dispose(); await backend.client.dispose(); await alternate.client.dispose() }
})

test('effort mappings stay with backend routes, preserve defaults and reject invalid choices before admission', async () => {
  const alternate = await fixture((_input, _schema, _prior, params) => {
    expect(params.config).toEqual({ thinkingLevel: 'high' })
    return 'Pi evidence'
  }, true, 'custom-alternate-identity')
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) {
      expect(params.config === undefined || params.config.effort === 'low').toBe(true)
      expect(params.config?.thinkingLevel).toBeUndefined()
      return 'Default evidence'
    }
    const mcp = await management(params)
    try {
      for (const args of [
        { role: 'worker', name: 'Unsupported effort', model: 'routine', effort: 'high' },
        { role: 'unsupported', name: 'No mapping', effort: 'low' },
        { role: 'worker', name: 'Invalid exact ID', effort: ' low' },
      ]) await expect(mcp.call('bee_create', args)).rejects.toThrow()
      expect((await mcp.call('bee_status')).bees).toHaveLength(0)
      for (const [role, model, effort] of [['worker', 'routine', 'low'], ['thinking', 'reasoning', 'high'], ['worker', 'routine', undefined]] as const) {
        const bee = await mcp.call('bee_create', { role, name: role, model, ...(effort ? { effort } : {}) })
        expect(bee.execution.requestedEffort).toBe(effort)
        expect(bee.execution.effortSource).toBe(effort ? 'bee' : 'backend-default')
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        const report = await mcp.call('bee_wait', { taskId: task.taskId })
        expect(report.state).toBe('completed')
        expect(report.execution).toEqual(bee.execution)
        await mcp.call('bee_close', { beeId: bee.beeId })
        expect((await mcp.call('bee_status', { taskId: task.taskId })).execution).toEqual(bee.execution)
      }
      return 'Mappings checked'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, memberBackends: { thinking: alternate.client, unsupported: alternate.client }, modelCatalog: {
    default: { status: 'available', effortConfigKey: 'effort', models: [{ id: 'routine', efforts: [{ id: 'low' }] }] },
    members: { thinking: { status: 'available', effortConfigKey: 'thinkingLevel', models: [{ id: 'reasoning', efforts: [{ id: 'high' }] }] } },
  } }), identity: { adapterId: 'swarm', runtimeConfigId: 'effort-mapping' } })
  try {
    const session = await client.sessions.create({ cwd, config: { effort: 'max', thinkingLevel: 'max' } })
    const result = await (await session.submit({ input: 'Check effort mappings' })).result()
    expect(result.status).toBe('completed')
    expect(result.items.filter(item => item.type === 'subagent').map(item => (item.extensions?.swarm as { execution: { requestedEffort?: string } }).execution.requestedEffort)).toEqual(['low', 'high', undefined])
    expect(backend.opened.filter(params => !params.mcpServers?.length).map(params => params.config)).toEqual([{ effort: 'low' }, undefined])
    expect(alternate.opened).toHaveLength(1)
  } finally { await client.dispose(); await backend.client.dispose(); await alternate.client.dispose() }
})

test('only explicit instruction failures retry and preserve the selected model', async () => {
  for (const unsupported of ['instructions', 'model', 'permissions']) {
    const backend = await fixture(async (_input, _schema, _prior, params) => {
      if (!params.mcpServers?.length) return 'Member evidence'
      const mcp = await management(params)
      try {
        const bee = await mcp.call('bee_create', { role: 'worker', name: 'Worker', model: 'chosen' })
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        const report = await mcp.call('bee_wait', { taskId: task.taskId })
        expect(report.state).toBe(unsupported === 'instructions' ? 'completed' : 'failed')
        expect(report.execution.requestedModel).toBe('chosen')
        expect((await mcp.call('bee_status')).bees[0].taskId).toBeUndefined()
        return 'Failure handled'
      } finally { await mcp.client.close() }
    }, true, 'backend', undefined, false, false, params => {
      if (!params.mcpServers?.length && (unsupported !== 'instructions' || params.instructions)) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', `Unsupported ${unsupported}`, false, false, { capability: `session.${unsupported}` })
    })
    const client = await swarm(backend)
    try {
      const session = await client.sessions.create({ cwd })
      expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
      const attempts = backend.opened.filter(p => !p.mcpServers?.length)
      expect(attempts.map(p => p.model)).toEqual(unsupported === 'instructions' ? ['chosen', 'chosen'] : ['chosen'])
      expect(backend.submitted.filter(input => input.includes('Inspect tests'))).toHaveLength(unsupported === 'instructions' ? 1 : 0)
    } finally { await client.dispose(); await backend.client.dispose() }
  }
})

test('cancelling during model session opening releases the late backend without submitting', async () => {
  let release!: () => void, entered!: () => void, released!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const opening = new Promise<void>(resolve => { entered = resolve })
  const closed = new Promise<void>(resolve => { released = resolve })
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) throw new Error('Cancelled member must never submit')
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'worker', name: 'Worker', model: 'selected' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      await opening
      expect(await mcp.call('bee_cancel', { taskId: task.taskId })).toMatchObject({ state: 'interrupted', execution: { requestedModel: 'selected' } })
      release()
      await closed
      await mcp.call('bee_close', { beeId: bee.beeId })
      return 'Late backend released'
    } finally { release(); await mcp.client.close() }
  }, true, 'backend', undefined, false, false, async params => {
    if (!params.mcpServers?.length) { expect(params.model).toBe('selected'); entered(); await gate }
  }, false, params => { if (!params.mcpServers?.length) released() })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
    const member = backend.opened.find(params => !params.mcpServers?.length)!
    expect(backend.released.filter(id => id === member.binding.sessionId)).toHaveLength(1)
    expect(backend.submitted).toHaveLength(1)
  } finally { release(); await client.dispose(); await backend.client.dispose() }
})

test('member model and effort reach native Codex turns without leaking main config and survive session reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-native-model-'))
  const log = join(directory, 'calls.jsonl')
  const codex = await createClient({ adapter: createCodexAdapter({ command: process.execPath,
    args: [fileURLToPath(new URL('../../codex/tests/fake-app-server.mjs', import.meta.url))], version: '0.164.0',
    env: { ...process.env, FAKE_SCENARIO: 'normal', FAKE_LOG_FILE: log },
  }), identity: { adapterId: 'codex', runtimeConfigId: 'member-model' } })
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'worker', name: 'Worker', model: 'Selected/Exact', effort: 'low' })
      expect(bee.execution).toMatchObject({ requestedEffort: 'low', effortSource: 'bee' })
      for (let index = 0; index < 2; index++) {
        const task = await mcp.call('bee_delegate', assignment(bee.beeId))
        expect(await mcp.call('bee_wait', { taskId: task.taskId })).toMatchObject({ state: 'completed', execution: { requestedModel: 'Selected/Exact', requestedEffort: 'low', effortSource: 'bee', backend: codex.identity } })
      }
      return 'Native model checked'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, memberBackends: { worker: codex }, modelCatalog: { members: { worker: { status: 'available', effortConfigKey: 'effort', models: [{ id: 'Selected/Exact', efforts: [{ id: 'low' }] }] } } } }), identity: { adapterId: 'swarm', runtimeConfigId: 'native-model' } })
  try {
    const session = await client.sessions.create({ cwd: directory, model: 'main-model', config: { model: 'main-config', effort: 'high' } })
    expect((await (await session.submit({ input: 'Inspect' })).result()).status).toBe('completed')
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.find(call => call.method === 'thread/start').params.model).toBe('Selected/Exact')
    expect(calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'turn/start').map(call => call.params.effort)).toEqual(['low', 'low'])
    expect(calls.find(call => call.method === 'turn/start').params.model).toBeUndefined()
  } finally { await client.dispose(); await backend.client.dispose(); await codex.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 15_000)

test('batch wait, mailbox and full result reads compose through the management MCP endpoint', async () => {
  let finishSlow!: () => void
  const slow = new Promise<void>(resolve => { finishSlow = resolve })
  const full = '完整证据😀'.repeat(4000)
  let savedTask: string | undefined, savedResult: string | undefined
  const backend = await fixture(async (input, _schema, prior, params) => {
    if (!params.mcpServers?.length) {
      if (JSON.parse(input).task === 'slow') { await slow; return 'slow done' }
      return full
    }
    const mcp = await management(params)
    try {
      if (prior.length) {
        expect((await mcp.call('bee_status', { taskId: savedTask })).result.resultRef).toBe(savedResult)
        const page = await mcp.call('bee_status', { history: true, limit: 1 })
        expect(page.tasks).toHaveLength(1)
        expect(page.hasMore).toBe(true)
        const next = await mcp.call('bee_status', { history: true, limit: 1, cursor: page.nextCursor })
        expect(next.tasks).toHaveLength(1)
        expect(next.tasks[0].taskId).not.toBe(page.tasks[0].taskId)
        expect((await mcp.call('bee_result_read', { resultRef: savedResult })).text.length).toBeGreaterThan(0)
        await expect(mcp.call('bee_assess', { taskId: savedTask, verdict: 'accepted', reason: 'old', evidence: [] })).rejects.toThrow('SWARM_UNKNOWN_TASK')
        return 'History retained'
      }
      const a = await mcp.call('bee_create', { role: 'reviewer', name: 'Slow' })
      const b = await mcp.call('bee_create', { role: 'tester', name: 'Fast' })
      const first = await mcp.call('bee_delegate', assignment(a.beeId, 'slow'))
      const second = await mcp.call('bee_delegate', assignment(b.beeId, 'fast'))
      await expect(mcp.call('bee_wait', { taskId: first.taskId, taskIds: [first.taskId], mode: 'all' })).rejects.toThrow('SWARM_INVALID_ARGUMENTS')
      await expect(mcp.call('bee_receive', { timeoutMs: null })).rejects.toThrow('SWARM_INVALID_ARGUMENTS')
      const any = await mcp.call('bee_wait', { taskIds: [first.taskId, second.taskId], mode: 'any' })
      expect(any.timedOut).toBe(false)
      expect(any.remainingTaskIds).toEqual([first.taskId])
      const report = any.tasks[1]
      expect(report.textTruncated).toBe(true)
      let text = '', cursor: string | undefined
      do {
        const page = await mcp.call('bee_result_read', { resultRef: report.result.resultRef, ...(cursor ? { cursor } : {}) })
        text += page.text; cursor = page.nextCursor
      } while (cursor)
      expect(text).toBe(full)
      savedTask = second.taskId; savedResult = report.result.resultRef
      const received = await mcp.call('bee_receive', { after: 0, timeoutMs: 0 })
      expect(received.notices.map((notice: { taskId: string }) => notice.taskId)).toEqual([second.taskId])
      expect(await mcp.call('bee_receive', { after: 0, timeoutMs: 0 })).toEqual(received)
      finishSlow()
      const all = await mcp.call('bee_wait', { taskIds: [first.taskId, second.taskId], mode: 'all' })
      expect(all.remainingTaskIds).toEqual([])
      const later = await mcp.call('bee_receive', { after: received.nextCursor })
      expect(later.notices.map((notice: { taskId: string }) => notice.taskId)).toEqual([first.taskId])
      await mcp.call('bee_close', { beeId: b.beeId })
      expect((await mcp.call('bee_status', { taskId: second.taskId })).execution.backend.adapterId).toBe('backend')
      return 'Main answer'
    } finally { finishSlow(); await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Inspect concurrently' })).result()).text).toBe('Main answer')
    expect((await (await session.submit({ input: 'Follow up' })).result()).text).toBe('History retained')
  } finally { finishSlow(); await client.dispose(); await backend.client.dispose() }
})

test('atomic task messages steer exactly one execution and retries reuse their receipt', async () => {
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) return 'hold'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'reviewer', name: 'Reviewer' })
      const key = `${bee.operationScope}:delegate`
      const args = { ...assignment(bee.beeId), operationKey: key }
      const task = await mcp.call('bee_delegate', args)
      expect(await mcp.call('bee_delegate', args)).toEqual(task)
      await expect(mcp.call('bee_delegate', { ...args, task: 'different task' })).rejects.toThrow('SWARM_OPERATION_CONFLICT')
      let canSteer = false
      for (let i = 0; i < 20; i++) {
        if ((await mcp.call('bee_status', { taskId: task.taskId })).messaging.currentTurn) { canSteer = true; break }
      }
      expect(canSteer).toBe(true)
      const message = { taskId: task.taskId, message: 'Focus on boundary cases', delivery: 'currentTurn', operationKey: `${bee.operationScope}:message` }
      const receipt = await mcp.call('bee_send', message)
      expect(receipt).toMatchObject({ state: 'submitted', taskId: task.taskId, attemptId: task.attemptId })
      expect(await mcp.call('bee_send', message)).toEqual(receipt)
      expect((await mcp.call('bee_wait', { taskId: task.taskId })).text).toBe('Updated report')
      return 'Done'
    } finally { await mcp.client.close() }
  }, true, 'backend', undefined, false, false, undefined, true)
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Investigate' })).result()).text).toBe('Done')
    expect(backend.steered).toHaveLength(1)
    expect(JSON.parse(backend.steered[0]).message).toBe('Focus on boundary cases')
    expect(backend.submitted.filter(input => { try { return !!JSON.parse(input).task } catch { return false } })).toHaveLength(1)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('next-assignment messages never start native work and survive a denied preparation', async () => {
  let assignments = 0
  const backend = await fixture(async (input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) { assignments++; return JSON.parse(input).context }
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'tester', name: 'Tester' })
      const first = await mcp.call('bee_delegate', assignment(bee.beeId, 'first'))
      await mcp.call('bee_wait', { taskId: first.taskId })
      const message = { taskId: first.taskId, message: 'Check array bounds', delivery: 'nextAssignment', operationKey: `${bee.operationScope}:carry` }
      expect((await mcp.call('bee_send', message)).state).toBe('queued')
      expect(assignments).toBe(1)
      const denied = await mcp.call('bee_delegate', assignment(bee.beeId, 'deny'))
      expect((await mcp.call('bee_wait', { taskId: denied.taskId })).state).toBe('failed')
      expect((await mcp.call('bee_send', message)).state).toBe('queued')
      const second = await mcp.call('bee_delegate', assignment(bee.beeId, 'second'))
      const result = await mcp.call('bee_wait', { taskId: second.taskId })
      expect(result.text).toContain('Check array bounds')
      expect(await mcp.call('bee_send', message)).toMatchObject({ state: 'submitted', targetTaskId: second.taskId, targetAttemptId: second.attemptId })
      expect(assignments).toBe(2)
      return 'Done'
    } finally { await mcp.client.close() }
  })
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, hooks: { beforeDelegate: event => event.assignment.task === 'deny' ? { deny: 'Denied fixture task' } : undefined } }), identity: { adapterId: 'swarm', runtimeConfigId: 'message-carry' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Investigate' })).result()).text).toBe('Done')
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('session-only members reject current-turn delivery without submitting another task', async () => {
  const backend = await fixture(async (_input, _schema, _prior, params) => {
    if (!params.mcpServers?.length) return 'hold'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { role: 'reviewer', name: 'Reviewer' })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      let running = false
      for (let i = 0; i < 20; i++) {
        if ((await mcp.call('bee_status', { taskId: task.taskId })).phase === 'running') { running = true; break }
      }
      expect(running).toBe(true)
      await expect(mcp.call('bee_send', { taskId: task.taskId, message: 'Correction', delivery: 'currentTurn', operationKey: `${bee.operationScope}:correction` })).rejects.toThrow('SWARM_MESSAGE_DELIVERY_UNSUPPORTED')
      expect((await mcp.call('bee_cancel', { taskId: task.taskId })).state).toBe('interrupted')
      return 'Done'
    } finally { await mcp.client.close() }
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'Investigate' })).result()).text).toBe('Done')
    expect(backend.steered).toEqual([])
    expect(backend.submitted).toHaveLength(2)
  } finally { await client.dispose(); await backend.client.dispose() }
})

test('legacy profileReview callbacks receive a deadline and cannot hang disposal', async () => {
  let signal: AbortSignal | undefined
  const errors: string[] = []
  const backend = await fixture(async (_input, _structured, _prior, params) => {
    if (params.mode === 'fork') return JSON.stringify({ decision: 'skip', reason: 'No lesson', patch: null, check: null })
    if (!params.mcpServers?.length) return 'Evidence'
    const mcp = await management(params)
    try {
      const bee = await mcp.call('bee_create', { profileId: tester.id })
      const task = await mcp.call('bee_delegate', assignment(bee.beeId))
      await mcp.call('bee_wait', { taskId: task.taskId })
      return 'Answer'
    } finally { await mcp.client.close() }
  }, true, 'backend', undefined, true)
  const client = await createClient({ adapter: createSwarmAdapter({ backend: backend.client, profiles: [tester], hookTimeoutMs: 10,
    profileReview: { onResult(_review, context) { signal = context.signal; expect(context.deadlineAt).toBeGreaterThan(0); return new Promise(() => {}) } },
    onError(diagnostic) { errors.push(diagnostic.hook) },
  }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })
  try {
    const session = await client.sessions.create({ cwd })
    expect((await (await session.submit({ input: 'run' })).result()).status).toBe('completed')
    await client.dispose()
    expect(signal?.aborted).toBe(true)
    expect(errors).toContain('profileReview.onResult')
  } finally { await client.dispose(); await backend.client.dispose() }
})
