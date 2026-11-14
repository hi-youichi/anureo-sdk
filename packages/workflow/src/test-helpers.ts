// Scripted client setup shared by workflow tests; each suite retains its own disposal registry.
import { randomUUID } from 'node:crypto'
import { createClient, type Client } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'

/**
 * Give the agent and workflow suites a factory for initialized scripted clients. Register each
 * initialized client in the caller's registry. Both suites dispose those clients in afterEach.
 * Initialization failures reject before registration.
 */
export function createFixture(clients: Client[]) {
  /**
   * Forward optional hook and capability overrides to the scripted adapter. Return the initialized
   * client and adapter for dispatch assertions. Give each fixture a distinct runtime identity so
   * journal replay can distinguish clients.
   */
  return async function fixture(options?: FakeAdapterOptions) {
    const adapter = createScriptedAdapter(options)
    const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
    clients.push(client)
    return { client, adapter }
  }
}
