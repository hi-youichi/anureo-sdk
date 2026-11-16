import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/cli'

async function invoke(args: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(args, {
    stdout: text => { stdout += text },
    stderr: text => { stderr += text },
  })
  return { code, stdout, stderr }
}

test('rejects invalid Swarm backend selectors before starting a harness', async () => {
  for (const name of ['swarm:', 'swarm:unknown', 'swarm:codex:claude']) {
    expect(await invoke(['--harness', name, 'hello'])).toMatchObject({
      code: 2, stdout: '', stderr: expect.stringContaining(`unknown harness "${name}"`),
    })
  }
})

test('applies the selected backend flag rules to Swarm', async () => {
  expect(await invoke(['--harness', 'swarm:acp', 'hello'])).toMatchObject({
    code: 2, stdout: '', stderr: expect.stringContaining('--command is required with --harness swarm:acp'),
  })
  expect(await invoke(['--harness', 'swarm:pi', '--sandbox', 'read-only', 'hello'])).toMatchObject({
    code: 2, stdout: '', stderr: expect.stringContaining('--sandbox is not defined for harness "swarm:pi"'),
  })
})

test('runs Swarm with the selected ACP backend and its command arguments', async () => {
  const fixture = fileURLToPath(new URL('../../../packages/adapter/acp/tests/fixtures/fake-acp.mjs', import.meta.url))
  const { code, stdout, stderr } = await invoke([
    '--harness', 'swarm:acp', '--command', 'node', '--args', JSON.stringify([fixture]),
    '--output', 'result', 'from CLI',
  ])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({
    binding: { adapterId: 'swarm', runtimeConfigId: 'cli:acp' },
    status: 'completed',
    text: 'Hello from CLI',
  })
}, 15_000)
