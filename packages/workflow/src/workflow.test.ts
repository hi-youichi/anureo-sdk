import { createFixture } from './test-helpers'
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'
import type { HarnessError } from '@anureo/protocol'
import { z } from 'zod'
import { workflow, parallel, agent, type WorkflowOptions } from './index'
import { canonicalJson, digest } from './persistence/json'
import { record, type JournalEvent } from './persistence/records'

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

/** Supply a scripted input/submit handler that emits terminal failure before returning acceptance.
 * Returning undefined for other calls lets the scripted adapter apply its default behavior. */
function failingExecute(error: HarnessError): NonNullable<FakeAdapterOptions['execute']> {
  return async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error } }, { turnId })
    return { submissionId: call.params.submissionId,
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
    expect(manifest.checkpointFormatVersion).toBe(3)
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
  const manifest = JSON.parse(await readFile(join(options.directory, result.runId, 'run.json'), 'utf8'))
  expect(manifest.journalDigest).toBe(digest(journal))
})

test('resumed runs replay identical agent calls from the journal without new sessions', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  const body = async () =>
    agent('{"value":1}', { client, cwd: options.directory, schema: z.strictObject({ value: z.number() }) })
  const first = await workflow(options, body)
  expect(adapter.opened).toHaveLength(1)
  expect(first.result).toEqual({ value: 1 })
  const second = await workflow({ ...options, resumeFrom: first.runId }, body)
  expect(adapter.opened).toHaveLength(1)
  expect(second.result).toEqual({ value: 1 })
  // The resumed run carries its own journal copy; the source can be deleted.
  await rm(join(options.directory, first.runId), { recursive: true })
  const third = await workflow({ ...options, resumeFrom: second.runId }, body)
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

test('lone surrogates and replacement characters have distinct replay keys', async () => {
  const options = await setup()
  const { client, adapter } = await fixture()
  const first = await workflow(options, () => agent('\ud800', { client, cwd: options.directory }))
  const second = await workflow({ ...options, resumeFrom: first.runId }, () =>
    agent('\ufffd', { client, cwd: options.directory }))
  expect(first.result).toBe('\ud800')
  expect(second.result).toBe('\ufffd')
  expect(adapter.opened).toHaveLength(2)
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
  const failure: unknown = await workflow(options, () => agent('unknown', { client, cwd: options.directory }))
    .then(
      value => { throw new Error(`expected rejection, completed with ${JSON.stringify(value)}`) },
      cause => cause,
    )
  expect(failure).toBeInstanceOf(HarnessSdkError)
  if (!(failure instanceof HarnessSdkError)) throw failure
  expect(failure.outcomeUnknown).toBe(true)
  expect(adapter.opened).toHaveLength(1)
  const runId = failure.details?.runId
  if (typeof runId !== 'string') throw new Error('expected the failed run ID')
  await expect(workflow({ ...options, resumeFrom: runId }, () =>
    agent('unknown', { client, cwd: options.directory })))
    .rejects.toMatchObject({ code: 'WORKFLOW_RECONCILIATION_REQUIRED' })
  expect(adapter.opened).toHaveLength(1)
})

test('a failed journal replacement preserves exact-key uncertainty in the manifest', async () => {
  const options = { ...await setup(), name: 'crash-test' }
  await runCrashFixture(options.directory, 'unpublished-unknown', 0)
  const source = join(options.directory, 'crashed')
  const journal = JSON.parse(await readFile(join(source, 'journal.json'), 'utf8')) as JournalEvent[]
  expect(journal.map(event => event.type)).toEqual(['started'])
  const manifest = JSON.parse(await readFile(join(source, 'run.json'), 'utf8'))
  expect(manifest).toMatchObject({ status: 'failed', journalDigest: digest(journal), failure: {
    outcomeUnknown: true,
    unpublishedUnknownFailures: [{
      ...journal[0], type: 'failed', code: 'NATIVE_FAILED', outcomeUnknown: true,
    }],
  } })

  const { client, adapter } = await crashClient()
  const resumed = { ...options, resumeFrom: 'crashed' }
  await expect(workflow({ ...resumed, runId: 'blocked' }, () => agent('work', { client, cwd: options.directory })))
    .rejects.toMatchObject({ code: 'WORKFLOW_RECONCILIATION_REQUIRED' })
  await expect(workflow({ ...resumed, resumeFrom: 'blocked' }, () => agent('work', { client, cwd: options.directory })))
    .rejects.toMatchObject({ code: 'WORKFLOW_RECONCILIATION_REQUIRED' })
  expect(adapter.opened).toHaveLength(0)
  const other = await workflow(resumed, () => agent('other', { client, cwd: options.directory }))
  expect(other.result).toBe('other')
  await writeFile(join(source, 'journal.json'), '[]')
  await expect(workflow(resumed, () => agent('work', { client, cwd: options.directory })))
    .rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_INVALID' })
  expect(adapter.opened).toHaveLength(1)
})

test('workflow rejections preserve schema diagnostics outside the stored failure summary', async () => {
  const options = { ...await setup(), runId: 'schema-error' }
  const { client, adapter } = await fixture()
  await expect(workflow(options, () => agent('work', {
    client, cwd: options.directory, schema: z.strictObject({ value: z.string().optional() }),
  }))).rejects.toMatchObject({
    code: 'INVALID_PARAMS', details: { rule: 'valueConversionOrNonportableType', runId: options.runId },
  })
  const manifest = JSON.parse(await readFile(join(options.directory, options.runId, 'run.json'), 'utf8'))
  expect(manifest.failure).toEqual({
    code: 'INVALID_PARAMS', retryable: false, outcomeUnknown: false, cleanupFailed: false,
  })
  expect(adapter.opened).toHaveLength(0)
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
  const entered = Promise.withResolvers<void>()
  let ended = false
  const result = workflow(options, () => {
    void agent('slow', { client, cwd: options.directory }).then(() => { ended = true })
    entered.resolve()
    return 'body'
  })
  await entered.promise
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
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const first = workflow({ ...options, runId: 'owned' }, async () => {
    entered.resolve()
    await agent('held', { client, cwd: options.directory })
    await release.promise
    return 'done'
  })
  await entered.promise
  try {
    await expect(workflow({ ...options, runId: 'owned' }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_RUN_EXISTS' })
    await expect(workflow({ ...options, resumeFrom: 'owned' }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_ACTIVE' })
  } finally {
    release.resolve()
    await first
  }
  await expect(workflow({ ...options, runId: 'owned' }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_RUN_EXISTS' })
})

test('initialization rejects invalid identities and releases a failed target claim before entering body', async () => {
  const options = await setup()
  let entered = false
  await expect(workflow({ ...options, runId: '../escape', revision: '' }, () => { entered = true; return {} }))
    .rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Invalid workflow options: runId must be a valid directory basename (at most 255 UTF-8 bytes), revision must be a nonempty string',
    })
  const { client } = await fixture()
  const original = await workflow({ ...options, runId: 'source' }, () => agent('a', { client, cwd: options.directory }))
  await expect(workflow({ ...options, name: 'incompatible', runId: 'target', resumeFrom: original.runId }, () => {
    entered = true; return {}
  })).rejects.toMatchObject({ code: 'WORKFLOW_INCOMPATIBLE_RUN' })
  expect(entered).toBe(false)
  expect(await readdir(join(options.directory, 'target'))).not.toContain('writer.lock')
})

test('overlapping target roots are rejected without creating directories in the source', async () => {
  const options = await setup()
  const first = await workflow(options, () => 'source')
  const source = join(options.directory, first.runId)
  const alias = join(options.directory, 'alias')
  await symlink(source, alias, 'dir')
  const original = await readdir(source)
  for (const root of [source, alias]) {
    await expect(workflow({
      ...options, directory: join(root, 'missing', 'nested'),
      resumeFrom: { directory: options.directory, runId: first.runId },
    }, () => 'bad')).rejects.toMatchObject({ code: 'WORKFLOW_OVERLAPPING_RUNS' })
    expect(await readdir(source)).toEqual(original)
  }
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
  for (const variant of ['bad-json', 'stale', 'missing', 'symlink'] as const) {
    const options = await setup()
    const { client, adapter } = await fixture()
    const first = await workflow(options, () => agent('a', { client, cwd: options.directory }))
    const path = join(options.directory, first.runId, 'journal.json')
    if (variant === 'bad-json') await writeFile(path, '{broken')
    else if (variant === 'stale') await writeFile(path, '[]')
    else {
      await rm(path)
      if (variant === 'symlink') await symlink(join(options.directory, first.runId, 'run.json'), path)
    }
    await expect(workflow({ ...options, resumeFrom: first.runId }, () => agent('a', { client, cwd: options.directory })))
      .rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_INVALID' })
    expect(adapter.opened).toHaveLength(1)
  }
})

test('rejects correctly digested manifests with older format versions', async () => {
  const options = await setup()
  const { client } = await fixture()
  const first = await workflow(options, () => agent('a', { client, cwd: options.directory }))
  const manifestPath = join(options.directory, first.runId, 'run.json')
  const { recordDigest: _, ...payload } = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const checkpointFormatVersion of [1, 2]) {
    await writeFile(manifestPath, canonicalJson(record({ ...payload, checkpointFormatVersion })))
    await expect(workflow({ ...options, resumeFrom: first.runId }, () => 'bad'))
      .rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_INVALID' })
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

test('real process death at durable boundaries replays committed agent work only', async () => {
  for (const phase of ['before-started', 'after-execute', 'before-final', 'after-later-result']) {
    const options = await setup()
    await runCrashFixture(options.directory, phase, 137)
    if (phase === 'before-started' || phase === 'after-execute') {
      const journal = JSON.parse(await readFile(join(options.directory, 'crashed', 'journal.json'), 'utf8')) as JournalEvent[]
      expect(journal.map(event => event.type)).toEqual(phase === 'before-started' ? [] : ['started'])
    }
    const { client, adapter } = await crashClient()
    const result = await workflow({ ...options, name: 'crash-test', resumeFrom: 'crashed' }, async () => {
      const first = agent('work', { client, cwd: options.directory })
      // An unfinished first key permits a rerun without invalidating the second key's saved result.
      return phase === 'after-later-result'
        ? Promise.all([first, agent('later', { client, cwd: options.directory })])
        : first
    })
    expect(result.result).toEqual(phase === 'after-later-result' ? ['work', 'later'] : 'work')
    expect(adapter.opened).toHaveLength(phase === 'before-final' ? 0 : 1)
    if (phase === 'after-later-result') {
      const submissions = adapter.calls.filter(call => call.method === 'input/submit')
      expect(submissions).toHaveLength(1)
      expect(submissions[0]?.params).toMatchObject({ input: [{ type: 'text', text: 'work' }] })
    }
    await client.dispose()
  }
}, 15000)

test('a retry invalidates inherited suffix results even when the process dies before the next call', async () => {
  const options = { ...await setup(), name: 'crash-test' }
  const fail = failingExecute({ code: 'NATIVE_FAILED', message: 'failed', retryable: false, outcomeUnknown: false })
  const { client: sourceClient } = await crashClient({
    async execute(call, sink) {
      if (call.method === 'input/submit' && 'input' in call.params
        && call.params.input.some(part => part.type === 'text' && part.text === 'work')) return fail(call, sink)
      return undefined
    },
  })
  const cwd = options.directory
  const source = await workflow({ ...options, runId: 'source' }, async () => {
    await agent('prefix', { client: sourceClient, cwd })
    await expect(agent('work', { client: sourceClient, cwd })).rejects.toMatchObject({ code: 'NATIVE_FAILED' })
    return agent('later', { client: sourceClient, cwd })
  })
  expect(source.status).toBe('incomplete')
  expect(source.result).toBe('later')
  await runCrashFixture(cwd, 'after-retry', 137)
  const journal = JSON.parse(await readFile(join(cwd, 'crashed', 'journal.json'), 'utf8')) as JournalEvent[]
  expect(journal.slice(-2)).toMatchObject([{ type: 'started' }, { type: 'result', result: 'work' }])

  const { client, adapter } = await crashClient()
  const result = await workflow({ ...options, resumeFrom: 'crashed' }, async () => {
    const prefix = await agent('prefix', { client, cwd })
    const work = await agent('work', { client, cwd })
    const later = await agent('later', { client, cwd })
    return [prefix, work, later]
  })
  expect(result.result).toEqual(['prefix', 'work', 'later'])
  const submissions = adapter.calls.filter(call => call.method === 'input/submit')
  expect(submissions).toHaveLength(1)
  expect(submissions[0]?.params).toMatchObject({ input: [{ type: 'text', text: 'later' }] })
})

async function runCrashFixture(directory: string, phase: string, exitCode: number): Promise<void> {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/workflow-crash.ts', import.meta.url)),
    directory, phase], { stdout: 'ignore', stderr: 'pipe' })
  const error = await new Response(child.stderr).text()
  expect(error).toBe('')
  expect(await child.exited).toBe(exitCode)
}

async function crashClient(options?: FakeAdapterOptions) {
  const adapter = createScriptedAdapter(options)
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'crash-fixture' } })
  clients.push(client)
  return { client, adapter }
}

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
