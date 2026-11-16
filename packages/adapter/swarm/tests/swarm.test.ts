import { expect, test } from 'bun:test'
import { createClient, HarnessSdkError, type HarnessAdapter, type SessionMethod } from '@anureo/sdk'
import { AHP_PROTOCOL_CONTRACT, type AhpRequestMap, type AhpResultMap, type Capabilities } from '@anureo/protocol'
import { createSwarmAdapter } from '../src'

const cwd = process.cwd()
const teamPlan = {
  kind: 'team',
  tasks: [{ role: 'reviewer', task: 'Check compatibility' }, { role: 'tester', task: 'Check tests' }],
}

async function fixture(
  respond: (input: string, structured: boolean, prior: readonly string[]) => string | 'hold' | 'fail',
  outputSchema = true,
  id = 'backend',
  holdBinding?: Promise<void>,
) {
  const submitted: string[] = []
  const released: string[] = []
  const capabilities: Capabilities = {
    input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { inputModalities: ['text'], outputSchema },
  }
  let nextTurn = 0
  let interrupted = 0
  const adapter: HarnessAdapter = {
    async initialize() {
      return { protocolVersion: 1, protocolContract: AHP_PROTOCOL_CONTRACT, runtime: { name: id, version: '1', adapter: id }, capabilities }
    },
    async openSession(params, sink) {
      const prior: string[] = []
      let active: string | undefined
      return {
        binding: params.binding, capabilities,
        async execute<M extends SessionMethod>(method: M, request: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
          if (method === 'session/close') {
            return { closed: true, observationClosed: true, executionStopped: 'confirmed' } as AhpResultMap[M]
          }
          if (method === 'turn/interrupt') {
            if (!active) throw new HarnessSdkError('TURN_MISMATCH')
            const turnId = active
            active = undefined
            interrupted++
            await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'interrupted' } })
            return { accepted: true, turnId } as AhpResultMap[M]
          }
          if (method !== 'input/submit') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
          const { input, submissionId, outputSchema: schema } = request as AhpRequestMap['input/submit']
          const prompt = input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          const answer = respond(prompt, !!schema, prior)
          submitted.push(prompt)
          prior.push(prompt)
          const turnId = active = `backend-turn-${++nextTurn}`
          const scope = { turnId }
          await sink.emit({ type: 'turn/started', payload: scope })
          if (answer === 'hold') {
            await holdBinding
            await sink.bindSubmission(submissionId, turnId)
          } else {
            if (answer === 'fail') {
              await sink.emit({ type: 'turn/completed', payload: {
                turnId, status: 'failed',
                error: { code: 'FIXTURE_FAILED', message: 'Failed', retryable: false, outcomeUnknown: false },
              } })
            } else {
              const item = { id: 'reused-message-id', type: 'agentMessage' as const, phase: 'final' as const }
              await sink.emit({ type: 'item/started', payload: { item: { ...item, text: '' } } }, scope)
              await sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'text', text: answer } }, scope)
              await sink.emit({ type: 'item/completed', payload: { item: { ...item, text: answer } } }, scope)
              await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
            }
            active = undefined
            // Deliberately bind after all output, exercising early backend events.
            await sink.bindSubmission(submissionId, turnId)
          }
          return { submissionId, disposition: 'dispatched' } as AhpResultMap[M]
        },
        async dispose() { released.push(params.binding.sessionId) },
      }
    },
    async dispose() {},
  }
  const client = await createClient({ adapter, identity: { adapterId: id, runtimeConfigId: 'test' } })
  return { client, submitted, released, get interrupted() { return interrupted } }
}

const swarm = (backend: Awaited<ReturnType<typeof fixture>>, memberBackends?: Record<string, typeof backend.client>) =>
  createClient({ adapter: createSwarmAdapter({ backend: backend.client, memberBackends }), identity: { adapterId: 'swarm', runtimeConfigId: 'test' } })

const direct = JSON.stringify({ kind: 'direct', tasks: [] })

test('one backend supports direct, team, and a follow-up in the same session', async () => {
  const backend = await fixture((input, structured, prior) => {
    if (structured) return JSON.parse(input).request === 'team' ? JSON.stringify(teamPlan) : direct
    if (input.includes('"assignment"')) return 'worker evidence'
    if (input.includes('"reports"')) return input.includes('worker evidence') ? 'team summary' : 'missing reports'
    if (input === 'follow-up') return prior[1]?.includes('"reports"') ? 'continued' : 'lost context'
    return 'first answer'
  })
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const events = session.events()[Symbol.asyncIterator]()
    const collect = (async () => {
      const observed = []
      while (true) {
        const result = await events.next()
        if (result.done) return observed
        observed.push(result.value)
        if (observed.filter(event => event.type === 'turn/completed').length === 3) return observed
      }
    })()
    const first = await session.submit({ input: 'first' })
    expect((await first.result()).text).toBe('first answer')
    const team = await session.submit({ input: 'team' })
    expect((await team.result()).text).toBe('team summary')
    const followUp = await session.submit({ input: 'follow-up' })
    expect((await followUp.result()).text).toBe('continued')
    const observed = await collect
    await events.return?.()
    expect(observed.filter(event => event.type === 'turn/completed').map(event => event.turnId)).toEqual([first.id, team.id, followUp.id])
    expect(observed.filter(event => event.type === 'item/delta').map(event => event.payload.text)).toEqual(['first answer', 'team summary', 'continued'])
    const completed = observed.filter(event => event.type === 'item/completed')
    expect(new Set(completed.map(event => event.payload.item.id)).size).toBe(5)
    expect(completed.filter(event => event.turnId === team.id && event.payload.item.type === 'subagent')).toHaveLength(2)
    expect(await session.close()).toMatchObject({ executionStopped: 'confirmed' })
    expect(backend.released).toHaveLength(6)
    const borrowed = await backend.client.sessions.create({ cwd })
    await borrowed.close()
  } finally {
    await client.dispose()
    await backend.client.dispose()
  }
})

test('uses role overrides and includes a failed member in the summary input', async () => {
  const backend = await fixture((input, structured) => {
    if (structured) return JSON.stringify(teamPlan)
    if (input.includes('"assignment"')) return 'fail'
    return input.includes('review evidence') && input.includes('FIXTURE_FAILED') ? 'partial coverage' : 'incorrect report'
  })
  const alternate = await fixture(() => 'review evidence', true, 'alternate')
  const client = await swarm(backend, { reviewer: alternate.client })
  try {
    const session = await client.sessions.create({ cwd })
    const turn = await session.submit({ input: 'review' })
    const result = await turn.result()
    expect(result.text).toBe('partial coverage')
    expect(alternate.submitted[0]).toContain('Check compatibility')
    expect(backend.submitted.some(input => input.includes('"assignment":"Check tests"'))).toBe(true)
    expect(result.items.filter(item => item.type === 'subagent').map(item => item.state).sort()).toEqual(['completed', 'failed'])
  } finally {
    await client.dispose()
    await backend.client.dispose()
    await alternate.client.dispose()
  }
})

test('falls back to direct execution when the routing backend lacks structured output', async () => {
  const backend = await fixture(() => 'direct result', false)
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const events = session.events()[Symbol.asyncIterator]()
    const result = await (await session.submit({ input: 'hello' })).result()
    expect(result.text).toBe('direct result')
    let fallback = false
    while (true) {
      const event = await events.next()
      if (event.done || event.value.type === 'turn/completed') break
      if (event.value.type === 'notice') fallback ||= event.value.payload.code === 'SWARM_ROUTING_FALLBACK'
    }
    await events.return?.()
    expect(fallback).toBe(true)
    expect(backend.submitted).toEqual(['hello'])
  } finally {
    await client.dispose()
    await backend.client.dispose()
  }
})

test('interrupts running members, rejects overlapping work, and skips synthesis', async () => {
  const backend = await fixture((_input, structured) => structured ? JSON.stringify(teamPlan) : 'hold')
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const turn = await session.submit({ input: 'team' })
    await expect(session.submit({ input: 'overlapping' })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    const deadline = Date.now() + 2000
    while (backend.submitted.length < 3 && Date.now() < deadline) await Bun.sleep(1)
    expect(backend.submitted).toHaveLength(3)
    await turn.interrupt()
    const result = await turn.result({ timeoutMs: 2500 })
    expect(result.status).toBe('interrupted')
    expect(backend.interrupted).toBe(2)
    expect(backend.submitted).toHaveLength(3)
  } finally {
    await client.dispose()
    await backend.client.dispose()
  }
})

test('interrupts an execution that binds after the outer interrupt', async () => {
  let bind!: () => void
  const binding = new Promise<void>(resolve => { bind = resolve })
  const backend = await fixture((_input, structured) => structured ? direct : 'hold', true, 'backend', binding)
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const turn = await session.submit({ input: 'direct' })
    const deadline = Date.now() + 2000
    while (backend.submitted.length < 2 && Date.now() < deadline) await Bun.sleep(1)
    expect(backend.submitted).toHaveLength(2)
    await turn.interrupt()
    bind()
    expect((await turn.result({ timeoutMs: 2500 })).status).toBe('interrupted')
    expect(backend.interrupted).toBe(1)
  } finally {
    bind()
    await client.dispose()
    await backend.client.dispose()
  }
})

test('fails the outer turn without synthesis when all members fail', async () => {
  const backend = await fixture((_input, structured) => structured ? JSON.stringify(teamPlan) : 'fail')
  const client = await swarm(backend)
  try {
    const session = await client.sessions.create({ cwd })
    const result = await (await session.submit({ input: 'team' })).result()
    expect(result).toMatchObject({ status: 'failed', error: { code: 'SWARM_TEAM_FAILED', outcomeUnknown: false } })
    expect(backend.submitted).toHaveLength(3)
  } finally {
    await client.dispose()
    await backend.client.dispose()
  }
})
