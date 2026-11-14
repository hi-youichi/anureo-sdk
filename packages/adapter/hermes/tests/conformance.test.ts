import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { createClient } from '@anureo/sdk'
import { runConformance, runNativeConformance } from '@anureo/conformance'
import { startFake } from './helpers'

test('Hermes canonical gateway satisfies the applicable shared conformance cases over real child-process/WS boundaries', async () => {
  const fixtures: Array<Awaited<ReturnType<typeof startFake>>> = []
  try {
    const report = await runConformance(async scenario => {
      const fixture = await startFake(scenario); fixtures.push(fixture)
      return {
        adapter: fixture.adapter({ reconnectAttempts: 0, maxFrameBytes: scenario === 'backpressure' ? 4096 : undefined }),
        openParams: { requestId: 'open', mode: 'new', binding: { sessionId: 'sdk-session', adapterId: 'hermes', runtimeConfigId: 'fake' }, cwd: tmpdir() },
        expectedText: 'authoritative final',
      }
    })
    expect(report.cases.filter(value => value.status === 'failed')).toEqual([])
    expect(report.passed).toBe(true)
  } finally { await Promise.all(fixtures.map(value => value.dispose())) }
}, 30_000)

test('Hermes native queue separates overlapping turns, close only ends observation, and observer disposal preserves execution', async () => {
  const fixtures: Array<Awaited<ReturnType<typeof startFake>>> = []
  try {
    const report = await runNativeConformance(async scenario => {
      const fixture = await startFake(scenario); fixtures.push(fixture)
      const client = await createClient({ adapter: fixture.adapter(), identity: { adapterId: 'hermes', runtimeConfigId: scenario } })
      const session = await client.sessions.create({ cwd: tmpdir() })
      return { client, session, first: 'first', second: 'second', relation: 'different',
        /** The overlap/observer runner awaits this before the second receipt; release only after both native admissions exist. */
        release: async () => {
          for (let i = 0; i < 100; i++) {
            if ((await fixture.state()).inputs.length === 2) { await fixture.control('release'); return }
            await new Promise(resolve => setTimeout(resolve, 5))
          }
          throw new Error('Native submissions did not reach fixture')
        } }
    })
    expect(report.results).toEqual(expect.arrayContaining([{ scenario: 'overlap', passed: true }, { scenario: 'close-active', passed: true }, { scenario: 'observer-cancel', passed: true }]))
    expect(report.passed).toBe(true)
  } finally { await Promise.all(fixtures.map(value => value.dispose())) }
}, 20_000)
