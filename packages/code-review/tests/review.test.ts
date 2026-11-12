import { expect, test } from 'bun:test'
import { readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { correctnessAngle, defaultAngles, designAngle, formatReport, reviewCode, type ReviewProgress } from '../src'
import { reviewFailure } from '../src/errors'
import { createReviewClient } from '../src/client'
import { startFake } from '../../hermes/tests/helpers'
import { finding, fixture, plan } from './helpers'

const angles = [correctnessAngle, { id: 'contracts', title: 'Contracts', instructions: 'Check caller contracts.' }]

test('Hermes submits analysis instructions through input instead of session options', async () => {
  const { cwd } = await fixture()
  const native = await startFake('mcp')
  try {
    const client = await createReviewClient(cwd, 'hermes', native.adapter())
    try {
      // This gateway submits { sum: 42 }, which intentionally fails the module-plan schema.
      // Reaching that turn proves the real adapter accepted the session and analysis input.
      await expect(reviewCode({ client, cwd })).rejects.toMatchObject({ code: 'HERMES_TURN_FAILED' })
      const state = await native.state()
      expect(state.creates).toBe(1)
      expect(state.inputs).toHaveLength(1)
      expect(state.inputs[0]?.text).toContain('Analyze this codebase')
      expect(state.inputs[0]?.text).toContain('Read and analyze source code only. Do not modify files,')
    } finally { await client.dispose() }
  } finally { await native.dispose() }
})

test('analysis finishes before nested module/angle reviews, which run concurrently in stable order', async () => {
  const analysisGate = Promise.withResolvers<void>()
  const analysisStarted = Promise.withResolvers<void>()
  const reviewsReady = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  let reviews = 0
  const { client, cwd, adapter, prompts } = await fixture(async prompt => {
    if (prompt.startsWith('Analyze')) { analysisStarted.resolve(); await analysisGate.promise; return plan }
    active++
    peak = Math.max(peak, active)
    if (++reviews === 4) reviewsReady.resolve()
    await finish.promise
    active--
    return { findings: [] }
  })
  const events: ReviewProgress[] = []
  const pending = reviewCode({ client, cwd, angles, concurrency: 4, model: 'review-model', focus: 'Check cleanup', onProgress: event => events.push(event) })
  await analysisStarted.promise
  expect(prompts).toHaveLength(1)
  expect(events).toEqual([
    expect.objectContaining({ stage: 'workflow', status: 'started' }),
    { stage: 'analysis', status: 'started' },
  ])
  analysisGate.resolve()
  await reviewsReady.promise
  expect(peak).toBe(4)
  finish.resolve()
  const report = await pending
  expect(report.status).toBe('completed')
  expect(report.modules.map(result => [result.module.id, result.angles.map(result => result.angle.id)]))
    .toEqual([['a', ['correctness', 'contracts']], ['b', ['correctness', 'contracts']]])
  expect(prompts.every(prompt => prompt.includes('Check cleanup'))).toBe(true)
  expect(prompts.every(prompt => prompt.includes('Read and analyze source code only. Do not modify files,'))).toBe(true)
  expect(adapter.opened.every(session => session.instructions === undefined)).toBe(true)
  expect(adapter.opened.every(session => session.model === 'review-model')).toBe(true)
  expect([...adapter.backends.values()].every(backend => backend.disposeCount === 1)).toBe(true)
  expect(adapter.disposeCount).toBe(0)
  expect(events).toHaveLength(11)
})

test('one shared concurrency limit bounds agents across both levels', async () => {
  const ready = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  let reviews = 0
  const { client, cwd } = await fixture(async prompt => {
    if (prompt.startsWith('Analyze')) return plan
    active++
    peak = Math.max(peak, active)
    reviews++
    if (active === 2) ready.resolve()
    await finish.promise
    active--
    return { findings: [] }
  })
  const pending = reviewCode({ client, cwd, angles, concurrency: 2 })
  await ready.promise
  expect(reviews).toBe(2)
  finish.resolve()
  expect((await pending).status).toBe('completed')
  expect(reviews).toBe(4)
  expect(peak).toBe(2)
})

test('defaults to correctness, code quality, and design angles and passes their full instructions', async () => {
  const { client, cwd, prompts } = await fixture(prompt => prompt.startsWith('Analyze') ? plan : {
    findings: prompt.includes('"id":"a"') && prompt.includes('Angle: Correctness') ? [finding] : [],
  })
  const report = await reviewCode({ client, cwd })
  expect(defaultAngles.map(angle => angle.id)).toEqual(['correctness', 'code-quality', 'design'])
  expect(prompts).toHaveLength(7)
  for (const angle of defaultAngles) {
    expect(prompts.filter(prompt => prompt.includes(`Angle: ${angle.title}\n${angle.instructions}`))).toHaveLength(2)
  }
  for (const module of report.modules) {
    expect(module.angles.map(result => result.angle.id)).toEqual(['correctness', 'code-quality', 'design'])
  }
  expect(report.modules[0]?.angles[0]).toMatchObject({ status: 'completed', findings: [finding] })
  expect(formatReport(report)).toContain('[P2] Incorrect fallback (a.ts:1-1)')
  expect(formatReport(report)).toContain('Suggestion: Treat zero as a valid value')
  expect(prompts.filter(prompt => prompt.includes('In each suggestion,'))).toHaveLength(prompts.length - 1)
  expect(formatReport(report)).toContain('No findings.')
})

test.each(['RATE_LIMITED', 'NATIVE_FAILED'])('failed angle %s preserves coverage and releases its scheduler slot', async code => {
  const { client, cwd, adapter } = await fixture(prompt => {
    if (prompt.startsWith('Analyze')) return plan
    if (prompt.includes('"id":"a"') && prompt.includes('Angle: Correctness')) {
      return new HarnessSdkError(code, 'Review unavailable')
    }
    return { findings: [] }
  })
  const report = await reviewCode({ client, cwd, angles, concurrency: 1 })
  expect(report.status).toBe('incomplete')
  const result = report.modules[0]!.angles[0]!
  expect(result.status).toBe('failed')
  if (result.status === 'failed') {
    expect(result.error.code).toBe(code === 'RATE_LIMITED' ? 'REVIEW_AGENT_INCOMPLETE' : code)
    expect(result.error.outcomeUnknown).toBe(false)
  }
  expect(report.modules[0]?.angles[1]?.status).toBe('completed')
  expect(report.modules[1]?.angles.every(result => result.status === 'completed')).toBe(true)
  expect(adapter.opened).toHaveLength(5)
  expect(formatReport(report)).toContain('Review failed:')
  const manifest = JSON.parse(await readFile(join(report.workflowDirectory, report.runId, 'run.json'), 'utf8'))
  expect(manifest.status).toBe('incomplete')
  const journal = JSON.parse(await readFile(join(report.workflowDirectory, report.runId, 'journal.json'), 'utf8'))
  expect(journal.filter((event: { type: string }) => event.type === 'result')).toHaveLength(4)
  expect(journal.filter((event: { type: string }) => event.type === 'failed')).toHaveLength(1)
})

test('failure normalization retains only valid issue paths and codes', () => {
  const issues = [
    { path: '/findings/0/severity', code: 'enum' },
    { path: ['findings', 0, 'lineStart'], code: 'too_small' },
  ]
  const error = new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_INVALID', 'Invalid output', false, false, {
    issues: [...issues.map(issue => ({ ...issue, message: 'Private diagnostic' })),
      null, { path: null, code: 'type' }, { path: ['findings', {}], code: 'type' },
      { path: ['findings', -1], code: 'type' }, { path: '/', code: 1 }, { path: '/', code: '' }],
    privateDetail: 'Do not expose',
  })
  expect(reviewFailure(error)).toEqual({ message: 'Invalid output', code: error.code, outcomeUnknown: false, issues })
  expect(reviewFailure(new Error('Ordinary failure'))).toEqual({ message: 'Ordinary failure', code: null, outcomeUnknown: false })
})

test('schema-invalid findings retain diagnostics in text and persisted JSON reports', async () => {
  const { client, cwd } = await fixture(prompt => prompt.startsWith('Analyze') ? plan : {
    findings: [{ ...finding, severity: 'invalid' }],
  })
  const report = await reviewCode({ client, cwd, maxModules: 1, angles: [correctnessAngle] })
  expect(report.modules[0]?.angles[0]).toMatchObject({ status: 'failed', error: {
    code: 'STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false,
    issues: [{ path: '/findings/0/severity', code: 'enum' }],
  } })
  expect(formatReport(report)).toContain('Validation issue: "/findings/0/severity" [enum]')
  expect(JSON.parse(await readFile(join(report.workflowDirectory, report.runId, 'result.json'), 'utf8'))).toEqual(report)
})

test('scripted startup-blocked terminal details produce a dropped agent result', async () => {
  const { client, cwd } = await fixture(prompt => prompt.startsWith('Analyze') ? plan
    : new HarnessSdkError('AGENT_STARTUP_BLOCKED', 'Blocked', false, false, { workflowDisposition: 'startup_blocked' }))
  const report = await reviewCode({ client, cwd, maxModules: 1, angles: [correctnessAngle] })
  expect(report.modules[0]?.angles[0]).toMatchObject({ status: 'failed', error: { code: 'REVIEW_AGENT_INCOMPLETE' } })
})

test('scripted native cleanup metadata stops further agent dispatch', async () => {
  const { client, cwd, adapter } = await fixture(prompt => prompt.startsWith('Analyze') ? plan
    : new HarnessSdkError('NATIVE_FAILED', 'Cleanup failed', false, false, { cleanupFailed: true }))
  await expect(reviewCode({ client, cwd, angles, concurrency: 1 })).rejects.toMatchObject({
    code: 'NATIVE_FAILED', outcomeUnknown: false, details: { cleanupFailed: true },
  })
  expect(adapter.opened).toHaveLength(2)
})

test('persists the run, validated analysis, every angle result, and the final report', async () => {
  const { client, cwd, prompts } = await fixture()
  const directory = join(cwd, 'custom-workflows')
  const report = await reviewCode({ client, cwd, workflowDirectory: directory })
  const path = join(report.workflowDirectory, report.runId)
  const manifest = JSON.parse(await readFile(join(path, 'run.json'), 'utf8'))
  expect(manifest.identity).toMatchObject({ name: 'code-review', revision: '5', runId: report.runId })
  expect(manifest.identity.input.analysisPrompt).toBe(prompts[0])
  expect(manifest.identity.input.concurrency).toBe(8)
  expect(manifest.status).toBe('completed')
  const journal = JSON.parse(await readFile(join(path, 'journal.json'), 'utf8'))
  expect(journal.filter((event: { type: string }) => event.type === 'result')).toHaveLength(prompts.length)
  expect(JSON.parse(await readFile(join(path, 'result.json'), 'utf8'))).toEqual(report)
  expect(await readdir(path)).not.toContain('writer.lock')

  // Each invocation reviews current sources/configuration rather than silently reusing old claims.
  const second = await reviewCode({ client, cwd, workflowDirectory: directory })
  expect(second.runId).not.toBe(report.runId)
  expect(prompts).toHaveLength(2 * (1 + plan.modules.length * defaultAngles.length))
})

test.each(['RECEIPT_LOST', 'RESOURCE_RELEASE_FAILED'])('fatal %s stops new agent dispatch and saves a failed run', async code => {
  const { client, cwd, adapter } = await fixture(prompt => prompt.startsWith('Analyze')
    ? plan : new HarnessSdkError(code, 'Execution failed', false, code === 'RECEIPT_LOST'))
  let cause: unknown
  try { await reviewCode({ client, cwd, angles, concurrency: 1 }) }
  catch (error) { cause = error }
  expect(cause).toBeInstanceOf(HarnessSdkError)
  const error = cause as HarnessSdkError
  expect(error.code).toBe(code)
  expect(adapter.opened).toHaveLength(2)
  const path = join(String(error.details!.directory), String(error.details!.runId))
  const manifest = JSON.parse(await readFile(join(path, 'run.json'), 'utf8'))
  expect(manifest.status).toBe('failed')
  expect(manifest.failure.outcomeUnknown).toBe(code === 'RECEIPT_LOST')
  expect(manifest.failure.cleanupFailed).toBe(code === 'RESOURCE_RELEASE_FAILED')
  expect(await readdir(path)).not.toContain('writer.lock')
})

test('unwritable workflow storage fails before model execution', async () => {
  const { client, cwd, adapter } = await fixture()
  await expect(reviewCode({ client, cwd, workflowDirectory: join(cwd, 'a.ts') })).rejects.toMatchObject({ code: 'WORKFLOW_STORAGE_FAILED' })
  expect(adapter.opened).toHaveLength(0)
})

test('limits review to one module and one angle without dropping the full analysis plan', async () => {
  const { client, cwd, prompts } = await fixture()
  const report = await reviewCode({ client, cwd, maxModules: 1, angles: [correctnessAngle] })
  expect(prompts).toHaveLength(2)
  expect(report.status).toBe('completed')
  expect(report.plan.modules).toHaveLength(2)
  expect(report.modules.map(result => result.module.id)).toEqual(['a'])
  expect(report.scope).toEqual({ moduleIds: ['a'], angleIds: ['correctness'] })
  expect(formatReport(report)).toContain('Scope: 1 of 2 planned modules; angles: correctness')
  const path = join(report.workflowDirectory, report.runId)
  const journal = JSON.parse(await readFile(join(path, 'journal.json'), 'utf8'))
  expect(journal.filter((event: { type: string }) => event.type === 'result')).toHaveLength(2)
  expect(JSON.parse(await readFile(join(path, 'run.json'), 'utf8')).identity.input.maxModules).toBe(1)
})

test('selects an exact module and a built-in angle before scheduling review work', async () => {
  const { client, cwd, prompts } = await fixture()
  const report = await reviewCode({ client, cwd, moduleIds: ['b'], angles: [designAngle] })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('"id":"b"')
  expect(prompts[1]).toContain('Angle: Design')
  expect(report.modules.map(result => result.module.id)).toEqual(['b'])
  expect(report.scope).toEqual({ moduleIds: ['b'], angleIds: ['design'] })
})

test('module limit applies to the filtered modules in analysis order', async () => {
  const { client, cwd } = await fixture()
  const report = await reviewCode({ client, cwd, moduleIds: ['b', 'a'], maxModules: 1, angles: [correctnessAngle] })
  expect(report.scope.moduleIds).toEqual(['a'])
})

test('unknown module IDs fail after analysis and before any reviewer starts', async () => {
  const { client, cwd, prompts } = await fixture()
  await expect(reviewCode({ client, cwd, moduleIds: ['missing'] })).rejects.toMatchObject({
    code: 'REVIEW_MODULE_NOT_FOUND', message: 'Unknown module ids: missing. Available: a, b',
  })
  expect(prompts).toHaveLength(1)
})

test.each([
  { summary: 'Empty', modules: [] },
  { ...plan, modules: [plan.modules[0], plan.modules[0]] },
  { ...plan, modules: [plan.modules[0], { ...plan.modules[1], files: ['a.ts'] }] },
  { ...plan, modules: [{ ...plan.modules[0], files: ['missing.ts'] }] },
  { ...plan, modules: [{ ...plan.modules[0], files: ['.'] }] },
])('invalid module analysis aborts before any reviewer is started: %j', async invalidPlan => {
  const { client, cwd, adapter } = await fixture(() => invalidPlan)
  await expect(reviewCode({ client, cwd })).rejects.toBeInstanceOf(Error)
  expect(adapter.opened).toHaveLength(1)
})

test('module paths cannot escape the review directory through symlinks', async () => {
  const outside = await fixture()
  const inside = await fixture(() => ({ ...plan, modules: [{ ...plan.modules[0], files: ['linked.ts'] }] }))
  await symlink(join(outside.cwd, 'a.ts'), join(inside.cwd, 'linked.ts'))
  await expect(reviewCode({ client: inside.client, cwd: inside.cwd })).rejects.toThrow('outside the review directory')
  expect(inside.adapter.opened).toHaveLength(1)
})

test('null module analysis cannot become an empty successful report', async () => {
  const { client, cwd, adapter } = await fixture(() => new HarnessSdkError('RATE_LIMITED'))
  await expect(reviewCode({ client, cwd })).rejects.toThrow('Module analysis failed')
  expect(adapter.opened).toHaveLength(1)
})

test.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('finding locations recognize source line terminator %j', async ending => {
  const expected = { ...finding, lineStart: 2, lineEnd: 2 }
  const { client, cwd } = await fixture(prompt => prompt.startsWith('Analyze') ? plan : { findings: [expected] })
  await writeFile(join(cwd, 'a.ts'), `export const first = 1${ending}export const second = 2${ending}`)
  const report = await reviewCode({ client, cwd, maxModules: 1, angles: [correctnessAngle] })
  expect(report.status).toBe('completed')
  expect(report.modules[0]?.angles[0]).toMatchObject({ status: 'completed', findings: [expected] })
})

test.each([
  { ...finding, file: 'b.ts' },
  { ...finding, lineStart: 2, lineEnd: 1 },
  { ...finding, lineEnd: 2 },
  { ...finding, file: 'missing.ts' },
])('unsupported finding locations fail the angle while siblings finish: %j', async invalidFinding => {
  const { client, cwd } = await fixture(prompt => prompt.startsWith('Analyze') ? plan : {
    findings: prompt.includes('"id":"a"') ? [invalidFinding] : [],
  })
  const report = await reviewCode({ client, cwd })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.angles[0]?.status).toBe('failed')
  expect(report.modules[1]?.angles[0]).toMatchObject({ status: 'completed', findings: [] })
})

test('invalid options are rejected before opening any sessions', async () => {
  const { client, cwd, adapter } = await fixture()
  for (const concurrency of [0, -1, NaN, 1.5, Infinity]) {
    await expect(reviewCode({ client, cwd, concurrency })).rejects.toThrow('concurrency')
  }
  for (const invalidAngles of [[], [correctnessAngle, correctnessAngle], [{ ...correctnessAngle, instructions: '' }]]) {
    await expect(reviewCode({ client, cwd, angles: invalidAngles })).rejects.toThrow('Review angles')
  }
  for (const maxModules of [0, -1, NaN, 1.5, Infinity]) {
    await expect(reviewCode({ client, cwd, maxModules })).rejects.toThrow('maxModules')
  }
  for (const moduleIds of [[], [''], [' '], ['a', 'a']]) {
    await expect(reviewCode({ client, cwd, moduleIds })).rejects.toThrow('moduleIds')
  }
  await expect(reviewCode({ client, cwd: join(cwd, 'a.ts') })).rejects.toThrow('not a directory')
  expect(adapter.opened).toHaveLength(0)
})
