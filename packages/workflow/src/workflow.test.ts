import { createFixture } from './test-helpers'
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, HarnessSdkError, type Client, type SessionEventSink } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions, type FakeCall } from '@anureo/conformance'
import type { HarnessError } from '@anureo/protocol'
import { z } from 'zod'
import { workflow, pipeline, parallel, agent, type WorkflowOptions } from './index'
import { canonicalJson, digest } from './persistence/json'

const clients: Client[] = []
const fixture = createFixture(clients)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
/** Create isolated run storage; afterEach removes it after disposing the test's clients. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-workflow-'))
  roots.push(directory)
  return { directory, name: 'test', revision: '1', input: {} }
}

/** Emits a failed terminal turn outcome, mirroring native failures. */
function failingExecute(error: HarnessError): NonNullable<FakeAdapterOptions['execute']> {
  return async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error } }, { turnId })
    return { submissionId: (call.params as { submissionId: string }).submissionId,
      accepted: true, disposition: 'started', turnId }
  }
}

test('root runtime exports contain the four independently usable primitives', async () => {
  expect(Object.keys(await import('./index')).sort()).toEqual(['agent', 'parallel', 'pipeline', 'workflow'])
})

test('run identity is durable before body, inputs are isolated, and results are persisted', async () => {
  const options = { ...await setup(), input: { values: [1] } }
  const { client } = await fixture()
  const result = await workflow(options, async run => {
    const manifest = JSON.parse(await readFile(join(options.directory, run.runId, 'run.json'), 'utf8'))
    expect(manifest.identity.runId).toBe(run.runId)
    expect(manifest.status).toBe('running')
    expect(manifest.checkpointFormatVersion).toBe(2)
    expect(Object.isFrozen(run.input.values)).toBe(true)
    expect(Object.isFrozen(options.input.values)).toBe(false)
    return agent('hello', { client, cwd: options.directory })
  })
  expect(result.result).toBe('hello')
  expect(result.status).toBe('completed')
  const stored = await readdir(join(options.directory, result.runId))
  expect(stored.sort()).toEqual(['journal.json', 'result.json', 'run.json'])
  const journal = JSON.parse(await readFile(join(options.directory, result.runId, 'journal.json'), 'utf8'))
  expect(journal).toHaveLength(2)
  expect(journal[1]).toMatchObject({ type: 'result', result: 'hello' })
})

test('resumed runs replay identical agent calls from the journal without new sessions', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  const first = await workflow(options, async () =>
    agent('{"value":1}', { client, cwd: options.directory, schema: z.strictObject({ value: z.number() }) }))
  expect(adapter.opened).toHaveLength(1)
  expect(first.result).toEqual({ value: 1 })
  const second = await workflow({ ...options, resumeFrom: first.runId }, async () =>
    agent('{"value":1}', { client, cwd: options.directory, schema: z.strictObject({ value: z.number() }) }))
  expect(adapter.opened).toHaveLength(1)
  expect(second.result).toEqual({ value: 1 })
  // The resumed run carries its own journal copy; the source can be deleted.
  await rm(join(options.directory, first.runId), { recursive: true })
  const third = await workflow({ ...options, resumeFrom: second.runId }, async () =>
    agent('{"value":1}', { client, cwd: options.directory, schema: z.strictObject({ value: z.number() }) }))
  expect(adapter.opened).toHaveLength(1)
  expect(third.result).toEqual({ value: 1 })
})

test('chained keys invalidate the downstream prefix when any call changes', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  const first = await workflow(options, async () => {
    const a = await agent('a', { client, cwd: options.directory })
    const b = await agent('b', { client, cwd: options.directory })
    return `${a}${b}`
  })
  expect(first.result).toBe('ab')
  expect(adapter.opened).toHaveLength(2)
  const second = await workflow({ ...options, resumeFrom: first.runId }, async () => {
    const a = await agent('a', { client, cwd: options.directory })
    const changed = await agent('CHANGED', { client, cwd: options.directory })
    const b = await agent('b', { client, cwd: options.directory })
    return `${a}${changed}${b}`
  })
  expect(adapter.opened).toHaveLength(4)
  expect(second.result).toBe('aCHANGEDb')
})

test('prompt, options, and client identity changes miss the cache', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  const other = await fixture()
  const first = await workflow(options, () => agent('same', { client, cwd: options.directory, model: 'm1' }))
  expect(adapter.opened).toHaveLength(1)
  await workflow({ ...options, resumeFrom: first.runId }, () => agent('same', { client, cwd: options.directory, model: 'm2' }))
  expect(adapter.opened).toHaveLength(2)
  await workflow({ ...options, resumeFrom: first.runId }, () => agent('other', { client, cwd: options.directory, model: 'm1' }))
  expect(adapter.opened).toHaveLength(3)
  await workflow({ ...options, resumeFrom: first.runId }, () => agent('same', { client: other.client, cwd: options.directory, model: 'm1' }))
  expect(adapter.opened).toHaveLength(3)
  expect(other.adapter.opened).toHaveLength(1)
})

test('name or revision changes reject resume before the body runs', async () => {
  const options = await setup()
  const { client } = await fixture()
  const first = await workflow(options, () => agent('a', { client, cwd: options.directory }))
  for (const update of [{ revision: '2' }, { name: 'other' }]) {
    let entered = false
    await expect(workflow({ ...options, ...update, resumeFrom: first.runId }, () => {
      entered = true; return 'bad'
    })).rejects.toMatchObject({ code: 'WORKFLOW_INCOMPATIBLE_RUN' })
    expect(entered).toBe(false)
  }
})

test('dropped agents never cache and resume repeats them', async () => {
  const options = await setup()
  const { client, adapter } = await fixture({
    execute: failingExecute({ code: 'RATE_LIMITED', message: 'limited', retryable: true, outcomeUnknown: false }),
  })
  const first = await workflow(options, async () =>
    await agent('dropped', { client, cwd: options.directory }))
  expect(first.result).toBeNull()
  expect(first.status).toBe('incomplete')
  await workflow({ ...options, resumeFrom: first.runId }, () => agent('dropped', { client, cwd: options.directory }))
  expect(adapter.opened).toHaveLength(2)
})

test('failed agent outcomes stay incomplete through composition and re-execute on resume', async () => {
  const options = await setup()
  const { client, adapter } = await fixture({
    execute: failingExecute({ code: 'NATIVE_FAILED', message: 'failed', retryable: true, outcomeUnknown: false }),
  })
  const result = await workflow(options, async () =>
    await parallel([() => agent('failing', { client, cwd: options.directory })]))
  expect(result.status).toBe('incomplete')
  expect(result.result).toEqual([null])
  await workflow({ ...options, resumeFrom: result.runId }, () =>
    parallel([() => agent('failing', { client, cwd: options.directory })]))
  expect(adapter.opened).toHaveLength(2)
})

test('unknown previous outcomes require reconciliation instead of silent re-execution', async () => {
  const options = await setup()
  const { client, adapter } = await fixture({
    execute: failingExecute({ code: 'NATIVE_FAILED', message: 'unknown', retryable: false, outcomeUnknown: true }),
  })
  const failure = await workflow(options, () => agent('unknown', { client, cwd: options.directory }))
    .then(value => { throw new Error(`expected rejection, completed with ${JSON.stringify(value)}`) })
    .catch(cause => cause as HarnessSdkError & { details: { runId: string } })
  expect(failure).toBeInstanceOf(HarnessSdkError)
  expect(failure.outcomeUnknown).toBe(true)
  expect(adapter.opened).toHaveLength(1)
  await expect(workflow({ ...options, resumeFrom: failure.details.runId }, () =>
    agent('unknown', { client, cwd: options.directory })))
    .rejects.toMatchObject({ code: 'WORKFLOW_RECONCILIATION_REQUIRED' })
  expect(adapter.opened).toHaveLength(1)
})

test('storage failure is sticky and blocks subsequent agent dispatch', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  let id = ''
  await expect(workflow(options, async run => {
    id = run.runId
    // Moving the run directory breaks every subsequent journal publication.
    await rename(join(options.directory, id), join(options.directory, `${id}-moved`))
    try { await agent('first', { client, cwd: options.directory }) } catch {}
    try { await agent('second', { client, cwd: options.directory }) } catch {}
    return 'caught'
  })).rejects.toMatchObject({ code: 'WORKFLOW_STORAGE_FAILED' })
  // The started marker could not be published, so no session was ever opened.
  expect(adapter.opened).toHaveLength(0)
})

test('body completion waits for already registered unawaited agent work', async () => {
  const options = await setup()
  const { client } = await fixture()
  let resolve!: () => void
  const wait = new Promise<void>(done => { resolve = done })
  let ended = false
  const result = workflow(options, () => {
    void agent('slow', { client, cwd: options.directory }).then(() => { ended = true })
    void wait.then(() => {})
    resolve()
    return 'body'
  })
  await wait
  expect((await result).status).toBe('completed')
  expect(ended).toBe(true)
})

test('agent calls detached from the run context execute as ordinary unjournaled agents', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  let saved!: () => Promise<unknown>
  await workflow(options, () => {
    saved = () => agent('late', { client, cwd: options.directory })
    return 'body'
  })
  // The closure escapes the run's async context, so no journal applies.
  expect(await saved()).toBe('late')
  expect(adapter.opened).toHaveLength(1)
})

test('source activity, target competition, and reused explicit ids reject before body', async () => {
  const options = await setup()
  const { client } = await fixture()
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(done => { entered = done })
  const waiting = new Promise<void>(done => { release = done })
  const first = workflow({ ...options, runId: 'owned' }, async () => {
    entered()
    await agent('held', { client, cwd: options.directory })
    await waiting
    return 'done'
  })
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
  const { client } = await fixture()
  const original = await workflow({ ...options, runId: 'source' }, () => agent('a', { client, cwd: options.directory }))
  await expect(workflow({ ...options, name: 'incompatible', runId: 'target', resumeFrom: original.runId }, () => {
    entered = true; return {}
  })).rejects.toMatchObject({ code: 'WORKFLOW_INCOMPATIBLE_RUN' })
  expect(entered).toBe(false)
  expect(await readdir(join(options.directory, 'target'))).not.toContain('writer.lock')
})

test('preallocated Unicode and spaced output names resume without changing directory meaning', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  const first = await workflow({ ...options, runId: '审查 output' }, () => agent('同', { client, cwd: options.directory }))
  const result = await workflow({ ...options, resumeFrom: first.runId }, () => agent('同', { client, cwd: options.directory }))
  expect(first.runId).toBe('审查 output')
  expect(result.result).toBe('同')
  expect(adapter.opened).toHaveLength(1)
})

test('corrupt or missing recovery materials fail rather than execute', async () => {
  for (const variant of ['bad-json', 'missing', 'symlink'] as const) {
    const options = await setup()
    const { client, adapter } = await fixture()
    const first = await workflow(options, () => agent('a', { client, cwd: options.directory }))
    const path = join(options.directory, first.runId, 'journal.json')
    if (variant === 'bad-json') await writeFile(path, '{broken')
    else {
      await rm(path)
      if (variant === 'symlink') await symlink(join(options.directory, first.runId, 'run.json'), path)
    }
    await expect(workflow({ ...options, resumeFrom: first.runId }, () => agent('a', { client, cwd: options.directory })))
      .rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_INVALID' })
    expect(adapter.opened).toHaveLength(1)
  }
})

test('format-v1 run directories are rejected on resume', async () => {
  const options = await setup()
  const { client } = await fixture()
  const first = await workflow(options, () => agent('a', { client, cwd: options.directory }))
  const manifestPath = join(options.directory, first.runId, 'run.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, checkpointFormatVersion: 1 }))
  await expect(workflow({ ...options, resumeFrom: first.runId }, () => 'bad'))
    .rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_INVALID' })
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

test('real process death at durable boundaries replays committed agent work only', async () => {
  for (const phase of ['before-started', 'after-execute', 'before-final']) {
    const options = await setup()
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/workflow-crash.ts', import.meta.url)),
      options.directory, phase], { stdout: 'ignore', stderr: 'pipe' })
    const code = await child.exited
    expect(code).not.toBe(0)
    const error = await new Response(child.stderr).text()
    expect(error).toBe('')
    const adapter = createScriptedAdapter()
    const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'crash-fixture' } })
    clients.push(client)
    const result = await workflow({ ...options, name: 'crash-test', resumeFrom: 'crashed' }, () =>
      agent('work', { client, cwd: options.directory }))
    expect(result.result).toBe('work')
    expect(adapter.opened).toHaveLength(phase === 'before-final' ? 0 : 1)
    await client.dispose()
  }
}, 15000)

test('an interrupted run reuses the unchanged call prefix in original order', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  await expect(workflow({ ...options, runId: 'partial' }, async () => {
    for (let n = 0; n < 3; n++) await agent(`item-${n}`, { client, cwd: options.directory })
    throw new HarnessSdkError('HOST_STOPPED')
  })).rejects.toMatchObject({ code: 'HOST_STOPPED' })
  expect(adapter.opened).toHaveLength(3)
  const executed: number[] = []
  const result = await workflow({ ...options, resumeFrom: 'partial' }, async () => {
    for (let n = 0; n < 3; n++) await agent(`item-${n}`, { client, cwd: options.directory })
    for (let n = 3; n < 5; n++) { await agent(`item-${n}`, { client, cwd: options.directory }); executed.push(n) }
    return 'done'
  })
  expect(executed).toEqual([3, 4])
  expect(adapter.opened).toHaveLength(5)
  expect(result.status).toBe('completed')
})

/** Compile-only consumer checks for context and awaited body-result inference; never invoked. */
function typeChecks(options: WorkflowOptions<{ files: string[] }>) {
  const run = workflow(options, async context => {
    const file: string = context.input.files[0]!
    const result = await agent('review', {
      client: {} as never, cwd: file, schema: z.strictObject({ value: z.number() }),
    })
    // @ts-expect-error result is inferred from the schema.
    const invalid: string = result.value
    return result === null ? null : result.value
  })
  const positive: Promise<{ runId: string; status: 'completed' | 'incomplete'; result: number | null }> = run
  // @ts-expect-error body result inference is retained.
  const negative: Promise<{ result: string }> = run
  void negative
  return positive
}
void typeChecks
