import { expect, test } from 'bun:test'
import { resolveDuplicateRoots } from '../src/duplicates'

test('duplicate roots preserve branches and isolate cycles, missing targets and their dependants', () => {
  const roots = resolveDuplicateRoots([
    { id: 'root', duplicateOf: null }, { id: 'branch', duplicateOf: 'root' },
    { id: 'leaf', duplicateOf: 'branch' }, { id: 'sibling', duplicateOf: 'root' },
    { id: 'cycle-a', duplicateOf: 'cycle-b' }, { id: 'cycle-b', duplicateOf: 'cycle-a' },
    { id: 'feeder', duplicateOf: 'cycle-b' }, { id: 'missing', duplicateOf: 'absent' },
    { id: 'self', duplicateOf: 'self' },
  ])
  expect([...roots.entries()]).toEqual([
    ['root', 'root'], ['branch', 'root'], ['leaf', 'root'], ['sibling', 'root'],
    ['cycle-a', null], ['cycle-b', null], ['feeder', null], ['missing', null], ['self', null],
  ])
  expect(() => resolveDuplicateRoots([{ id: 'same', duplicateOf: null }, { id: 'same', duplicateOf: null }])).toThrow('Duplicate finding IDs')
})

test('long reverse-ordered chains resolve iteratively to one root', () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `f${i}`, duplicateOf: i ? `f${i - 1}` : null })).reverse()
  const roots = resolveDuplicateRoots(nodes)
  expect(roots.size).toBe(nodes.length)
  expect(new Set(roots.values())).toEqual(new Set(['f0']))
})
