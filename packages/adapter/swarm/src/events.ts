import { randomUUID } from 'node:crypto'
import type { AhpEvent, AgentMessageItem } from '@anureo/protocol'
import type { SessionEventSink } from '@anureo/sdk'

/** Re-publish assistant messages with swarm identities. The outer turn owns its terminal event. */
export function relayMessages(sink: SessionEventSink, turnId: string) {
  const ids = new Map<string, string>()
  const scope = { turnId }
  return async (event: AhpEvent) => {
    if (event.type === 'item/started' || event.type === 'item/completed') {
      const source = event.payload.item
      if (source.type !== 'agentMessage') return
      const id = ids.get(source.id) ?? randomUUID()
      ids.set(source.id, id)
      const item: AgentMessageItem = { id, type: 'agentMessage', text: source.text, phase: source.phase }
      await sink.emit({ type: event.type, payload: { item } }, scope)
    } else if (event.type === 'item/delta') {
      const { itemId, kind, text } = event.payload
      const id = ids.get(itemId)
      if (id && kind === 'text') {
        await sink.emit({ type: 'item/delta', payload: { itemId: id, kind, text } }, scope)
      }
    }
  }
}
