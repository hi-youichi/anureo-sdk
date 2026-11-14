import { expect, test } from 'bun:test'
import { createClient } from '@anureo/sdk'
import { createHermesAdapter } from '../src'
import { attachGateway, validateGrant, type AttachMode } from '../src/attach'
import { HermesRpcError, receipt } from '../src/native'
import { startFake } from './helpers'

const grant = () => ({ state: 'ready', protocol: 'hermes-gateway-v1', url: 'ws://127.0.0.1:12345/api/ws',
  protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.fake'], ticket: 'fake', client_code_sha: 'same',
  endpoint: { code_sha: 'same', profile_id: 'profile', instance_id: 'owner' } })

test.each(['ws://example.com/api/ws', 'ws://127.0.0.1:12345/api/ws?ticket=fake', 'ws://user:password@127.0.0.1/api/ws', 'http://127.0.0.1/api/ws', 'ws://127.0.0.1/other'])('attach refuses noncanonical endpoint %s', url => {
  expect(() => validateGrant({ ...grant(), url })).toThrow()
})
test('attach checks both the negotiated wire and the ticket protocols without exposing credentials in errors', () => {
  const safeMessage = /^Invalid Hermes gateway message$/
  expect(() => validateGrant({ ...grant(), protocols: ['wrong', 'hermes-gateway-ticket.fake'] })).toThrow(safeMessage)
  expect(() => validateGrant({ ...grant(), ticket: 'another' })).toThrow(safeMessage)
})

test('invalid numeric limits fail before opening a native connection', () => {
  expect(() => createHermesAdapter({ reconnectAttempts: -1, maxPending: 0 })).toThrow(expect.objectContaining({
    code: 'INVALID_PARAMS',
    details: { issues: ['maxPending must be a positive safe integer', 'reconnectAttempts must be a nonnegative safe integer'] },
  }))
})

test.each([
  ['attach', 1234, '1.234'],
  ['start', undefined, '25'],
  ['recover', 25_250, '15.25'],
  ['start', 1200, '0.6'],
] as const)('attach passes a CLI timeout for %s with response timeout %p', async (mode: AttachMode, timeoutMs, expected) => {
  const calls: string[][] = []
  await attachGateway({ timeoutMs, processFactory: async ({ args }) => {
    calls.push([...(args ?? [])])
    return {
      pid: 1, owned: false,
      stdout: new Blob([JSON.stringify(grant())]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve({ code: 0, signal: null }),
      write: async () => {},
      closeInput: async () => {},
      dispose: async () => {},
    }
  } }, mode)
  expect(calls[0]?.slice(-2)).toEqual(['--timeout', expected])
})

test.each(['queued', 'unknown', 'started'])('receipt rejects an array containing %s as its wire status', status => {
  const native = { admission_id: 'admission', sequence: 1, authority_epoch: 1,
    status: [status], execution_generation: null, ref: { profile_id: 'profile', session_id: 'session' } }
  expect(() => receipt(native, 'profile', 'session')).toThrow('Invalid Hermes gateway message')
})

test('a read-only storage error remains retryable and redacted', () => {
  const failure = new HermesRpcError({ code: 5001, message: 'private cause', data: { reason: 'storage_unavailable' } }, false)
  expect(failure).toMatchObject({ code: 'HARNESS_UNAVAILABLE', retryable: true, outcomeUnknown: false,
    message: 'Hermes gateway refused the request' })
})

test.each([
  ['submit-storage-error', 'HARNESS_UNAVAILABLE'],
  ['submit-internal-error', 'NATIVE_RPC_ERROR'],
  ['submit-malformed-error', 'PROTOCOL_ERROR'],
])('%s preserves submission uncertainty after admission', async (scenario, code) => {
  const fake = await startFake(scenario)
  const client = await createClient({ adapter: fake.adapter({ reconnectAttempts: 0 }),
    identity: { adapterId: 'hermes', runtimeConfigId: 'submit-error' } })
  try {
    const session = await client.sessions.create({ cwd: process.cwd() })
    await expect(session.submit({ input: 'hello' })).rejects.toMatchObject({ code, retryable: false, outcomeUnknown: true })
    expect((await fake.state()).inputs).toHaveLength(1)
  } finally { await client.dispose(); await fake.dispose() }
})

test('attach-only mode never ensures or recovers a shared owner', async () => {
  const fake = await startFake()
  const client = await createClient({ adapter: fake.adapter({ startup: 'attach', profile: 'selected' }), identity: { adapterId: 'hermes', runtimeConfigId: 'selected' } })
  try {
    const session = await client.sessions.create({ cwd: process.cwd() })
    await (await session.submit({ input: 'hello' })).result()
    const calls = (await fake.state()).attachArgs
    expect(calls.every(args => !args.includes('--start') && !args.includes('--recover'))).toBe(true)
    expect(calls[0]!.slice(0, 2)).toEqual(['-p', 'selected'])
  } finally { await client.dispose(); await fake.dispose() }
})

test('explicit toolsets are copied and forwarded, including the empty selection', async () => {
  const fake = await startFake()
  const toolsets: string[] = []
  const adapter = fake.adapter({ toolsets })
  toolsets.push('terminal')
  const exposed = adapter.options
  exposed.toolsets!.push('terminal')
  exposed.args!.length = 0
  delete exposed.env!.FAKE_HERMES_URL
  exposed.maxFrameBytes = 1
  const client = await createClient({ adapter, identity: { adapterId: 'hermes', runtimeConfigId: 'toolsets' } })
  try {
    await client.sessions.create({ cwd: process.cwd(), model: 'glm-5.3' })
    const state = await fake.state()
    expect(state.createParams).toHaveLength(1)
    expect(state.createParams[0]).toMatchObject({ source: 'tool', model: 'glm-5.3', toolsets: [] })
    expect(state.inputs).toHaveLength(0)
  } finally { await client.dispose(); await fake.dispose() }
})

test('a gateway without toolset selection is rejected before session creation', async () => {
  const fake = await startFake('no-toolsets')
  const client = await createClient({ adapter: fake.adapter({ toolsets: [] }), identity: { adapterId: 'hermes', runtimeConfigId: 'toolsets' } })
  try {
    await expect(client.sessions.create({ cwd: process.cwd() })).rejects.toMatchObject({ code: 'HERMES_GATEWAY_UNSUPPORTED', outcomeUnknown: false })
    const state = await fake.state()
    expect(state.methods).not.toContain('session.create')
    expect(state.inputs).toHaveLength(0)
  } finally { await client.dispose(); await fake.dispose() }
})

test.each([null, '', [null], [''], ['\0'], [42]].map(toolsets => ({ toolsets })))('invalid toolset selection fails locally: %j', ({ toolsets }) => {
  expect(() => createHermesAdapter({ toolsets: toolsets as unknown as string[] })).toThrow(expect.objectContaining({
    message: 'Invalid Hermes adapter options',
    details: { issues: ['toolsets must be an array of nonblank strings without NUL'] },
  }))
})
