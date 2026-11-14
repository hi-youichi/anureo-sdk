/** Runs shared capability conformance against the scripted Codex app server. */
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { runConformance } from '@anureo/conformance'
import { createCodexAdapter } from '../src'
import { tmpdir } from 'node:os'

/** Translate shared runner case names to fixture aliases, falling back to the shared name. */
function fakeServerScenarioFor(scenario: string): string {
  switch (scenario) {
    case 'steer': return 'timing'
    case 'interrupt': return 'hold'
    case 'userInput': return 'questions'
    case 'dynamicTool': return 'dynamic'
    default: return scenario
  }
}

/** Assert the runner's verdict across isolated fake processes. The runner reports case failures and owns client disposal. */
test('Codex native adapter satisfies shared capability conformance', async () => {
  // The backpressure case lowers the frame limit so the fake process can trigger transport overflow.
  const report = await runConformance(scenario => {
    return {
      adapter: createCodexAdapter({
        command: process.execPath,
        args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
        version: '0.164.0',
        maxFrameBytes: scenario === 'backpressure' ? 4096 : undefined,
        env: { ...process.env, FAKE_SCENARIO: fakeServerScenarioFor(scenario) },
      }),
      openParams: { requestId: 'open', mode: 'new', binding: { sessionId: 'conformance', adapterId: 'codex', runtimeConfigId: 'codex-test' }, cwd: tmpdir() },
      expectedText: 'authoritative final',
    }
  })
  expect(report.cases.filter(entry => entry.status === 'failed')).toEqual([])
  expect(report.passed).toBe(true)
}, 30_000)
