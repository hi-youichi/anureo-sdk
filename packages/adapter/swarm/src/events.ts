import { randomUUID } from 'node:crypto'
import type { AhpEvent, AgentMessageItem, Item } from '@anureo/protocol'
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

/** Nest a member's public items under its assignment, isolating backend-local identities. */
export function relayMemberItems(sink: SessionEventSink, turnId: string, taskId: string, beeId: string) {
  const ids = new Map<string, string>()
  const open = new Map<string, Item>()
  const scope = { turnId }
  const idFor = (source: string) => {
    const id = ids.get(source) ?? randomUUID()
    ids.set(source, id)
    return id
  }
  const mapItem = (source: Item): Item => ({
    ...source,
    id: idFor(source.id),
    parentItemId: source.parentItemId ? idFor(source.parentItemId) : taskId,
    ...(source.type === 'subagent' ? { subagentId: `${beeId}:${source.subagentId}` } : {}),
  })
  return {
    async accept(event: AhpEvent) {
      if (event.type === 'item/started' || event.type === 'item/completed') {
        const item = mapItem(event.payload.item)
        await sink.emit({ type: event.type, payload: { item } }, scope)
        if (event.type === 'item/started') open.set(item.id, item)
        else open.delete(item.id)
      } else if (event.type === 'item/delta') {
        const id = ids.get(event.payload.itemId)
        if (!id) return
        const payload = { ...event.payload, itemId: id }
        if (payload.kind === 'patch' && payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value) && 'type' in payload.value) {
          const item = mapItem(payload.value as unknown as Item)
          payload.value = item as unknown as typeof payload.value
          open.set(id, item)
        } else {
          const item = open.get(id)
          const text = payload.text
          if (item && text !== undefined) {
            if (item.type === 'agentMessage' && payload.kind === 'text') item.text += text
            if (item.type === 'reasoning' && payload.kind === 'reasoningSummary') item.summary = (item.summary ?? '') + text
            if (item.type === 'toolCall' && payload.kind === 'output') item.output = (typeof item.output === 'string' ? item.output : '') + text
          }
        }
        await sink.emit({ type: 'item/delta', payload }, scope)
      }
    },
    async finish(status: 'completed' | 'failed' | 'interrupted') {
      // Finish descendants before their parents, including streams left open on cancellation.
      const pending = [...open.values()]
      const depth = (item: Item) => {
        let count = 0
        const seen = new Set<string>([item.id])
        let parent = item.parentItemId
        while (parent && open.has(parent) && !seen.has(parent)) { seen.add(parent); count++; parent = open.get(parent)?.parentItemId }
        return count
      }
      pending.sort((a, b) => depth(b) - depth(a))
      for (const item of pending) {
        const completed: Item = item.type === 'subagent' ? { ...item, status, state: status } : { ...item, status }
        await sink.emit({ type: 'item/completed', payload: { item: completed } }, scope)
      }
      open.clear()
    },
  }
}
