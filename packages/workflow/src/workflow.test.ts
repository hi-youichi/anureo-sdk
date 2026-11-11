import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessSdkError } from '@anureo/sdk'
import { z } from 'zod'
import { workflow, pipeline, parallel, type WorkflowContext, type WorkflowOptions } from './index'
import { canonicalJson, digest } from './persistence/json'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-workflow-'))
  roots.push(directory)
  return { directory, name: 'test', revision: '1', input: {} }
}
const schema = z.strictObject({ value: z.number() })
const step = { key: 'one', input: {}, schema, recovery: 'repeatable' as const }

test('root runtime exports contain the four independently usable primitives', async () => {
  expect(Object.keys(await import('./index')).sort()).toEqual(['agent', 'parallel', 'pipeline', 'workflow'])
})

test('run identity is durable before body, inputs are isolated, and results are persisted', async () => {
  const options = { ...await setup(), input: { values: [1] } }
  const result = await workflow(options, async run => {
    const manifest = JSON.parse(await readFile(join(options.directory, run.runId, 'run.json'), 'utf8'))
    expect(manifest.identity.runId).toBe(run.runId)
    expect(manifest.status).toBe('running')
    expect(Object.isFrozen(run.input.values)).toBe(true)
    expect(Object.isFrozen(options.input.values)).toBe(false)
    return run.step(step, () => ({ value: 0 }))
  })
  expect(result.result).toEqual({ value: 0 })
  expect(result.status).toBe('completed')
  expect(await readdir(join(options.directory, result.runId))).not.toContain('writer.lock')
  expect(JSON.parse(await readFile(join(options.directory, result.runId, 'result.json'), 'utf8'))).toEqual(result.result)
})

test('resumption validates and copies committed values without executing, and survives source deletion', async () => {
  const options = await setup()
  let calls = 0
  const first = await workflow({ ...options, runId: 'first' }, run => run.step(step, () => ({ value: ++calls })))
  let validations = 0
  const second = await workflow({ ...options, runId: 'second', resumeFrom: first.runId }, run =>
    run.step({ ...step, reuse: value => { validations++; return value.value === 1 } }, () => ({ value: ++calls })))
  await rm(join(options.directory, first.runId), { recursive: true })
  const third = await workflow({ ...options, resumeFrom: second.runId }, run => run.step(step, () => ({ value: ++calls })))
  expect(calls).toBe(1)
  expect(validations).toBe(1)
  expect(third.result.value).toBe(1)
})

test('input, root input, schema and revision changes invalidate repeatable steps', async () => {
  const options = await setup()
  let calls = 0
  const first = await workflow(options, run => run.step(step, () => ({ value: ++calls })))
  for (const update of [{ revision: '2' }, { input: { changed: true } }]) {
    await workflow({ ...options, ...update, resumeFrom: first.runId }, run => run.step(step, () => ({ value: ++calls })))
  }
  await workflow({ ...options, resumeFrom: first.runId }, run => run.step({ ...step, input: { changed: true } }, () => ({ value: ++calls })))
  await workflow({ ...options, resumeFrom: first.runId }, run => run.step({ ...step,
    schema: z.strictObject({ value: z.number().min(0) }) }, () => ({ value: ++calls })))
  expect(calls).toBe(5)
})

test('manual reconciliation and branch-skipped history persist across repeated recovery', async () => {
  const options = await setup()
  const first = await workflow(options, async run => {
    try { await run.step(step, () => { throw new HarnessSdkError('KNOWN_FAILURE') }) } catch {}
    return 'partial'
  })
  const second = await workflow({ ...options, resumeFrom: first.runId }, () => 'branch skipped')
  let calls = 0
  await expect(workflow({ ...options, resumeFrom: second.runId }, run =>
    run.step({ ...step, recovery: 'manual' }, () => ({ value: ++calls })))).rejects.toMatchObject({ code: 'WORKFLOW_RECONCILIATION_REQUIRED' })
  expect(calls).toBe(0)
  expect(first.status).toBe('incomplete')
})

test('a newer failed attempt shadows an older successful result across resumes', async () => {
  const options = await setup()
  const first = await workflow(options, run => run.step(step, () => ({ value: 1 })))
  const second = await workflow({ ...options, resumeFrom: first.runId }, async run => {
    try {
      await run.step({ ...step, input: { changed: true } }, () => { throw new HarnessSdkError('KNOWN_FAILURE') })
    } catch {}
    return 'failed attempt'
  })
  let calls = 0
  await expect(workflow({ ...options, resumeFrom: second.runId }, run =>
    run.step({ ...step, recovery: 'manual' }, () => ({ value: ++calls })))).rejects
    .toMatchObject({ code: 'WORKFLOW_RECONCILIATION_REQUIRED' })
  expect(calls).toBe(0)
})

test('null and caught failures remain incomplete through both composition primitives', async () => {
  const options = await setup()
  const result = await workflow(options, async run => {
    const a = await pipeline([0, 1], index => run.step({ ...step, key: `pipe-${index}` }, () => index ? null : { value: 0 }))
    const b = await parallel([() => run.step({ ...step, key: 'parallel' }, () => { throw new HarnessSdkError('KNOWN_FAILURE') })])
    return { a, b }
  })
  expect(result.status).toBe('incomplete')
  expect(result.result).toEqual({ a: [{ value: 0 }, null], b: [null] })
})

test('duplicate keys never start a second callback, and late calls reject', async () => {
  const options = await setup()
  let calls = 0
  let saved!: WorkflowContext<{}>
  const result = await workflow(options, async run => {
    saved = run
    return parallel([() => run.step(step, () => ({ value: ++calls })), () => run.step(step, () => ({ value: ++calls }))])
  })
  expect(calls).toBe(1)
  expect(result.status).toBe('incomplete')
  await expect(saved.step({ ...step, key: 'late' }, () => ({ value: ++calls }))).rejects.toMatchObject({ code: 'WORKFLOW_CLOSED' })
})

test('unknown and attached cleanup failures stop dispatch even when caught by the body', async () => {
  for (const failure of [new HarnessSdkError('LOST', 'lost', false, true),
    new HarnessSdkError('PRIMARY', 'primary', false, false, { cleanupErrors: [{ code: 'CLEANUP', outcomeUnknown: false }] })]) {
    const options = await setup()
    let calls = 0
    await expect(workflow(options, async run => {
      try { await run.step(step, () => { throw failure }) } catch {}
      try { await run.step({ ...step, key: 'next' }, () => ({ value: ++calls })) } catch {}
      return 'caught'
    })).rejects.toMatchObject({ code: failure.code, outcomeUnknown: failure.outcomeUnknown, details: { runId: expect.any(String) } })
    expect(calls).toBe(0)
  }
})

test('storage failure is sticky, creates no successful marker and blocks subsequent work', async () => {
  const options = await setup()
  let calls = 0
  let id = ''
  await expect(workflow(options, async run => {
    id = run.runId
    await rename(join(options.directory, id, 'results'), join(options.directory, id, 'old-results'))
    try { await run.step(step, () => ({ value: ++calls })) } catch {}
    try { await run.step({ ...step, key: 'later' }, () => ({ value: ++calls })) } catch {}
    return 'caught'
  })).rejects.toMatchObject({ code: 'WORKFLOW_STORAGE_FAILED' })
  expect(calls).toBe(1)
  expect(await readdir(join(options.directory, id, 'checkpoints'))).toEqual([])
})

test('body completion waits for already registered unawaited work', async () => {
  const options = await setup()
  let resolve!: () => void
  const wait = new Promise<void>(done => { resolve = done })
  let ended = false
  const result = workflow(options, run => {
    void run.step(step, async () => { await wait; ended = true; return { value: 1 } })
    resolve()
    return 'body'
  })
  expect((await result).status).toBe('completed')
  expect(ended).toBe(true)
})

test('source activity, target competition, and reused explicit ids reject before body', async () => {
  const options = await setup()
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(done => { entered = done })
  const waiting = new Promise<void>(done => { release = done })
  const first = workflow({ ...options, runId: 'owned' }, async () => { entered(); await waiting; return 'done' })
  await ready
  try {
    await expect(workflow({ ...options, runId: 'owned' }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_RUN_EXISTS' })
    await expect(workflow({ ...options, resumeFrom: 'owned' }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_ACTIVE' })
  } finally { release(); await first }
  await expect(workflow({ ...options, runId: 'owned' }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_RUN_EXISTS' })
})

test('initialization rejects invalid identities and releases a failed target claim before entering body', async () => {
  const options = await setup()
  let entered = false
  await expect(workflow({ ...options, runId: '../escape' }, () => { entered = true; return {} }))
    .rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  const original = await workflow({ ...options, runId: 'source' }, () => ({}))
  await expect(workflow({ ...options, name: 'incompatible', runId: 'target', resumeFrom: original.runId }, () => {
    entered = true; return {}
  })).rejects.toMatchObject({ code: 'WORKFLOW_INCOMPATIBLE_RUN' })
  expect(entered).toBe(false)
  expect(await readdir(join(options.directory, 'target'))).not.toContain('writer.lock')
})

test('preallocated Unicode and spaced output names resume without changing directory meaning', async () => {
  const options = await setup()
  let calls = 0
  const first = await workflow({ ...options, runId: '审查 output' }, run => run.step(step, () => ({ value: ++calls })))
  const result = await workflow({ ...options, resumeFrom: first.runId }, run => run.step(step, () => ({ value: ++calls })))
  expect(first.runId).toBe('审查 output')
  expect(result.result.value).toBe(1)
  expect(calls).toBe(1)
})

test('corrupt or missing recovery materials fail rather than execute', async () => {
  for (const variant of ['bad-json', 'missing', 'symlink'] as const) {
    const options = await setup()
    const first = await workflow(options, run => run.step(step, () => ({ value: 1 })))
    const path = join(options.directory, first.runId, 'results')
    const filename = (await readdir(path))[0]!
    if (variant === 'bad-json') await writeFile(join(path, filename), '{broken')
    else {
      await rm(join(path, filename))
      if (variant === 'symlink') await symlink(join(options.directory, first.runId, 'result.json'), join(path, filename))
    }
    let calls = 0
    await expect(workflow({ ...options, resumeFrom: first.runId }, run => run.step(step, () => ({ value: ++calls }))))
      .rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_INVALID' })
    expect(calls).toBe(0)
  }
})

test('strict JSON rejects lossy inputs and canonical hashes ignore object insertion order', () => {
  for (const value of [undefined, NaN, Infinity, new Date(), [undefined], Array(1), { a: undefined },
    Object.defineProperty({}, 'hidden', { value: 1 }), { get a() { return 1 } }]) {
    expect(() => canonicalJson(value)).toThrow()
  }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(() => canonicalJson(cyclic)).toThrow()
  expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }))
})

test('real process death at durable boundaries recovers committed work and repeats only uncommitted work', async () => {
  for (const phase of ['before-started', 'after-execute', 'before-marker', 'after-marker', 'before-final']) {
    const options = await setup()
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/workflow-crash.ts', import.meta.url)),
      options.directory, phase], { stdout: 'ignore', stderr: 'pipe' })
    const code = await child.exited
    expect(code).not.toBe(0)
    const error = await new Response(child.stderr).text()
    expect(error).toBe('')
    let repeated = 0
    const result = await workflow({ ...options, name: 'crash-test', resumeFrom: 'crashed' }, run =>
      run.step({ ...step, key: 'work' }, () => { repeated++; return { value: 7 } }))
    expect(result.result.value).toBe(7)
    expect(repeated).toBe(['after-marker', 'before-final'].includes(phase) ? 0 : 1)
  }
}, 15000)

test('a 73-of-100 interrupted run reuses 73 committed steps regardless of invocation order', async () => {
  const options = await setup()
  await expect(workflow({ ...options, runId: 'partial' }, async run => {
    for (let n = 0; n < 73; n++) await run.step({ ...step, key: `item-${n}`, input: { n } }, () => ({ value: n }))
    throw new HarnessSdkError('HOST_STOPPED')
  })).rejects.toMatchObject({ code: 'HOST_STOPPED' })
  let executed = 0
  const result = await workflow({ ...options, resumeFrom: 'partial' }, run =>
    pipeline(Array.from({ length: 100 }, (_, i) => 99 - i), n =>
      run.step({ ...step, key: `item-${n}`, input: { n } }, () => { executed++; return { value: n } })))
  expect(executed).toBe(27)
  expect(result.status).toBe('completed')
  expect(result.result.map(value => value?.value)).toEqual(Array.from({ length: 100 }, (_, i) => 99 - i))
}, 15000)

function typeChecks(options: WorkflowOptions<{ files: string[] }>) {
  const run = workflow(options, async context => {
    const file: string = context.input.files[0]!
    const result = await context.step({ ...step, input: { file } }, () => ({ value: 1 }))
    // @ts-expect-error result is inferred from the schema.
    const invalid: string = result.value
    // @ts-expect-error schema constrains the execution result.
    await context.step({ ...step, key: 'invalid' }, () => ({ value: 'text' }))
    return result.value
  })
  const positive: Promise<{ runId: string; status: 'completed' | 'incomplete'; result: number }> = run
  // @ts-expect-error body result inference is retained.
  const negative: Promise<{ result: string }> = run
  return positive
}
void typeChecks
