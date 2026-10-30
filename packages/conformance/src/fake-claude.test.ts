import { expect, test } from 'bun:test'
import { createFakeClaudeQuery } from './fake-claude'

test('scripted query records every control surface without touching the event queue', async () => {
  const query = createFakeClaudeQuery({ messages: [], canRewind: true })
  await query.setModel('sonnet')
  await query.setModel()
  await query.setPermissionMode('plan')
  await query.setMaxThinkingTokens(null)
  await query.interrupt()
  expect(await query.rewindFiles('native-turn')).toEqual({ canRewind: true })
  expect(query.calls).toEqual([
    { method: 'setModel', value: 'sonnet' },
    { method: 'setModel' },
    { method: 'setPermissionMode', value: 'plan' },
    { method: 'setMaxThinkingTokens', value: null },
    { method: 'interrupt' },
    { method: 'rewindFiles', value: 'native-turn' },
  ])
  expect(await query.supportedModels()).toEqual([{ value: 'fake-model', displayName: 'Fake', description: 'Fixture' }])
  expect(await createFakeClaudeQuery({ messages: [], models: [{ value: 'pinned', displayName: 'Pinned', description: '' }] }).supportedModels()).toEqual([{ value: 'pinned', displayName: 'Pinned', description: '' }])
})

test('rewind without checkpoint capability reports an explicit native denial', async () => {
  const query = createFakeClaudeQuery({ messages: [] })
  expect(await query.rewindFiles('turn')).toEqual({ canRewind: false, error: 'No checkpoint' })
  query.finish()
  const reader = query[Symbol.asyncIterator]()
  expect((await reader.next()).done).toBe(true)
})
