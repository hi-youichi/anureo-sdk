import { expect, spyOn, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { Turn } from '@anureo/sdk'
import { runCli } from '../src/cli'

test('Swarm CLI and backend result waits both have no deadline', async () => {
  const waits = spyOn(Turn.prototype, 'result')
  let stdout = ''
  let stderr = ''
  try {
    const fixture = fileURLToPath(new URL('../../../packages/adapter/swarm/tests/fake-acp.mjs', import.meta.url))
    const code = await runCli([
      '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
      '--output', 'result', 'unlimited wait',
    ], { stdout: text => { stdout += text }, stderr: text => { stderr += text } })
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toMatchObject({ status: 'completed', text: 'Hello unlimited wait' })
    expect(waits.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const [wait] of waits.mock.calls) expect(wait?.timeoutMs).toBeNull()
  } finally { waits.mockRestore() }
}, 15_000)
