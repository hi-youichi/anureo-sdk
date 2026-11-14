import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { AHP_PROTOCOL_CONTRACT } from '@anureo/protocol'
import { createClient } from '@anureo/sdk'
import { attachGateway } from '../src/attach'
import { startFake, until as waitUntil } from './helpers'

const until = (predicate: () => Promise<boolean>) => waitUntil(predicate, 'Resource state not observed')

const initialize = { protocolVersions: [1], protocolContract: AHP_PROTOCOL_CONTRACT, clientInfo: { name: 'resource-test', version: '1' } }

test('fixture startup rejects an invalid readiness record and reaps the child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-hermes-startup-'))
  const pidFile = join(directory, 'pid'), responder = join(directory, 'responder.mjs')
  try {
    await writeFile(responder, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
console.log('{}')
`)
    await expect(startFake('lifecycle', { FAKE_HERMES_RESPONSE_MODULE: pathToFileURL(responder).href }))
      .rejects.toThrow('Invalid Hermes fixture startup record')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('attach preserves a timeout when child disposal rejects and still awaits stderr', async () => {
  let releasePipes!: () => void
  const released = new Promise<void>(resolve => { releasePipes = resolve })
  let drained = false
  const child: HarnessProcess = {
    pid: 1, owned: false,
    stdout: { async *[Symbol.asyncIterator]() { await released } },
    stderr: { async *[Symbol.asyncIterator]() { await released; await Bun.sleep(0); drained = true } },
    exited: Promise.resolve({ code: null, signal: 'SIGTERM' }),
    write: async () => {},
    closeInput: async () => {},
    async dispose() {
      releasePipes()
      throw Object.assign(new Error('private diagnostics'), { code: 'PROCESS_DISPOSE_FAILED' })
    },
  }
  await expect(attachGateway({ processFactory: async () => child, timeoutMs: 10 }, 'attach')).rejects.toMatchObject({
    code: 'HARNESS_UNAVAILABLE', retryable: true, outcomeUnknown: false,
    details: { cleanupCode: 'PROCESS_DISPOSE_FAILED' },
  })
  expect(drained).toBe(true)
})

test('disposing during attach aborts and reaps its real child process', async () => {
  const fake = await startFake(), children: HarnessProcess[] = []
  const adapter = fake.adapter({ env: { FAKE_HERMES_HANG: '1' }, processFactory: async options => {
    const child = await spawnHarnessProcess(options); children.push(child); return child
  } })
  const pending = adapter.initialize(initialize).then(() => undefined, cause => cause)
  try {
    await until(async () => children.length === 1)
    await adapter.dispose()
    expect(await pending).toMatchObject({ code: 'RUNTIME_DISPOSED' })
    const exit = await children[0]!.exited
    expect(exit.signal !== null || exit.code !== 0).toBe(true)
  } finally { await adapter.dispose(); await fake.dispose() }
})

test('disposing during runtime.describe closes its probe socket instead of waiting for request timeout', async () => {
  const fake = await startFake('describe-hang'), adapter = fake.adapter({ timeoutMs: 20_000 })
  const pending = adapter.initialize(initialize).then(() => undefined, cause => cause)
  try {
    await until(async () => (await fake.state()).methods.includes('runtime.describe'))
    await adapter.dispose()
    expect(await pending).toMatchObject({ code: 'CONNECTION_CLOSED', outcomeUnknown: false })
    await until(async () => (await fake.state()).connections === 0)
  } finally { await adapter.dispose(); await fake.dispose() }
})

test('adapter submission limits reject before dispatch without disrupting the running execution', async () => {
  const fake = await startFake('hold')
  const client = await createClient({ adapter: fake.adapter({ maxSubmissions: 1 }), identity: { adapterId: 'hermes', runtimeConfigId: 'bounded' } })
  try {
    const session = await client.sessions.create({ cwd: process.cwd() }), first = await session.submit({ input: 'first' })
    let error: unknown
    try { await session.submit({ input: 'second' }) } catch (cause) { error = cause }
    expect(error).toMatchObject({ code: 'BACKPRESSURE_EXCEEDED', outcomeUnknown: false })
    expect((await fake.state()).inputs).toHaveLength(1)
    await first.interrupt()
    expect((await first.result()).status).toBe('interrupted')
  } finally { await client.dispose(); await fake.dispose() }
})
