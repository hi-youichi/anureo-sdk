/** SDK-facing fixtures for Pi adapter tests. */
import { randomUUID } from 'node:crypto'
import { createClient, type Client, type Session, type Turn } from '@anureo/sdk'
import type { AhpEvent, AhpRequestMap, AhpResultMap } from '@anureo/protocol'
import { createPiAdapter, type PiAdapterOptions } from '../src/index'
import { fakeFactory, type FakePiHost } from './fake-host'

/** Inspect an initial session and its live event log. Dispose the fixture to release all sessions opened through its client. */
export interface Fixture {
  client: Client
  session: Session
  events: AhpEvent[]
  /** Factory-acquired hosts, in order. A createHost override bypasses this list. */
  hosts: FakePiHost[]
  opens: ReturnType<typeof fakeFactory>['opens']
  /** Initial host from the default factory, if the fixture uses it. */
  host: FakePiHost
  adapter: ReturnType<typeof createPiAdapter>
  /** Stop event collection before releasing the client and its sessions. */
  dispose(): Promise<void>
}

/** Subscribe to future events and append them in arrival order. Read failures end collection silently. Await stop to detach and join the reader. */
export function collect(session: Session): { events: AhpEvent[]; stop(): Promise<void> } {
  const events: AhpEvent[] = []
  const reader = session.events()[Symbol.asyncIterator]()
  const task = (async () => {
    try {
      for (;;) {
        const next = await reader.next()
        if (next.done) return
        events.push(next.value)
      }
    } catch {
      // Tests assert source failures through turn.result(), independently of this event log.
    }
  })()
  return {
    events,
    async stop() {
      await reader.return?.()
      await task
    },
  }
}

/**
 * Open a Pi session and subscribe before the test submits input. Defaults to the 1.5.2 profile,
 * the in-memory host factory and the current working directory. Initialization or session-open
 * failures reject. Await dispose after a successful open to release the collector and client.
 * A createHost override bypasses the fake host, so only inspect host and hosts with the default factory.
 */
export async function fixture(options: Partial<PiAdapterOptions> = {}, create: Parameters<Client['sessions']['create']>[0] = { cwd: process.cwd() }): Promise<Fixture> {
  const fake = fakeFactory()
  const adapter = createPiAdapter({ version: '1.5.2', createHost: fake.factory, ...options })
  const client = await createClient({ adapter, identity: { adapterId: 'pi', runtimeConfigId: 'test' } })
  const session = await client.sessions.create(create)
  const collector = collect(session)
  return {
    client, session, events: collector.events, hosts: fake.hosts, opens: fake.opens, adapter, host: fake.hosts[0]!,
    async dispose() {
      await collector.stop()
      await client.dispose()
    },
  }
}

/** Attach an immediate rejection observer while preserving the original promise for later assertions. */
export const observe = (promise: Promise<Turn>): Promise<Turn> => { void promise.catch(() => {}); return promise }

/** Supply the current session ID and a fresh request ID. Return Session.request's result or rejection unchanged. */
export function request<M extends 'history/read' | 'compact/start' | 'session/config/set' | 'goal/set' | 'review/start'>(
  session: Session, method: M, params: Omit<AhpRequestMap[M], 'sessionId' | 'requestId'>,
): Promise<AhpResultMap[M]> {
  return session.request(method, { ...params, sessionId: session.id, requestId: randomUUID() } as AhpRequestMap[M])
}

/** Project an event log to its kinds in arrival order for lifecycle assertions. */
export const types = (events: AhpEvent[]) => events.map(event => event.type)

/** Poll at 2 ms intervals. Reject if still false past timeoutMs (default 2000) or if the predicate throws. */
export const until = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until timed out')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
