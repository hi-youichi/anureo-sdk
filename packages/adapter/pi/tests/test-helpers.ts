import { randomUUID } from 'node:crypto'
import { createClient, type Client, type Session, type Turn } from '@anureo/sdk'
import type { AhpEvent, AhpRequestMap, AhpResultMap } from '@anureo/protocol'
import { createPiAdapter, type PiAdapterOptions } from '../src/index'
import { fakeFactory, type FakePiHost } from './fake-host'

export interface Fixture {
  client: Client
  session: Session
  events: AhpEvent[]
  hosts: FakePiHost[]
  opens: ReturnType<typeof fakeFactory>['opens']
  host: FakePiHost
  adapter: ReturnType<typeof createPiAdapter>
  dispose(): Promise<void>
}

/** Collects every event of a session in the background; close errors are expected and ignored. */
export function collect(session: Session): { events: AhpEvent[]; stop(): Promise<void> } {
  const events: AhpEvent[] = []
  const reader = session.events()[Symbol.asyncIterator]()
  const task = (async () => { try { for (;;) { const next = await reader.next(); if (next.done) break; events.push(next.value) } } catch { /* OBSERVATION_CLOSED */ } })()
  return { events, stop: async () => { await reader.return?.(); await task } }
}

export async function fixture(options: Partial<PiAdapterOptions> = {}, create: Parameters<Client['sessions']['create']>[0] = { cwd: process.cwd() }): Promise<Fixture> {
  const fake = fakeFactory()
  const adapter = createPiAdapter({ version: '1.5.2', createHost: fake.factory, ...options })
  const client = await createClient({ adapter, identity: { adapterId: 'pi', runtimeConfigId: 'test' } })
  const session = await client.sessions.create(create)
  const collector = collect(session)
  return {
    client, session, events: collector.events, hosts: fake.hosts, opens: fake.opens, adapter, host: fake.hosts[0]!,
    async dispose() { await collector.stop(); await client.dispose() },
  }
}

export const observe = (promise: Promise<Turn>): Promise<Turn> => { void promise.catch(() => {}); return promise }

export function request<M extends 'history/read' | 'compact/start' | 'session/config/set' | 'goal/set' | 'review/start'>(
  session: Session, method: M, params: Omit<AhpRequestMap[M], 'sessionId' | 'requestId'>,
): Promise<AhpResultMap[M]> {
  return session.request(method, { ...params, sessionId: session.id, requestId: randomUUID() } as AhpRequestMap[M])
}

export const types = (events: AhpEvent[]) => events.map(event => event.type)
export const until = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now()
  while (!predicate()) { if (Date.now() - start > timeoutMs) throw new Error('until timed out'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
