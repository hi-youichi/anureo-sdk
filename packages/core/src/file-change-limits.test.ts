import { expect, test } from 'bun:test'
import { validateDefinition, type Item, type InteractionRequested } from '@anureo/protocol'
import { SecretRedactor } from './secrets'
import { boundFileChangeItem, FILE_CHANGE_TEXT_LIMIT } from './file-change-limits'

const item = (): Extract<Item, { type: 'toolCall' }> => ({ id: 'edit', type: 'toolCall', kind: 'fileChange', title: 'secret', input: { patch: 'secret' }, output: 'secret', raw: { patch: 'secret' }, locations: [{ path: 'secret' }], fileChanges: [{ path: 'secret.ts', oldPath: 'secret.old', operation: 'modify', completeness: 'complete', materials: [{ format: 'unified', patch: '@@ -1 +1 @@\n-secret\n+secret\n' }, { format: 'text', scope: 'fragment', oldText: 'secret', newText: 'secret' }] }] })

test('new material and every snapshot/history path use marked-secret filtering', () => {
  const filter = new SecretRedactor()
  filter.rememberResponse({ kind: 'userInput', interactionId: 'request', questions: [{ id: 'key', prompt: 'Key', secret: true }] } as InteractionRequested, { kind: 'userInput', answers: { key: 'secret' } })
  expect(JSON.stringify(filter.item(item()))).not.toContain('secret')
  const delta = filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'patch', value: item() as unknown as import('@anureo/protocol').JsonValue } })
  expect(JSON.stringify(delta)).not.toContain('secret')
  expect(JSON.stringify(filter.history({ items: [{ turnId: 'turn', item: item() }], snapshotToken: 'token' }))).not.toContain('secret')
})

test('a shared UTF-8 budget includes canonical source and raw/input/output mirrors', () => {
  const source = item(); const text = '🙂'.repeat(80000)
  source.fileChanges![0]!.materials = [{ format: 'unified', patch: text }]
  source.input = { patch: text }; source.output = text; source.raw = { patch: text }
  const result = boundFileChangeItem(source)
  expect(result.type).toBe('toolCall')
  if (result.type !== 'toolCall') return
  expect(result.fileChanges![0]!.completeness).toBe('partial')
  expect(result.extensions?.['x-anureo/fileChangesTruncated']).toBe(true)
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(FILE_CHANGE_TEXT_LIMIT + 3000)
  expect(validateDefinition('Item', result)).toBe(true)
})

test('the fifty-material limit spans all files and never leaves exact stats after truncation', () => {
  const source = item()
  source.fileChanges = [0, 1].map(index => ({ path: `${index}.ts`, operation: 'modify', completeness: 'complete', stats: { added: 60, removed: 0, accuracy: 'exact' }, materials: Array.from({ length: 30 }, () => ({ format: 'text', scope: 'fragment', oldText: '', newText: 'new\n' })) }))
  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges!.flatMap(change => change.materials).filter(material => material.format !== 'unavailable')).toHaveLength(50)
  expect(result.fileChanges![1]!.stats!.accuracy).toBe('partial')
  expect(validateDefinition('Item', result)).toBe(true)
})


test('malformed Item-shaped patch snapshots fail before returning a retained event', () => {
  const filter = new SecretRedactor()
  const source = item()
  const huge = 'x'.repeat(300000)
  source.input = { patch: huge }; source.output = huge; source.raw = { patch: huge }
  const value = { ...source, fileChanges: [{ ...source.fileChanges![0], operation: 'unsupported' }] }
  let retained: unknown
  expect(() => { retained = filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'patch', value: value as unknown as import('@anureo/protocol').JsonValue } }) }).toThrow('Invalid AHP Item')
  expect(retained).toBeUndefined()
  expect(filter.event({ type: 'item/delta', payload: { itemId: 'extension', kind: 'patch', value: { custom: 'compatible JSON' } } })).toMatchObject({ payload: { value: { custom: 'compatible JSON' } } })
})

test('independently truncated replacement sides degrade to metadata-only material', () => {
  const source = item()
  source.fileChanges![0]!.materials = [{ format: 'text', scope: 'fragment', oldText: 'old\nline\n', newText: 'y'.repeat(300000) }]
  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges![0]!.materials).toEqual([{ format: 'unavailable', reason: 'tooLarge' }])
  expect(result.fileChanges![0]!.completeness).toBe('partial')
  expect(result.extensions?.['x-anureo/fileChangesTruncated']).toBe(true)
  expect(validateDefinition('Item', result)).toBe(true)
})

test('started, completed, full delta and history all apply the same source budget', () => {
  const filter = new SecretRedactor()
  const source = item()
  const huge = 'x'.repeat(300000)
  source.fileChanges![0]!.materials = [{ format: 'unified', patch: huge }]
  source.input = { patch: huge }; source.output = huge; source.raw = { patch: huge }
  const retained = [filter.event({ type: 'item/started', payload: { item: source } }), filter.event({ type: 'item/completed', payload: { item: source } }), filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'patch', value: source as unknown as import('@anureo/protocol').JsonValue } }), filter.history({ snapshotToken: 'token', items: [{ turnId: 'turn', item: source }] })]
  for (const event of retained) {
    expect(new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeLessThan(FILE_CHANGE_TEXT_LIMIT + 3000)
    expect(JSON.stringify(event)).toContain('tooLarge')
  }
})
