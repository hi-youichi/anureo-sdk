import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { runConformance } from '@anureo/conformance'
import { createCodexAdapter } from '../src'
import { tmpdir } from 'node:os'

test('Codex native adapter satisfies shared capability conformance', async () => {
  const report = await runConformance(scenario => ({
    adapter: createCodexAdapter({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))], version: '0.164.0', maxFrameBytes: scenario === 'backpressure' ? 4096 : undefined, env: { ...process.env, FAKE_SCENARIO: ['interrupt','steer'].includes(scenario) ? 'hold' : scenario === 'userInput' ? 'questions' : scenario === 'dynamicTool' ? 'dynamic' : scenario } }),
    openParams: { requestId: 'open', mode: 'new', binding: { sessionId: 'conformance', adapterId: 'codex', runtimeConfigId: 'codex-test' }, cwd: tmpdir() },
    expectedText: 'authoritative final',
  }))
  expect(report.cases.filter(entry => entry.status === 'failed')).toEqual([])
  expect(report.passed).toBe(true)
}, 30_000)
