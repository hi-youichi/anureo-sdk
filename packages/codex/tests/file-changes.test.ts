import { expect, test } from 'bun:test'
import { codexFileChanges } from '../src/file-changes'
import { mapItems } from '../src/mapping'

test('native operation objects and move_path retain source and destination with raw unified offsets', () => {
  const changes = [{ path: '/project/old.ts', kind: { type: 'update', move_path: '/project/new.ts' }, diff: '@@ -56,3 +56,3 @@\n context\n-old\n+new\n end\n' }]
  expect(codexFileChanges(changes)).toEqual([{ path: '/project/new.ts', oldPath: '/project/old.ts', operation: 'rename', materials: [{ format: 'unified', patch: changes[0]!.diff }], completeness: 'complete' }])
  for (const completed of [false, true]) expect(mapItems({ id: 'change', type: 'fileChange', status: 'failed', changes }, completed)[0]).toMatchObject({ status: 'failed', kind: 'fileChange', fileChanges: codexFileChanges(changes) })
})

test('missing text has an explicit unavailable material and no fabricated source', () => {
  expect(codexFileChanges([{ path: 'empty', kind: { type: 'add' } }, { path: 'old', kind: { type: 'delete' } }])).toMatchObject([{ operation: 'add', completeness: 'partial', materials: [{ format: 'unavailable' }] }, { operation: 'delete' }])
})


test('missing native history status remains unknown while live completed envelopes prove completion', () => {
  const native = { id: 'change', type: 'fileChange', changes: [] }
  expect(mapItems(native, true, true)[0]!.status).toBeUndefined()
  expect(mapItems(native, true)[0]!.status).toBe('completed')
  expect(mapItems({ ...native, status: 'inProgress' }, true, true)[0]!.status).toBe('running')
})
