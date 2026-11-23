import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedHarnessAdapter } from '@anureo/conformance'
import { createClient } from '@anureo/sdk'
import { WebSocket } from 'ws'
import { createHarnessHost, createScopedHostDispatcher, type Principal } from '../src/index'
import { HarnessStore } from '../src/sqlite-bun'
import { createHostWebSocket, listenHostWebSocket } from '../src/ws'
import type { RpcNotification, RpcResponse } from '../src/rpc'

const actor: Principal = { userId: 'reader', mode: 'on' }
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function fixture(directory: string) {
  const host = createHarnessHost({
    store: new HarnessStore(join(directory, 'hx.sqlite')),
    resolveWorkspace: () => directory,
    authorize: (principal, scope) => principal.userId === actor.userId && scope === 'workspace',
    runtimes: [{
      id: 'fake',
      adapterId: 'scripted',
      create: () => createClient({ adapter: new ScriptedHarnessAdapter(), identity: { adapterId: 'scripted', runtimeConfigId: 'fake' } }),
    }],
  })
  cleanups.push(() => host.close())
  return host
}

test('embedded WebSocket cleans up subscriptions registered by requests finishing after disconnect', async () => {
  let finish!: () => void
  const late = new Promise<void>(resolve => { finish = resolve })
  const registrations = new Set<string>()
  const sent: string[] = []
  const transport = createHostWebSocket<Principal>({
    dispatcher: {
      async handle(connection, request) {
        await late
        registrations.add(connection.id)
        return { jsonrpc: '2.0', id: request.id, result: true }
      },
      disconnect(id) { registrations.delete(id) },
    },
  })
  const connection = transport.attach({ send(text) { sent.push(text) }, close() {} }, () => actor, 'socket')
  await connection.receive('{')
  expect(JSON.parse(sent[0]!)).toMatchObject({ error: { code: -32700 } })
  const response = connection.dispatch({ id: 1, method: 'hx.events.subscribe' })
  connection.disconnect()
  finish()
  await response
  expect(registrations.size).toBe(0)
  expect(sent).toHaveLength(1)
})

test('standalone WebSocket reaches the same durable, scoped list as the local Host API', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anureo-host-ws-'))
  const host = fixture(directory)
  expect(() => new HarnessStore(join(directory, 'hx.sqlite'))).toThrow('HOST_STORAGE_IN_USE')
  const listener = await listenHostWebSocket({
    dispatcher: createScopedHostDispatcher(host),
    authenticate: request => request.headers.get('authorization') === 'Bearer test' ? () => actor : null,
  })
  cleanups.push(() => listener.close())
  const socket = new WebSocket(`ws://127.0.0.1:${listener.address.port}/rpc`, { headers: { Authorization: 'Bearer test' } })
  cleanups.push(() => socket.terminate())
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  let id = 0
  const pending = new Map<number, (response: RpcResponse) => void>()
  const notifications: RpcNotification[] = []
  const terminal = Promise.withResolvers<void>()
  socket.on('message', data => {
    const message = JSON.parse(data.toString()) as RpcResponse | RpcNotification
    if ('method' in message) {
      notifications.push(message)
      if (message.method === 'hx.event' && (message.params as { event?: { type: string } }).event?.type === 'turn/completed') terminal.resolve()
    }
    else if (message.id !== null) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  function request(method: string, params: object): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const requestId = ++id
      pending.set(requestId, resolve)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), error => {
        if (error) { pending.delete(requestId); reject(error) }
      })
    })
  }
  expect(await request('hx.initialize', { protocolVersions: [1], clientInfo: { name: 'test', version: '1' } })).toHaveProperty('result.protocolVersion', 1)
  for (const key of ['first', 'second']) {
    expect(await request('hx.session.create', { scopeId: 'workspace', runtimeConfigId: 'fake', idempotencyKey: key })).toHaveProperty('result.state', 'completed')
  }
  const first = await host.sessions.list({ actor }, { scopeId: 'workspace', limit: 1 })
  expect(first.sessions).toHaveLength(1)
  expect(first.nextCursor).toBe(first.sessions[0]!.id)
  const remote = await request('hx.session.list', { scopeId: 'workspace', limit: 1 })
  expect(remote).toHaveProperty('result', first)
  expect(await request('hx.session.list', { scopeId: 'private' })).toHaveProperty('error.data.code', 'PROJECT_FORBIDDEN')
  await expect(host.sessions.list({ actor }, { scopeId: 'private' })).rejects.toHaveProperty('code', 'PROJECT_FORBIDDEN')
  const sessionId = first.sessions[0]!.id
  const subscription = await request('hx.events.subscribe', { sessionId, afterSeq: 0 })
  const { cutoverSeq } = subscription.result as { cutoverSeq: number }
  const turnRequest = { sessionId, idempotencyKey: 'turn', expectedRevision: 1, input: [{ type: 'text', text: 'hello' }] }
  expect(await request('hx.turn.start', turnRequest)).toHaveProperty('result.state', 'completed')
  await terminal.promise
  const page = (await request('hx.events.read', { sessionId, afterSeq: cutoverSeq })).result as { events: Array<{ hostSeq: number; event: { type: string } }> }
  expect(page.events.map(event => event.hostSeq)).toEqual(page.events.map((_, index) => cutoverSeq + index + 1))
  expect(page.events.some(event => event.event.type === 'turn/completed')).toBe(true)
  expect(notifications.some(notice => notice.method === 'hx.event')).toBe(true)
  await listener.close()
  await host.close()
  const reopened = fixture(directory)
  const last = await reopened.sessions.list({ actor }, { scopeId: 'workspace', cursor: first.nextCursor!, limit: 1 })
  expect(last.sessions).toHaveLength(1)
  expect(last.sessions[0]!.id).not.toBe(first.sessions[0]!.id)
  expect(last.nextCursor).toBeNull()
})
