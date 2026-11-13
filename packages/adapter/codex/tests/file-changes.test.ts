/** Guards file-change provenance and history compatibility; filesystem reads and patch application belong outside these tests. */
import { expect, test } from 'bun:test'
import { codexFileChanges } from '../src/file-changes'
import { mapItems } from '../src/mapping'

/** Native offsets and source/destination spelling must survive projection even when the enclosing tool fails. */
test('native operation objects and move_path retain source and destination with raw unified offsets', () => {
  const changes = [{
    path: '/project/old.ts',
    kind: {
      type: 'update',
      move_path: '/project/new.ts'
    },
    diff: '@@ -56,3 +56,3 @@\n context\n-old\n+new\n end\n'
  }]
  expect(codexFileChanges(changes)).toEqual([{
    path: '/project/new.ts',
    oldPath: '/project/old.ts',
    operation: 'rename',
    materials: [{
      format: 'unified',
      patch: changes[0]!.diff
    }],
    completeness: 'complete'
  }])
  for (const completed of [false, true]) expect(mapItems({ id: 'change', type: 'fileChange', status: 'failed', changes }, completed)[0]).toMatchObject({ status: 'failed', kind: 'fileChange', fileChanges: codexFileChanges(changes) })
})

/** Missing native material must stay distinguishable from a supplied empty patch without inspecting workspace files. */
test('missing text has an explicit unavailable material and no fabricated source', () => {
  expect(codexFileChanges([{ path: 'empty', kind: { type: 'add' } }, { path: 'old', kind: { type: 'delete' } }])).toMatchObject([{ operation: 'add', completeness: 'partial', materials: [{ format: 'unavailable' }] }, { operation: 'delete' }])
})
/** A completed history envelope cannot prove an item's status when the native snapshot omits that field. */
test('missing native history status remains unknown while live completed envelopes prove completion', () => {
  const native = { id: 'change', type: 'fileChange', changes: [] }
  const completed = true
  const fromHistory = true
  expect(mapItems(native, completed, fromHistory)[0]!.status).toBeUndefined()
  expect(mapItems(native, completed)[0]!.status).toBe('completed')
  expect(mapItems({ ...native, status: 'inProgress' }, completed, fromHistory)[0]!.status).toBe('running')
})

/** Unknown operations, malformed entries and empty fields must not lead the mapper to invent source material or normalize paths. */
test('file changes retain empty patches, unknown operations and native destination spelling', () => {
  expect(codexFileChanges(null)).toEqual([])
  const changes = [
    null, { path: 1 },
    { path: 'empty', kind: 'update', diff: '' },
    { path: 'source', kind: { type: 'future', move_path: 'destination' }, diff: 1 },
    { path: 'unknown', kind: 'future' },
    { path: 'source', kind: { type: 'add', move_path: '' } },
  ]
  expect(codexFileChanges(changes)).toEqual([
    { path: 'empty', operation: 'modify', materials: [{ format: 'unified', patch: '' }], completeness: 'complete' },
    { path: 'destination', oldPath: 'source', operation: 'rename', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' },
    { path: 'unknown', operation: 'unknown', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' },
    { path: '', operation: 'add', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' },
  ])
  expect(mapItems({ id: 'f', type: 'fileChange', changes }, true)[0]).toMatchObject({
    locations: [{ path: 'empty' }, { path: 'source' }, { path: 'unknown' }, { path: 'source' }],
  })
})
