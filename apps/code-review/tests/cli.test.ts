import { expect, test } from 'bun:test'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import type { ApprovalOption } from '@anureo/protocol'
import { runCli } from '../src/cli'
import { createReviewClient } from '../src/client'
import { finding, fixture, output, plan } from './helpers'

test.each([
  { semantics: ['deny', 'allowWithRule', 'allowSession', 'allowOnce'], expected: 'allowOnce' },
  { semantics: ['allowOnce'], expected: 'allowOnce' },
  { semantics: ['deny', 'allowWithRule', 'allowSession'], expected: 'allowSession' },
  { semantics: ['deny', 'allowWithRule'], expected: 'allowWithRule' },
  { semantics: ['deny', 'cancel'], expected: undefined },
  { semantics: [undefined], expected: undefined },
] satisfies Array<{ semantics: ApprovalOption['semantic'][]; expected: ApprovalOption['semantic'] }>)('production client preserves config and auto-approves known allow options: %j', async ({ semantics, expected }) => {
  const codex = createScriptedAdapter()
  const cwd = process.cwd()
  const client = await createReviewClient(cwd, 'codex', codex)
  try {
    await client.openSession({
      requestId: 'open', mode: 'new', cwd,
      binding: { sessionId: 'policy', adapterId: 'codex', runtimeConfigId: 'code-review' },
      config: { permissionMode: 'agent-full-access', custom: 'preserved' },
    })
    expect(codex.opened[0]?.config).toEqual({ permissionMode: 'agent-full-access', custom: 'preserved' })
    const responses: unknown[] = []
    const pending = codex.sinks.get('policy')!.requestInteraction({
      interactionId: 'approval', kind: 'approval', options: semantics.map((semantic, index) => ({
        id: `option-${index}`, label: `Option ${index}`, ...(semantic !== undefined ? { semantic } : {}),
      })),
    }, async response => { responses.push(response) })
    if (expected !== undefined) {
      const answer = { kind: 'approval' as const, optionId: `option-${semantics.findIndex(semantic => semantic === expected)}` }
      await expect(pending).resolves.toEqual(answer)
      expect(responses).toEqual([answer])
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'INTERACTION_CANCELLED' })
      expect(responses).toEqual([null])
    }
  } finally { await client.dispose() }
  expect(codex.disposeCount).toBe(1)
})

test('production Claude client construction and disposal work with an injected adapter', async () => {
  // Injected adapter: do not touch the machine's real Claude login home.
  const claude = createScriptedAdapter()
  const client = await createReviewClient(process.cwd(), 'claude', claude)
  await client.dispose()
  expect(claude.disposeCount).toBe(1)
})

test('help and argument errors never initialize a backend', async () => {
  const io = output()
  let opened = 0
  const dependencies = { ...io, createClient: async () => { opened++; throw new Error('Must not open') } }
  expect(await runCli(['--help'], dependencies)).toBe(0)
  expect(io.read().stdout).toContain('Usage: anureo-review')
  expect(await runCli(['--help', '--harness', 'missing'], dependencies)).toBe(0)
  for (const args of [
    ['--unknown'], ['--help', '--unknown'], ['--concurrency', '0'], ['--concurrency', '1.5'], ['a', 'b'],
    ['--max-modules', '0'], ['--max-modules', '1.5'], ['--module', ' '],
    ['--module', 'a', '--module', 'a'], ['--angle', 'missing'],
    ['--angle', 'correctness', '--angle', 'correctness'],
    ['--harness', 'missing'],
  ]) {
    expect(await runCli(args, dependencies)).toBe(2)
  }
  const duplicateAngle = output()
  expect(await runCli(['--angle', 'missing', '--angle', 'missing'], { ...dependencies, ...duplicateAngle })).toBe(2)
  expect(duplicateAngle.read().stderr).toContain('--angle requires unique angle ids')
  expect(opened).toBe(0)
})

test('CLI selects the requested harness and defaults to codex', async () => {
  const io = output()
  const harnesses: string[] = []
  const dependencies = { ...io, createClient: async (_cwd: string, harness: string) => { harnesses.push(harness); throw new Error('Stop') } }
  expect(await runCli(['--harness', 'hermes', '.'], dependencies)).toBe(2)
  expect(await runCli(['.'], dependencies)).toBe(2)
  expect(harnesses).toEqual(['hermes', 'codex'])
  const unknown = output()
  expect(await runCli(['--harness', 'missing', '.'], { ...unknown, createClient: async () => { throw new Error('Must not open') } })).toBe(2)
  expect(unknown.read().stderr).toContain('Unknown harness: missing')
  expect(unknown.read().stderr).toContain('Available: codex, claude, hermes, pi')
})

test('directory preflight failures never initialize a backend', async () => {
  const { cwd } = await fixture()
  const canonicalFile = await realpath(`${cwd}/a.ts`)
  const io = output()
  let opened = 0
  const dependencies = { ...io, createClient: async () => { opened++; throw new Error('Must not open') } }
  expect(await runCli([`${cwd}/a.ts`], dependencies)).toBe(2)
  expect(io.read().stderr).toContain(`Review directory is not a directory: ${canonicalFile}`)
  expect(await runCli([`${cwd}/missing`], dependencies)).toBe(2)
  expect(io.read().stdout).toBe('')
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
  expect(report.modules[0].review.angles).toHaveLength(1)
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
  const report = JSON.parse(io.read().stdout)
  expect(report.status).toBe('completed')
  expect(io.read().stderr).toContain('[analysis] started')
  expect(io.read().stderr).toContain(`[workflow] ${report.runId}`)
  expect(io.read().stderr).toContain('[a/correctness] completed')
  expect(adapter.opened.every(session => session.model === 'test-model')).toBe(true)
  expect(adapter.disposeCount).toBe(1)
})

test('CLI accepts a custom workflow directory and includes its run identity in the report', async () => {
  const { client, cwd } = await fixture()
  const io = output()
  const directory = join(cwd, 'saved-runs')
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
  expect(report.modules[0].review.angles[0].status).toBe('failed')
  expect(adapter.disposeCount).toBe(1)
})

test('CLI retains progress callback errors in the report and still disposes its client', async () => {
  const { client, cwd, adapter } = await fixture()
  const io = output()
  expect(await runCli([cwd, '--json'], {
    stdout: io.stdout, stderr: () => { throw new Error('Progress output failed') }, createClient: async () => client,
  })).toBe(0)
  const report = JSON.parse(io.read().stdout)
  expect(report.status).toBe('completed')
  expect(report.progressErrors.length).toBeGreaterThan(0)
  expect(report.progressErrors.every((error: { message: string }) => error.message === 'Progress output failed')).toBe(true)
  expect(adapter.disposeCount).toBe(1)
})

test('CLI prints the report before disposal and waits for disposal before returning', async () => {
  const { client, cwd, adapter } = await fixture()
  const io = output()
  const dispose = client.dispose.bind(client)
  const disposalStarted = Promise.withResolvers<void>()
  const finishDisposal = Promise.withResolvers<void>()
  client.dispose = async () => { disposalStarted.resolve(); await finishDisposal.promise; await dispose() }
  let settled = false
  const pending = runCli([cwd, '--json'], { ...io, createClient: async () => client })
  pending.then(() => { settled = true }, () => { settled = true })
  try {
    await disposalStarted.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(JSON.parse(io.read().stdout).status).toBe('completed')
    expect(settled).toBe(false)
    expect(adapter.disposeCount).toBe(0)
    finishDisposal.resolve()
    expect(await pending).toBe(0)
    expect(adapter.disposeCount).toBe(1)
  } finally {
    finishDisposal.resolve()
    await pending
    client.dispose = dispose
  }
})

test.each([false, true])('report-output failures still dispose the client (cleanup fails: %s)', async cleanupFails => {
  const { client, cwd, adapter } = await fixture()
  const dispose = client.dispose.bind(client)
  client.dispose = async () => { await dispose(); if (cleanupFails) throw new Error('Cleanup failed') }
  const io = output()
  try {
    expect(await runCli([cwd, '--json'], {
      stdout: () => { throw new Error('Report output failed') }, stderr: io.stderr, createClient: async () => client,
    })).toBe(2)
    expect(io.read().stderr).toContain('anureo-review: Report output failed')
    if (cleanupFails) expect(io.read().stderr).toContain('anureo-review: client cleanup failed: Cleanup failed')
    expect(adapter.disposeCount).toBe(1)
  } finally { client.dispose = dispose }
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

test.each([false, true])('CLI retains execution and cleanup errors together (unknown outcome: %s)', async unknown => {
  const code = unknown ? 'RECEIPT_LOST' : 'NATIVE_FAILED'
  const { client, cwd } = await fixture(() => new HarnessSdkError(code, 'Original execution failure', false, unknown))
  const dispose = client.dispose.bind(client)
  client.dispose = async () => { await dispose(); throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Cleanup failed') }
  const io = output()
  try {
    expect(await runCli([cwd], { ...io, createClient: async () => client })).toBe(2)
    expect(io.read().stderr).toContain('Original execution failure')
    expect(io.read().stderr).toContain(`[${code}]`)
    expect(io.read().stderr).toContain('Cleanup failed [RESOURCE_RELEASE_FAILED]')
    if (unknown) expect(io.read().stderr).toContain('execution outcome unknown')
  } finally { client.dispose = dispose }
})
