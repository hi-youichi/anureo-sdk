import { expect, test } from 'bun:test'
import { runConformance, runNativeConformance, type ConformanceScenario, type NativeScenario } from '@anureo/conformance'
import { HarnessSdkError, createClient } from '@anureo/sdk'
import { createPiAdapter } from '../src/index'
import { fakeFactory, type FakePiHost } from './fake-host'
import { until } from './test-helpers'

const open = (scenario: string) => ({ requestId: 'open', mode: 'new' as const, binding: { sessionId: `s-${scenario}`, adapterId: 'pi', runtimeConfigId: 'conformance' }, cwd: '/tmp' })

test('the Pi adapter passes shared conformance for every declared capability', async () => {
  const report = await runConformance((scenario: ConformanceScenario) => {
    const fake = fakeFactory(host => {
      if (scenario === 'interrupt') host.script = async h => { await h.hold() }
      if (scenario === 'disconnect') host.script = async h => { await h.assistant('working'); h.emit({ type: 'failed', code: 'CONNECTION_CLOSED' }); await new Promise(() => {}) }
      if (scenario === 'backpressure') host.script = async h => { await h.assistant('working'); h.emit({ type: 'failed', code: 'BACKPRESSURE_EXCEEDED' }); await new Promise(() => {}) }
      if (scenario === 'unknown-item') host.script = async h => { await h.toolRound({ id: 'mystery', name: 'future_tool', args: { x: 1 }, output: 'out' }); await h.assistant('conformance') }
      if (scenario === 'lifecycle' || scenario === 'immediate' || scenario === 'identity') host.script = async h => { await h.assistant('conformance') }
    })
    return { adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), openParams: open(scenario) }
  })
  expect(report.cases.filter(entry => entry.status === 'failed')).toEqual([])
  expect(report.passed).toBe(true)
  const skipped = report.cases.filter(entry => entry.status === 'not-applicable').map(entry => entry.scenario)
  expect(skipped).toEqual(['approval', 'userInput', 'elicitation', 'dynamicTool', 'steer', 'revert'])
}, 30_000)

test('native lifecycle: overlapping inputs, active close and observer cancellation', async () => {
  const report = await runNativeConformance(async (scenario: NativeScenario) => {
    const fake = fakeFactory(host => { host.script = async h => { await h.hold(); await h.assistant('native final') } })
    const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'native' } })
    const session = await client.sessions.create({ cwd: process.cwd() })
    const host = (): FakePiHost => fake.hosts[0]!
    return {
      client, session, first: 'first', second: 'second', relation: 'same' as const,
      release: async () => {
        await until(() => !!host().release)
        // The second input must be steered into the run before the run is allowed to finish.
        if (scenario !== 'close-active') await until(() => host().steered.length === 1)
        host().release!()
      },
    }
  })
  expect(report.results.filter(result => !result.passed)).toEqual([])
  expect(report.passed).toBe(true)
}, 30_000)

test('a lost native source fails observation with a typed error and never fabricates a terminal', async () => {
  const fake = fakeFactory(host => { host.script = async h => { h.emit({ type: 'failed', code: 'CONNECTION_CLOSED' }); await new Promise(() => {}) } })
  const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'lost' } })
  try {
    const session = await client.sessions.create({ cwd: process.cwd() })
    const turn = await session.submit({ input: 'x' })
    await expect(turn.result({ timeoutMs: 1000 })).rejects.toBeInstanceOf(HarnessSdkError)
  } finally { await client.dispose() }
})
