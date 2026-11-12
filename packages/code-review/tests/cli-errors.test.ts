import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { errorText } from '../src/io'

test('the binary retains operation and cleanup causes and preserves the signal exit code', async () => {
  const entry = fileURLToPath(new URL('./fixtures/cli-errors.ts', import.meta.url))
  for (const scenario of ['both', 'operation', 'cleanup', 'signal']) {
    const child = Bun.spawn([process.execPath, entry], { env: { ...process.env, FAILURE_CASE: scenario }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code).toBe(scenario === 'signal' ? 130 : 1)
    expect(JSON.parse(stdout).disposals).toBe(1)
    if (scenario === 'both' || scenario === 'operation') expect(stderr).toContain('operation failure A')
    if (scenario === 'both' || scenario === 'cleanup') expect(stderr).toContain('cleanup failure B')
    if (scenario === 'signal') expect(stderr).toBe('')
  }
})


test('aggregate diagnostics retain nested causes without looping on repeated error objects', () => {
  const operation = new Error('operation')
  const group = new AggregateError([operation, new AggregateError([new Error('cleanup')], 'release')], 'both')
  group.errors.push(group, operation)
  const text = errorText(group)
  expect(text).toContain('AggregateError: both')
  expect(text).toContain('Error: operation')
  expect(text).toContain('Error: cleanup')
  expect(text).toContain('[Repeated error]')
})
