import { expect, test } from 'bun:test'
import { runConformance, runNativeConformance, type ConformanceFactory, type ConformanceScenario, type NativeFixtureFactory } from '@anureo/conformance'
import { HarnessSdkError, createClient } from '@anureo/sdk'
import { createPiAdapter } from '../src/index'
import { fakeFactory, type Script } from './fake-host'
import { until } from './test-helpers'

test('the Pi adapter passes shared conformance for every declared capability', async () => {
  const report = await runConformance(createConformanceDriver)
  expect(report.cases.filter(entry => entry.status === 'failed')).toEqual([])
  expect(report.passed).toBe(true)
  const skipped = report.cases.filter(entry => entry.status === 'not-applicable').map(entry => entry.scenario)
  expect(skipped).toEqual(['approval', 'userInput', 'elicitation', 'dynamicTool', 'steer', 'revert'])
}, 30_000)

test('native lifecycle: overlapping inputs, active close and observer cancellation', async () => {
  const report = await runNativeConformance(createNativeFixture)
  expect(report.results.filter(result => !result.passed)).toEqual([])
  expect(report.passed).toBe(true)
}, 30_000)

test('a lost native source fails observation with a typed error and never fabricates a terminal', async () => {
  const fake = fakeFactory(host => { host.script = failObservation('CONNECTION_CLOSED') })
  const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'lost' } })
  try {
    const session = await client.sessions.create({ cwd: process.cwd() })
    const turn = await session.submit({ input: 'x' })
    await expect(turn.result({ timeoutMs: 1000 })).rejects.toBeInstanceOf(HarnessSdkError)
  } finally { await client.dispose() }
})

/** Supply runConformance with a fresh adapter and native behavior for each case. The runner owns the SDK client. */
const createConformanceDriver: ConformanceFactory = scenario => {
  const script = conformanceScript(scenario)
  const fake = fakeFactory(host => { if (script) host.script = script })
  return {
    adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }),
    openParams: {
      requestId: 'open', mode: 'new', cwd: '/tmp',
      binding: { sessionId: `s-${scenario}`, adapterId: 'pi', runtimeConfigId: 'conformance' },
    },
  }
}

/** Override the default fake run only for cases that require specific output, a hold or source loss. */
function conformanceScript(scenario: ConformanceScenario): Script | undefined {
  switch (scenario) {
    case 'interrupt': return async host => { await host.hold() }
    case 'disconnect': return failObservation('CONNECTION_CLOSED', 'working')
    case 'backpressure': return failObservation('BACKPRESSURE_EXCEEDED', 'working')
    case 'unknown-item':
      return async host => {
        await host.toolRound({ id: 'mystery', name: 'future_tool', args: { x: 1 }, output: 'out' })
        await host.assistant('conformance')
      }
    case 'lifecycle':
    case 'immediate':
    case 'identity': return async host => { await host.assistant('conformance') }
    default: return undefined
  }
}

/** Fail the SDK's observation and keep the script pending so FakePiHost never emits a terminal for the lost run. */
function failObservation(code: 'CONNECTION_CLOSED' | 'BACKPRESSURE_EXCEEDED', precedingText?: string): Script {
  return async host => {
    if (precedingText !== undefined) await host.assistant(precedingText)
    host.emit({ type: 'failed', code })
    await new Promise(() => {})
  }
}

/** Open a session that holds its first submission. runNativeConformance disposes the returned client. */
const createNativeFixture: NativeFixtureFactory = async () => {
  const fake = fakeFactory(host => {
    host.script = async running => {
      await running.hold()
      await running.assistant('native final')
    }
  })
  const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'native' } })
  const session = await client.sessions.create({ cwd: process.cwd() })
  const host = fake.hosts[0]!
  return {
    client, session, first: 'first', second: 'second', relation: 'same',
    async release() {
      await until(() => !!host.release)
      // Only overlap and observer cancellation call release. Wait for native receipt of their second input.
      await until(() => host.steered.length === 1)
      host.release!()
    },
  }
}
