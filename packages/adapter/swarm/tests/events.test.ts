import { expect, test } from 'bun:test'
import type { AhpEvent, AhpEventPayload, Item } from '@anureo/protocol'
import type { EventScope, SessionEventSink } from '@anureo/sdk'
import { relayMemberItems } from '../src/events'

const event = (payload: AhpEventPayload): AhpEvent => ({ sessionId: 'native', streamId: 'native', seq: 1, timestamp: '2026-11-17T00:00:00Z', turnId: 'native-turn', ...payload }) as AhpEvent
function capture() {
  const events: { event: AhpEventPayload; scope?: EventScope }[] = []
  const sink = { async emit(event: AhpEventPayload, scope?: EventScope) { events.push(structuredClone({ event, scope })) } } as SessionEventSink
  return { events, sink }
}

test('member relay maps all item identities, nested parents, patches and output deltas', async () => {
  const { events, sink } = capture()
  const relay = relayMemberItems(sink, 'outer-turn', 'task', 'bee')
  const tool: Item = { id: 'tool', type: 'toolCall', kind: 'command', title: 'Inspect', status: 'running' }
  const message: Item = { id: 'message', parentItemId: 'tool', type: 'agentMessage', phase: 'final', text: '' }
  await relay.accept(event({ type: 'turn/started', payload: { turnId: 'native-turn' } }))
  await relay.accept(event({ type: 'item/started', payload: { item: tool } }))
  await relay.accept(event({ type: 'item/delta', payload: { itemId: tool.id, kind: 'output', text: 'Output' } }))
  await relay.accept(event({ type: 'item/started', payload: { item: message } }))
  await relay.accept(event({ type: 'item/delta', payload: { itemId: message.id, kind: 'text', text: 'Evidence' } }))
  await relay.accept(event({ type: 'item/delta', payload: { itemId: tool.id, kind: 'patch', value: { ...tool, output: 'Patched' } } }))
  await relay.finish('interrupted')
  expect(events.every(entry => entry.scope?.turnId === 'outer-turn')).toBe(true)
  const snapshots = events.flatMap(entry => entry.event.type === 'item/started' || entry.event.type === 'item/completed' ? [entry.event.payload.item] : [])
  const [mappedTool, mappedMessage, completedMessage, completedTool] = snapshots
  expect(mappedTool.id).not.toBe('tool')
  expect(mappedTool.parentItemId).toBe('task')
  expect(mappedMessage.parentItemId).toBe(mappedTool.id)
  expect(completedMessage).toMatchObject({ id: mappedMessage.id, status: 'interrupted', text: 'Evidence' })
  expect(completedTool).toMatchObject({ id: mappedTool.id, status: 'interrupted', output: 'Patched' })
  const patch = events.find(entry => entry.event.type === 'item/delta' && entry.event.payload.kind === 'patch')!.event
  if (patch.type === 'item/delta') expect(patch.payload.value).toMatchObject({ id: mappedTool.id, parentItemId: 'task' })
  const count = events.length
  await relay.finish('interrupted')
  expect(events).toHaveLength(count)
})

test('parallel members isolate reused native IDs and retain nested agent identity and native references', async () => {
  const { events, sink } = capture()
  const source: Item = { id: 'reused', type: 'subagent', subagentId: 'native-child', state: 'running', nativeRef: { provider: 'test', value: 'real-session' } }
  for (const [task, bee] of [['task-a', 'bee-a'], ['task-b', 'bee-b']]) {
    const relay = relayMemberItems(sink, 'outer-turn', task, bee)
    await relay.accept(event({ type: 'item/started', payload: { item: source } }))
    await relay.accept(event({ type: 'item/completed', payload: { item: { ...source, state: 'completed' } } }))
    await relay.finish('completed')
  }
  const items = events.flatMap(entry => entry.event.type === 'item/started' ? [entry.event.payload.item] : [])
  expect(items[0].id).not.toBe(items[1].id)
  expect(items[0]).toMatchObject({ parentItemId: 'task-a', subagentId: 'bee-a:native-child', nativeRef: source.nativeRef })
  expect(items[1]).toMatchObject({ parentItemId: 'task-b', subagentId: 'bee-b:native-child' })
  expect(events).toHaveLength(4)
})
