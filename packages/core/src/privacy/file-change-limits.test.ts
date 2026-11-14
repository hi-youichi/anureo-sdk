// Checks privacy projection and shared file-change retention contracts.
import { expect, test } from 'bun:test'
import { validateDefinition, type Item, type InteractionRequested, type JsonSchema, type JsonValue } from '@anureo/protocol'
import { SecretRedactor } from './secrets'
import { boundFileChangeItem, FILE_CHANGE_TEXT_LIMIT } from './file-change-limits'

/** Privacy and retention tests call this for independent mutable fixtures with canonical material and mirrors; no files are read or modified. */
const makeFileChangeItem = (): Extract<Item, { type: 'toolCall' }> => ({
  id: 'edit',
  type: 'toolCall',
  kind: 'fileChange',
  title: 'secret',
  input: { patch: 'secret' },
  output: 'secret',
  raw: { patch: 'secret' },
  locations: [{ path: 'secret' }],
  fileChanges: [{
    path: 'secret.ts',
    oldPath: 'secret.old',
    operation: 'modify',
    completeness: 'complete',
    materials: [{
      format: 'unified',
      patch: '@@ -1 +1 @@\n-secret\n+secret\n',
    }, {
      format: 'text',
      scope: 'fragment',
      oldText: 'secret',
      newText: 'secret',
    }],
  }],
})

/** Exercise item, patch and history entry points after explicit registration; every returned observation must hide the marked value. */
test('new material and every snapshot/history path use marked-secret filtering', () => {
  const filter = new SecretRedactor()
  filter.rememberResponse({ kind: 'userInput', interactionId: 'request', questions: [{ id: 'key', prompt: 'Key', secret: true }] } as InteractionRequested, { kind: 'userInput', answers: { key: 'secret' } })
  expect(JSON.stringify(filter.item(makeFileChangeItem()))).not.toContain('secret')
  const delta = filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'patch', value: makeFileChangeItem() as unknown as JsonValue } })
  expect(JSON.stringify(delta)).not.toContain('secret')
  expect(JSON.stringify(filter.history({ items: [{ turnId: 'turn', item: makeFileChangeItem() }], snapshotToken: 'token' }))).not.toContain('secret')
})

/** Oversized multibyte text must stay within one item budget and expose partial metadata without invalidating the protocol item. */
test('a shared UTF-8 budget includes canonical source and raw/input/output mirrors', () => {
  const source = makeFileChangeItem(); const text = '🙂'.repeat(80000)
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

/** Exhaust material capacity across files, checking retained count and the later file's downgraded stat accuracy. */
test('the fifty-material limit spans all files and never leaves exact stats after truncation', () => {
  const source = makeFileChangeItem()
  source.fileChanges = [0, 1].map(index => ({ path: `${index}.ts`, operation: 'modify', completeness: 'complete', stats: { added: 60, removed: 0, accuracy: 'exact' }, materials: Array.from({ length: 30 }, () => ({ format: 'text', scope: 'fragment', oldText: '', newText: 'new\n' })) }))
  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges!.flatMap(change => change.materials).filter(material => material.format !== 'unavailable')).toHaveLength(50)
  expect(result.fileChanges![1]!.stats!.accuracy).toBe('partial')
  expect(validateDefinition('Item', result)).toBe(true)
})


/** A malformed snapshot must throw before returning a bounded event; arbitrary extension JSON must still project successfully. */
test('malformed Item-shaped patch snapshots fail before returning a retained event', () => {
  const filter = new SecretRedactor()
  const source = makeFileChangeItem()
  const huge = 'x'.repeat(300000)
  source.input = { patch: huge }; source.output = huge; source.raw = { patch: huge }
  const value = { ...source, fileChanges: [{ ...source.fileChanges![0], operation: 'unsupported' }] }
  let retained: unknown
  expect(() => { retained = filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'patch', value: value as unknown as JsonValue } }) }).toThrow('Invalid AHP Item')
  expect(retained).toBeUndefined()
  expect(filter.event({ type: 'item/delta', payload: { itemId: 'extension', kind: 'patch', value: { custom: 'compatible JSON' } } })).toMatchObject({ payload: { value: { custom: 'compatible JSON' } } })
})

/** Truncating either replacement side must make the whole replacement unavailable and the containing change partial. */
test('independently truncated replacement sides degrade to metadata-only material', () => {
  const source = makeFileChangeItem()
  source.fileChanges![0]!.materials = [{ format: 'text', scope: 'fragment', oldText: 'old\nline\n', newText: 'y'.repeat(300000) }]
  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges![0]!.materials).toEqual([{ format: 'unavailable', reason: 'tooLarge' }])
  expect(result.fileChanges![0]!.completeness).toBe('partial')
  expect(result.extensions?.['x-anureo/fileChangesTruncated']).toBe(true)
  expect(validateDefinition('Item', result)).toBe(true)
})

/** Compare all snapshot paths so one cannot retain oversized material that another path would discard. */
test('started, completed, full delta and history all apply the same source budget', () => {
  const filter = new SecretRedactor()
  const source = makeFileChangeItem()
  const huge = 'x'.repeat(300000)
  source.fileChanges![0]!.materials = [{ format: 'unified', patch: huge }]
  source.input = { patch: huge }; source.output = huge; source.raw = { patch: huge }
  const retained = [
    {
      name: 'started',
      value: filter.event({ type: 'item/started', payload: { item: source } }),
    },
    {
      name: 'completed',
      value: filter.event({ type: 'item/completed', payload: { item: source } }),
    },
    {
      name: 'full delta',
      value: filter.event({
        type: 'item/delta',
        payload: { itemId: 'edit', kind: 'patch', value: source as unknown as JsonValue },
      }),
    },
    {
      name: 'history',
      value: filter.history({ snapshotToken: 'token', items: [{ turnId: 'turn', item: source }] }),
    },
  ]
  for (const { name, value } of retained) {
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength, name).toBeLessThan(FILE_CHANGE_TEXT_LIMIT + 3000)
    expect(JSON.stringify(value), name).toContain('tooLarge')
  }
})

/** Verify local-reference cycles stop and siblings still register in host-hook order across object, array and composed rules. */
test('schema registration preserves reference, property, additional and composition order', () => {
  const remembered: string[] = []
  const filter = new SecretRedactor(value => remembered.push(value))
  const schema: JsonSchema = {
    $defs: {
      marked: { $ref: '#/$defs/marked', properties: { ref: { writeOnly: true } } },
    },
    $ref: '#/$defs/marked',
    properties: {
      ref: {},
      known: { secret: true },
      ignored: false,
      list: { items: { writeOnly: true } },
      composed: {},
      last: {},
    },
    additionalProperties: { secret: true },
    allOf: [{ properties: { composed: { secret: true } } }],
    anyOf: [{ properties: { known: { writeOnly: true } } }],
    oneOf: [{ properties: { last: { secret: true } } }],
  }
  filter.rememberResponse({ kind: 'elicitation', interactionId: 'schema', mode: 'form', schema }, {
    kind: 'elicitation', action: 'accept',
    content: { ref: 'reference', known: 'declared', ignored: 'public', list: ['array'], extra: 'additional', composed: 'composition', last: 'last' },
  })
  expect(remembered).toEqual(['reference', 'declared', 'array', 'additional', 'composition', 'last'])
  expect(filter.text(remembered.join(' '))).toBe(Array(6).fill('[redacted]').join(' '))
  expect(filter.text('public')).toBe('public')
})

/** A failing synchronous metadata hook must leave earlier registrations effective and allow the failed value to be retried. */
test('metadata hook failure preserves earlier registrations without accepting the failed value', () => {
  const failure = new Error('metadata unavailable')
  let fail = true
  const remembered: string[] = []
  // Fail the second registration once to exercise retry semantics.
  const filter = new SecretRedactor(value => {
    remembered.push(value)
    if (fail && value === 'second') throw failure
  })
  const request: InteractionRequested = {
    kind: 'userInput', interactionId: 'registration',
    questions: [{ id: 'one', prompt: 'One', secret: true }, { id: 'two', prompt: 'Two', secret: true }],
  }
  const response = { kind: 'userInput' as const, answers: { one: 'first', two: 'second' } }
  expect(() => filter.rememberResponse(request, response)).toThrow(failure)
  expect(filter.text('first second')).toBe('[redacted] second')
  fail = false
  filter.rememberResponse(request, response)
  expect(remembered).toEqual(['first', 'second', 'second'])
  expect(filter.text('first second')).toBe('[redacted] [redacted]')
})

/** Interleaved turns sharing an item ID must buffer separately; completion discards only its own prefix and keeps identities intact. */
test('stream prefixes are isolated by turn and cleared by authoritative completion', () => {
  const filter = new SecretRedactor()
  filter.rememberResponse({ kind: 'userInput', interactionId: 'secret', questions: [{ id: 'key', prompt: 'Key', secret: true }] }, { kind: 'userInput', answers: { key: 'secret' } })
  const delta = { type: 'item/delta' as const, payload: { itemId: 'same', kind: 'text' as const, text: 'sec' } }
  expect(filter.event(delta, 'one')).toEqual({ ...delta, payload: { ...delta.payload, text: '' } })
  expect(filter.event({ ...delta, payload: { ...delta.payload, text: 'ret' } }, 'two')).toMatchObject({ payload: { text: 'ret' } })
  expect(filter.event({ ...delta, payload: { ...delta.payload, text: 'ret' } }, 'one')).toMatchObject({ payload: { text: '[redacted]' } })
  filter.event(delta, 'one')
  filter.event(delta, 'two')
  expect(filter.event({ type: 'item/completed', payload: { item: { id: 'same', type: 'agentMessage', text: 'secret' } } }, 'one')).toMatchObject({ payload: { item: { id: 'same', text: '[redacted]' } } })
  expect(filter.event({ ...delta, payload: { ...delta.payload, text: 'ret' } }, 'one')).toMatchObject({ payload: { text: 'ret' } })
  expect(filter.event({ ...delta, payload: { ...delta.payload, text: 'ret' } }, 'two')).toMatchObject({ payload: { text: '[redacted]' } })
})

/** Force a UTF-8 character across the cap after a complete line; only that line may survive and mirrors share the remainder. */
test('UTF-8 truncation retains complete lines and reserves canonical bytes before mirrors', () => {
  const source = makeFileChangeItem()
  const retained = `${'a'.repeat(FILE_CHANGE_TEXT_LIMIT - 4)}\n`
  source.fileChanges![0]!.materials = [{ format: 'unified', patch: `${retained}🙂\n` }]
  source.input = 'é\n'
  source.output = 'later\n'
  source.raw = 'raw\n'
  source.extensions = { mirror: 'extension\n' }
  const original = structuredClone(source)
  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges![0]!.materials).toEqual([{ format: 'unified', patch: retained }])
  expect(result.fileChanges![0]!.completeness).toBe('partial')
  expect(result.input).toBe('é\n')
  expect(result.output).toBe('')
  expect(result.raw).toBe('')
  expect(result.extensions).toEqual({ mirror: '', 'x-anureo/fileChangesTruncated': true })
  expect(source).toEqual(original)
  expect(validateDefinition('Item', result)).toBe(true)
})

/** A rejected patch must preserve the earlier text-buffer update so extraction cannot silently change failure ordering. */
test('delta text updates its prefix before an Item-shaped patch fails validation', () => {
  const filter = new SecretRedactor()
  filter.rememberResponse({ kind: 'userInput', interactionId: 'secret', questions: [{ id: 'key', prompt: 'Key', secret: true }] }, { kind: 'userInput', answers: { key: 'secret' } })
  expect(() => filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'patch', text: 'sec', value: { type: 'toolCall' } } }, 'turn')).toThrow('Invalid AHP Item')
  expect(filter.event({ type: 'item/delta', payload: { itemId: 'edit', kind: 'text', text: 'ret' } }, 'turn')).toMatchObject({ payload: { text: '[redacted]' } })
})

/** Complete matches take priority over longer pending candidates, while complete scans never retain an unmatched prefix. */
test('overlapping secrets prefer the longest complete match without waiting for a longer candidate', () => {
  const filter = new SecretRedactor()
  filter.rememberResponse({ kind: 'elicitation', interactionId: 'secret', mode: 'form', schema: { secret: true } }, { kind: 'elicitation', action: 'accept', content: { short: 'sec', long: 'secret' } })
  expect(filter.text('secret sec se')).toBe('[redacted] [redacted] se')
  expect(filter.delta('stream', 'se')).toBe('')
  expect(filter.delta('stream', 'c')).toBe('[redacted]')
  expect(filter.delta('stream', 'ret')).toBe('ret')
})

/** Capacity failures must precede the host hook, retain earlier registrations and still permit duplicate values at capacity. */
test('scalar registration enforces distinct-value and UTF-8 limits before persistence', () => {
  const request: InteractionRequested = { kind: 'elicitation', interactionId: 'secret', mode: 'form', schema: { secret: true } }
  const remembered: string[] = []
  const filter = new SecretRedactor(value => remembered.push(value))
  const values = Array.from({ length: 129 }, (_, index) => `value-${index};`)
  expect(() => filter.rememberResponse(request, { kind: 'elicitation', action: 'accept', content: { values } })).toThrow('Marked secret limit exceeded')
  expect(remembered).toEqual(values.slice(0, 128))
  filter.rememberResponse(request, { kind: 'elicitation', action: 'accept', content: { duplicate: values[0]! } })
  expect(remembered).toHaveLength(128)
  expect(filter.text(values[128]!)).toBe(values[128]!)
  expect(filter.text(values[0]!)).toBe('[redacted]')

  const byteValues: string[] = []
  const byteFilter = new SecretRedactor(value => byteValues.push(value))
  const atLimit = '🙂'.repeat(16 * 1024)
  byteFilter.rememberResponse(request, { kind: 'elicitation', action: 'accept', content: { atLimit } })
  expect(() => byteFilter.rememberResponse(request, { kind: 'elicitation', action: 'accept', content: { overflow: 'x' } })).toThrow('Marked secret limit exceeded')
  expect(byteValues).toEqual([atLimit])
  expect(byteFilter.text(atLimit)).toBe('[redacted]')
  expect(byteFilter.text('x')).toBe('x')
})

/** Discarding an incomplete replacement must not refund bytes already consumed by either side. */
test('unavailable replacement material keeps its reserved bytes ahead of later mirrors', () => {
  const source = makeFileChangeItem()
  const oldText = `${'a'.repeat(FILE_CHANGE_TEXT_LIMIT - 8)}\n`
  source.fileChanges![0]!.materials = [{ format: 'text', scope: 'fragment', oldText, newText: 'bb\nmore\n' }]
  source.input = 'é\n'
  source.output = 'x\n'
  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges![0]!.materials).toEqual([{ format: 'unavailable', reason: 'tooLarge' }])
  expect(result.input).toBe('é\n')
  expect(result.output).toBe('')
  expect(result.extensions?.['x-anureo/fileChangesTruncated']).toBe(true)
  expect(validateDefinition('Item', result)).toBe(true)
})

test('mirror overflow marks the item while canonical changes keep their completeness and stats', () => {
  const source = makeFileChangeItem()
  const change = source.fileChanges![0]!
  change.stats = { added: 1, removed: 1, accuracy: 'exact' }
  source.extensions = { mirror: 'x'.repeat(FILE_CHANGE_TEXT_LIMIT) }

  const result = boundFileChangeItem(source)
  if (result.type !== 'toolCall') throw Error('unexpected item')
  expect(result.fileChanges).toEqual(source.fileChanges)
  expect(result.extensions).toEqual({ mirror: '', 'x-anureo/fileChangesTruncated': true })
  expect(validateDefinition('Item', result)).toBe(true)
})
