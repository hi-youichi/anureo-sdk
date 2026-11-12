import { expect, test } from 'bun:test'
import { HarnessSdkError } from '@anureo/sdk'
import { runCli } from '../src/cli'
import { finding, fixture, plan } from './helpers'

function output() {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout: (text: string) => { stdout.push(text) }, stderr: (text: string) => { stderr.push(text) },
    read: () => ({ stdout: stdout.join(''), stderr: stderr.join('') }) }
}

test('help and argument errors never initialize a backend', async () => {
  const io = output()
  let opened = 0
  const dependencies = { ...io, createClient: async () => { opened++; throw new Error('Must not open') } }
  expect(await runCli(['--help'], dependencies)).toBe(0)
  expect(io.read().stdout).toContain('Usage: anureo-review')
  for (const args of [
    ['--unknown'], ['--concurrency', '0'], ['--concurrency', '1.5'], ['a', 'b'],
    ['--max-modules', '0'], ['--max-modules', '1.5'], ['--module', ' '],
    ['--module', 'a', '--module', 'a'], ['--angle', 'missing'],
    ['--angle', 'correctness', '--angle', 'correctness'],
  ]) {
    expect(await runCli(args, dependencies)).toBe(2)
  }
  expect(opened).toBe(0)
})

test.each([
  { flags: ['--max-modules', '1'], moduleId: 'a' },
  { flags: ['--module', 'b'], moduleId: 'b' },
])('CLI reviews only the selected module and angle: %j', async ({ flags, moduleId }) => {
  const { client, cwd, prompts } = await fixture()
  const io = output()
  expect(await runCli([cwd, ...flags, '--angle', 'design', '--json'], { ...io, createClient: async () => client })).toBe(0)
  const report = JSON.parse(io.read().stdout)
  expect(report.scope).toEqual({ moduleIds: [moduleId], angleIds: ['design'] })
  expect(report.modules).toHaveLength(1)
  expect(report.modules[0].angles).toHaveLength(1)
  expect(prompts).toHaveLength(2)
  expect(io.read().stderr).not.toContain('/correctness] started')
})

test('CLI accepts repeated angle selections and preserves their order', async () => {
  const { client, cwd, prompts } = await fixture()
  const io = output()
  expect(await runCli([cwd, '--max-modules', '1', '--angle', 'design', '--angle', 'correctness', '--json'], {
    ...io, createClient: async () => client,
  })).toBe(0)
  expect(JSON.parse(io.read().stdout).scope.angleIds).toEqual(['design', 'correctness'])
  expect(prompts).toHaveLength(3)
})

test('CLI reports available IDs for an unknown module and disposes its client', async () => {
  const { client, cwd, prompts, adapter } = await fixture()
  const io = output()
  expect(await runCli([cwd, '--module', 'missing'], { ...io, createClient: async () => client })).toBe(2)
  expect(prompts).toHaveLength(1)
  expect(io.read().stdout).toBe('')
  expect(io.read().stderr).toContain('Available: a, b')
  expect(adapter.disposeCount).toBe(1)
})

test.each([false, true])('CLI prints JSON separately from progress, disposes client, and returns findings exit code: %s', async hasFindings => {
  const { client, cwd, adapter } = await fixture(prompt => prompt.startsWith('Analyze') ? plan : {
    findings: hasFindings && prompt.includes('"id":"a"') ? [finding] : [],
  })
  const io = output()
  const code = await runCli([cwd, '--json', '--model', 'test-model', '--focus', 'Test focus', '--concurrency', '1'], { ...io, createClient: async () => client })
  expect(code).toBe(hasFindings ? 1 : 0)
  expect(JSON.parse(io.read().stdout).status).toBe('completed')
  expect(io.read().stderr).toContain('[analysis] started')
  expect(io.read().stderr).toContain(`[workflow] ${JSON.parse(io.read().stdout).runId}`)
  expect(io.read().stderr).toContain('[a/correctness] completed')
  expect(adapter.opened.every(session => session.model === 'test-model')).toBe(true)
  expect(adapter.disposeCount).toBe(1)
})

test('CLI accepts a custom workflow directory and includes its run identity in the report', async () => {
  const { client, cwd } = await fixture()
  const io = output()
  const directory = `${cwd}/saved-runs`
  expect(await runCli([cwd, '--workflow-dir', directory, '--json'], { ...io, createClient: async () => client })).toBe(0)
  const report = JSON.parse(io.read().stdout)
  expect(report.workflowDirectory).toBe(directory)
  expect(report.runId).toBeString()
})

test('partial reviews retain failed coverage in JSON and exit 2', async () => {
  const { client, cwd, adapter } = await fixture(prompt => prompt.startsWith('Analyze') ? plan : new HarnessSdkError('RATE_LIMITED'))
  const io = output()
  expect(await runCli([cwd, '--json'], { ...io, createClient: async () => client })).toBe(2)
  const report = JSON.parse(io.read().stdout)
  expect(report.status).toBe('incomplete')
  expect(report.modules[0].angles[0].status).toBe('failed')
  expect(adapter.disposeCount).toBe(1)
})

test('analysis failures and cleanup errors dispose the client and exit 2', async () => {
  const failed = await fixture(() => new HarnessSdkError('NATIVE_FAILED'))
  const io = output()
  expect(await runCli([failed.cwd], { ...io, createClient: async () => failed.client })).toBe(2)
  expect(io.read().stdout).toBe('')
  expect(io.read().stderr).toContain('anureo-review:')
  expect(failed.adapter.disposeCount).toBe(1)

  const clean = await fixture()
  const dispose = clean.client.dispose.bind(clean.client)
  clean.client.dispose = async () => { await dispose(); throw new Error('Cleanup failed') }
  expect(await runCli([clean.cwd], { ...io, createClient: async () => clean.client })).toBe(2)
  expect(io.read().stderr).toContain('Cleanup failed')
  clean.client.dispose = dispose
})
