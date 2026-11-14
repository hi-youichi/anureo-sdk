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
})

test('supportedModels returns the default model list', async () => {
  const query = createFakeClaudeQuery({ messages: [], canRewind: true })
  expect(await query.supportedModels()).toEqual([{ value: 'fake-model', displayName: 'Fake', description: 'Fixture' }])
})

test('supportedModels returns the configured model list', async () => {
  const configuredQuery = createFakeClaudeQuery({
    messages: [],
    models: [{ value: 'pinned', displayName: 'Pinned', description: '' }],
  })
  expect(await configuredQuery.supportedModels()).toEqual([{ value: 'pinned', displayName: 'Pinned', description: '' }])
})

test('rewind without checkpoint capability reports an explicit native denial', async () => {
  const query = createFakeClaudeQuery({ messages: [] })
  expect(await query.rewindFiles('turn')).toEqual({ canRewind: false, error: 'No checkpoint' })
  query.finish()
  const reader = query[Symbol.asyncIterator]()
  expect((await reader.next()).done).toBe(true)
})

test('initial messages are cloned and drain after idempotent close', async () => {
  const message = { type: 'system', nested: { value: 'initial' } }
  const query = createFakeClaudeQuery({ messages: [message] })
  message.nested.value = 'changed'
  query.finish()
  query.close()
  query.close()
  const reader = query[Symbol.asyncIterator]()
  expect((await reader.next()).value).toEqual({ type: 'system', nested: { value: 'initial' } })
  expect((await reader.next()).done).toBe(true)
  expect(query.calls).toEqual([{ method: 'close' }])
})

test('input callback failure stops input consumption without closing output', async () => {
  const failure = new Error('script failed')
  const query = createFakeClaudeQuery({
    messages: [],
    onInput: async (_, emit) => {
      await emit({ type: 'result' })
      throw failure
    },
  })
  try {
    await expect(query.streamInput((async function* () {
      yield { type: 'user', content: 'first' }
      yield { type: 'user', content: 'second' }
    })())).rejects.toBe(failure)
    expect(query.calls).toEqual([{ method: 'input', value: { type: 'user', content: 'first' } }])
    const reader = query[Symbol.asyncIterator]()
    try {
      expect((await reader.next()).value).toEqual({ type: 'result' })
      await expect(query.streamInput((async function* () { yield null })())).rejects.toBe(failure)
      expect((await reader.next()).value).toEqual({ type: 'result' })
    } finally {
      await reader.return?.()
    }
  } finally {
    query.close()
  }
})
