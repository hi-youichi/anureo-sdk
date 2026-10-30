import { expect, test } from 'bun:test'
import { acpFileChanges } from '../src/file-changes'
import { AcpUpdateMapper } from '../src/mapping'
import type { AhpEventPayload, SessionState } from '@anureo/protocol'

test('ACP typed content preserves empty existing and null new-file semantics', () => {
  const changes = acpFileChanges([{ type: 'diff', path: 'created', oldText: null, newText: 'a' }, { type: 'diff', path: 'existing', oldText: '', newText: 'b' }, { type: 'text', text: '@@ -1 +1 @@\n-a\n+b' }, { type: 'diff', path: 'omitted', newText: 'c' }])
  expect(changes).toMatchObject([{ operation: 'add', materials: [{ scope: 'file', oldText: null }] }, { operation: 'modify', materials: [{ oldText: '' }] }, { path: 'omitted', operation: 'add', materials: [{ oldText: null }] }])
})

test('tool updates preserve omitted source, replace explicit empty content, and emit full patch snapshots', async () => {
  const events: AhpEventPayload[] = []
  const mapper = new AcpUpdateMapper({ emit: async event => { events.push(event) } } as import('@anureo/sdk').SessionEventSink, () => 'turn', () => ({} as SessionState), () => {}, false)
  await mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', content: [{ type: 'diff', path: 'a', oldText: 'old', newText: 'new' }] })
  await mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', title: 'Changed' })
  expect(events[1]).toMatchObject({ type: 'item/delta', payload: { kind: 'patch', value: { fileChanges: [{ path: 'a' }] } } })
  await mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', content: [], status: 'completed' })
  expect(events[2]).toMatchObject({ type: 'item/completed', payload: { item: { fileChanges: [], status: 'completed' } } })
})
