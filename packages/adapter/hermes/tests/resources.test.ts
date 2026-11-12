import { expect, test } from 'bun:test'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { AHP_PROTOCOL_CONTRACT } from '@anureo/protocol'
import { createClient } from '@anureo/sdk'
import { startFake } from './helpers'

const initialize = { protocolVersions: [1], protocolContract: AHP_PROTOCOL_CONTRACT, clientInfo: { name: 'resource-test', version: '1' } }
async function until(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('Resource state not observed')
}

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
