import { expect, test } from 'bun:test'
import { createClient } from '@anureo/sdk'
import { createHermesAdapter } from '../src'
import { validateGrant } from '../src/attach'
import { startFake } from './helpers'

const grant = () => ({ state: 'ready', protocol: 'hermes-gateway-v1', url: 'ws://127.0.0.1:12345/api/ws',
  protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.fake'], ticket: 'fake', client_code_sha: 'same',
  endpoint: { code_sha: 'same', profile_id: 'profile', instance_id: 'owner' } })

test.each(['ws://example.com/api/ws', 'ws://127.0.0.1:12345/api/ws?ticket=fake', 'ws://user:password@127.0.0.1/api/ws', 'http://127.0.0.1/api/ws', 'ws://127.0.0.1/other'])('attach refuses noncanonical endpoint %s', url => {
  expect(() => validateGrant({ ...grant(), url })).toThrow()
})
test('attach checks both the negotiated wire and the ticket protocols without exposing credentials in errors', () => {
  expect(() => validateGrant({ ...grant(), protocols: ['wrong', 'hermes-gateway-ticket.fake'] })).toThrow()
  expect(() => validateGrant({ ...grant(), ticket: 'another' })).toThrow()
  expect(() => createHermesAdapter({ reconnectAttempts: -1 })).toThrow()
  expect(() => createHermesAdapter({ maxPending: 0 })).toThrow()
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
