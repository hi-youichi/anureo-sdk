/** Binds shared capability conformance to native fixture scenarios; it must not define conformance rules or contact a real account. */
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { runConformance } from '@anureo/conformance'
import { createCodexAdapter } from '../src'
import { tmpdir } from 'node:os'

/** Map shared case names to native fixture behavior without I/O; the binding callback uses unchanged names for all cases without a native alias. */
function fakeServerScenarioFor(scenario: string): string {
  switch (scenario) {
    case 'steer': return 'timing'
    case 'interrupt': return 'hold'
    case 'userInput': return 'questions'
    case 'dynamicTool': return 'dynamic'
    default: return scenario
  }
}

/** Ask the shared runner to exercise isolated fake processes and assert its complete verdict; runner-owned disposal releases each adapter, while setup or assertion failures reject the test. */
test('Codex native adapter satisfies shared capability conformance', async () => {
  /** Supply one unstarted adapter/open contract per shared scenario; the runner owns launch and disposal. Lower only the backpressure frame limit so that fixture must exercise transport overflow. */
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
