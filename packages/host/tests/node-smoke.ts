import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createHarnessHost, createScopedHostDispatcher } from '../src/index'
import { HarnessStore } from '../src/sqlite-node'
import { listenHostWebSocket } from '../src/ws'

const directory = mkdtempSync(join(tmpdir(), 'anureo-host-node-'))
try {
  const file = join(directory, 'hx.sqlite')
  const store = new HarnessStore(file)
  assert.throws(() => new HarnessStore(file), /HOST_STORAGE_IN_USE/)
  store.saveSession({
    id: 'one', projectId: 'project', ownerId: 'owner', adapterId: 'test', runtimeConfigId: 'test',
    binding: { sessionId: 'one', adapterId: 'test', runtimeConfigId: 'test' },
    cwd: directory, config: {}, revision: 1, latestSeq: 0, status: 'closed', archived: false,
  })
  store.close()
  const actor = { userId: 'owner' }
  const host = createHarnessHost({
    store: new HarnessStore(file),
    runtimes: [],
    resolveWorkspace: () => directory,
    authorize: (candidate, scope) => candidate.userId === actor.userId && scope === 'project',
  })
  try {
    const listener = await listenHostWebSocket({
      dispatcher: createScopedHostDispatcher(host),
      authenticate: request => request.headers.get('authorization') === 'Bearer test' ? () => actor : null,
    })
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${listener.address.port}/rpc`, { headers: { Authorization: 'Bearer test' } })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      let id = 0
      function request(method: string, params: object): Promise<{ result: unknown }> {
        return new Promise((resolve, reject) => {
          socket.once('message', data => resolve(JSON.parse(data.toString())))
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), error => { if (error) reject(error) })
        })
      }
      const initialized = await request('hx.initialize', { protocolVersions: [1], clientInfo: { name: 'test', version: '1' } })
      assert.equal((initialized.result as { protocolVersion: number }).protocolVersion, 1)
      const remote = await request('hx.session.list', { scopeId: 'project' })
      assert.deepEqual(remote.result, await host.sessions.list({ actor }, { scopeId: 'project' }))
    } finally {
      await listener.close()
    }
  } finally {
    await host.close()
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
