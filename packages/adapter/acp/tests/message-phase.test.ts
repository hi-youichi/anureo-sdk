import { expect, test } from 'bun:test'
import type { AhpEventPayload, SessionState } from '@anureo/protocol'
import type { SessionEventSink } from '@anureo/sdk'
import { AcpUpdateMapper } from '../src/mapping'

function createMapper() {
  const events: AhpEventPayload[] = []
  const sink = { emit: async (event: AhpEventPayload) => { events.push(event) } } as SessionEventSink
  const mapper = new AcpUpdateMapper(sink, () => 'turn', () => ({} as SessionState), () => {}, false)
  const say = (messageId: string, text: string) => mapper.update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
  const phases = () => Object.fromEntries(events.flatMap((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage'
    ? [[event.payload.item.id.replace('agent_message_chunk:', ''), event.payload.item.phase]]
    : []))
  return { events, mapper, say, phases }
}

test('agent text is commentary while streaming and only the last message becomes final at turn end', async () => {
  const { events, mapper, say, phases } = createMapper()
  await say('a', 'Let me look at the repo.')
  await mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'read', kind: 'read', title: 'Read' })
  await say('b', 'Now running the tests.')
  await mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'test', kind: 'execute', title: 'Test' })
  await say('c', 'All tests pass.')

  const started = events.flatMap((event) => event.type === 'item/started' && event.payload.item.type === 'agentMessage' ? [event.payload.item.phase] : [])
  expect(started).toEqual(['commentary', 'commentary', 'commentary'])
  expect(events.some((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage')).toBe(false)

  await mapper.complete()
  expect(phases()).toEqual({ a: 'commentary', b: 'commentary', c: 'final' })
})

test('a trailing empty agent message does not take the final phase from the real answer', async () => {
  const { mapper, say, phases } = createMapper()
  await say('answer', 'Done.')
  await say('empty', '  ')
  await mapper.complete()
  expect(phases()).toEqual({ answer: 'final', empty: 'commentary' })
})

test('a single agent message is the final answer', async () => {
  const { mapper, say, phases } = createMapper()
  await say('only', 'Hello')
  await mapper.complete()
  expect(phases()).toEqual({ only: 'final' })
})

test('a turn without agent text publishes no final message', async () => {
  const { events, mapper } = createMapper()
  await mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'execute', title: 'Run' })
  await mapper.complete()
  expect(events.some((event) => event.type === 'item/completed' && event.payload.item.type === 'agentMessage')).toBe(false)
})
