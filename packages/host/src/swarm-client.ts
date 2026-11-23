import { createClient, HarnessSdkError, sdkError, type Client, type HarnessAdapter, type Session, type SessionEventSink } from '@anureo/sdk'
import { createSwarmAdapter, type SwarmModelCatalog, type SwarmWorkflowOptions } from '@anureo/adapter-swarm'
import { attachInteractionCapture, clientInteractionCapture, type InteractionCapture } from './interaction-capture'

/** A Host session owns the composed client and every isolated backend client. */
export async function createOwnedSwarmClient(backend: Client, modelCatalog?: SwarmModelCatalog, workflows?: SwarmWorkflowOptions, createBackend?: () => Client | Promise<Client>): Promise<Client> {
  let swarm: HarnessAdapter | undefined
  let closing: Promise<void> | undefined
  let sink: SessionEventSink | undefined
  let activeTurnId: string | undefined
  const capture = clientInteractionCapture(backend)
  const owned = new Set<Client>([backend])
  let mainAllocated = false
  const routes = new Map<string, { capture: InteractionCapture; nativeId: string }>()
  const routedCapture: InteractionCapture = {
    requests: { get: id => {
      const route = routes.get(id), request = route?.capture.requests.get(route.nativeId)
      return request ? { ...request, interactionId: id } : undefined
    } },
    pending: {
      get: id => { const route = routes.get(id); return route?.capture.pending.get(route.nativeId) },
      delete: id => { const route = routes.get(id); return route?.capture.pending.delete(route.nativeId) ?? false },
    },
  }
  const observation = new AbortController()
  const observers = new Set<Promise<void>>()
  const observe = (session: Session, owner: Client) => {
    const memberCapture = clientInteractionCapture(owner)
    if (!memberCapture) return session
    const events = session.events({ signal: observation.signal })
    const forwarded = new Set<string>()
    const reading = (async () => {
      for await (const event of events) {
        if (!sink) continue
        if (event.type === 'interaction/requested' && activeTurnId) {
          forwarded.add(event.payload.interactionId)
          const interactionId = JSON.stringify([session.id, event.payload.interactionId])
          routes.set(interactionId, { capture: memberCapture, nativeId: event.payload.interactionId })
          // Interaction payloads refer to the outer turn; the capture retains native/private data.
          await sink.emit({ type: event.type, payload: { ...event.payload, interactionId, turnId: activeTurnId, itemId: undefined } }, { turnId: activeTurnId })
        } else if (event.type === 'interaction/resolved' && forwarded.delete(event.payload.interactionId)) {
          const interactionId = JSON.stringify([session.id, event.payload.interactionId])
          await sink.emit({ type: event.type, payload: { ...event.payload, interactionId } }, { turnId: activeTurnId })
          routes.delete(interactionId)
        }
      }
    })().catch(cause => {
      if (sdkError(cause).code === 'OBSERVATION_CLOSED') return
      // Failure may dispose the adapter, which drains this reader; never await that cycle here.
      if (!closing && !observation.signal.aborted) void sink?.fail(cause).catch(() => {})
    }).finally(async () => {
      for (const id of forwarded) routes.delete(JSON.stringify([session.id, id]))
      if (owner !== backend) {
        try { await owner.dispose(); owned.delete(owner) }
        catch (cause) { if (!closing) void sink?.fail(cause).catch(() => {}) }
      }
    })
    observers.add(reading)
    void reading.finally(() => observers.delete(reading)).catch(() => {})
    return session
  }
  // Observe public session streams while leaving SDK execution and interaction settlement intact.
  const sessions: Client['sessions'] = { ...backend.sessions, create: async (...args) => {
    // Native interaction IDs are unique only within one adapter/client instance.
    const owner = !capture || !mainAllocated ? backend : await createBackend!()
    mainAllocated = true
    if (closing) { await owner.dispose(); throw new HarnessSdkError('SESSION_CLOSED') }
    owned.add(owner)
    try { return observe(await owner.sessions.create(...args), owner) }
    catch (cause) {
      if (owner !== backend) {
        try { await owner.dispose(); owned.delete(owner) }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'Swarm member initialization failed') }
      }
      throw cause
    }
  } }
  const borrowed = new Proxy(backend, { get: (target, key, receiver) => key === 'sessions' ? sessions : Reflect.get(target, key, receiver) })
  const dispose = () => closing ??= (async () => {
    const errors: unknown[] = []
    try { await swarm?.dispose() } catch (cause) { errors.push(cause) }
    for (const owner of owned) try { await owner.dispose() } catch (cause) { errors.push(cause) }
    observation.abort()
    await Promise.allSettled(observers)
    if (errors.length) throw new AggregateError(errors, 'Swarm client cleanup failed')
  })()
  try {
    if (capture && !createBackend) throw new Error('Captured Swarm sessions require an isolated backend factory')
    swarm = createSwarmAdapter({ backend: borrowed, modelCatalog, workflows })
    const client = await createClient({
      adapter: { ...swarm, dispose, openSession: async (params, target) => {
        sink = target
        const emit: SessionEventSink['emit'] = async (event, scope) => {
          if (event.type === 'turn/started') activeTurnId = event.payload.turnId
          await target.emit(event, scope)
          if (event.type === 'turn/completed') activeTurnId = undefined
        }
        const routed = new Proxy(target, { get: (original, key) => {
          if (key === 'emit') return emit
          const value = Reflect.get(original, key, original)
          return typeof value === 'function' ? value.bind(original) : value
        } })
        return swarm!.openSession(params, routed)
      } },
      // The Host keeps the selected runtime identity; executionMode records composition.
      identity: backend.identity,
    })
    return capture ? await attachInteractionCapture(client, routedCapture) : client
  } catch (cause) {
    try { await dispose() } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Swarm initialization failed') }
    throw cause
  }
}
