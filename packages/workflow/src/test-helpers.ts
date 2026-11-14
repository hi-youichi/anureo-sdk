// Scripted client setup shared by workflow tests; each suite retains its own disposal registry.
import { randomUUID } from 'node:crypto'
import { createClient, type Client } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'

/** Bind fixture creation to a suite's afterEach registry. Successful clients are registered for
 * caller-owned disposal; initialization failures reject before registration. */
export function createFixture(clients: Client[]) {
  return async function fixture(options?: FakeAdapterOptions) {
    const adapter = createScriptedAdapter(options)
    const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
    clients.push(client)
    return { client, adapter }
  }
}
