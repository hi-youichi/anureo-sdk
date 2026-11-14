import { expect, test } from 'bun:test'
import { parallel } from './index'

test('starts all callbacks concurrently and preserves input order', async () => {
  let finishFirst!: (value: string) => void
  let finishSecond!: (value: number) => void
  const started: string[] = []
  const result = parallel([
    () => { started.push('first'); return new Promise<string>(resolve => { finishFirst = resolve }) },
    () => { started.push('second'); return new Promise<number>(resolve => { finishSecond = resolve }) },
  ])
  expect(started).toEqual(['first', 'second'])
  finishSecond(42)
  finishFirst('done')
  expect(await result).toEqual(['done', 42])
})

test('accepts synchronous results, readonly tuples, and empty batches', async () => {
  expect(await parallel([() => 1, () => Promise.resolve('two'), () => true] as const)).toEqual([1, 'two', true])
  expect(await parallel([])).toEqual([])
})

test('synchronous failure does not prevent later callbacks from starting', async () => {
  const failure = new Error('failed')
  let started = false
  const result = parallel([
    () => { throw failure },
    () => { started = true; return 'other' },
  ])
  expect(await result).toEqual([null, 'other'])
  expect(started).toBe(true)
})

test('a failed callback becomes null and the batch still waits for its pending sibling', async () => {
  let finish!: (value: string) => void
  let completed = false
  const sibling = new Promise<string>(resolve => {
    finish = resolve
  }).then(value => {
    completed = true
    return value
  })
  const failure = new Error('failed')
  let settled = false
  const result = parallel([
    () => Promise.reject(failure),
    () => sibling,
  ]).then(values => {
    settled = true
    return values
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(completed).toBe(false)
  finish('still running')
  expect(await sibling).toBe('still running')
  expect(await result).toEqual([null, 'still running'])
  expect(completed).toBe(true)
})

test('preserves null and other falsy results', async () => {
  expect(await parallel([() => null, () => 0, () => false, () => '', () => undefined])).toEqual([null, 0, false, '', undefined])
})

test('validates every entry before starting any callbacks', async () => {
  let started = false
  // @ts-expect-error invalid JavaScript input must be rejected before any task starts
  await expect(parallel([() => { started = true }, Promise.resolve('already started')])).rejects.toBeInstanceOf(TypeError)
  expect(started).toBe(false)
  // @ts-expect-error array-like objects are not arrays
  await expect(parallel({ map: () => [] })).rejects.toBeInstanceOf(TypeError)
  // @ts-expect-error missing argument
  await expect(parallel()).rejects.toBeInstanceOf(TypeError)
})

test('snapshots the callbacks before one callback mutates the input array', async () => {
  const callbacks = [() => { callbacks[1] = () => 99; return 1 }, () => 2]
  expect(await parallel(callbacks)).toEqual([1, 2])
})

/** Compile-only assertions for positional inference and nullable failures; never invoked at runtime. */
function checkTypes() {
  const values = parallel([() => 1, async () => 'two', () => true])
  const tuple: Promise<[number | null, string | null, boolean | null]> = values
  // @ts-expect-error the first task returns a number
  const wrong: Promise<[string | null, string | null, boolean | null]> = values
  // @ts-expect-error callback failures can produce null at every position
  const missingNull: Promise<[number, string, boolean]> = values
  const empty: Promise<[]> = parallel([])
  const callbacks: ReadonlyArray<() => Promise<number>> = [async () => 1]
  const array: Promise<(number | null)[]> = parallel(callbacks)
  const readonlyTuple: Promise<[number | null, string | null]> = parallel([() => 1, async () => 'two'] as const)
  void tuple; void wrong; void missingNull; void empty; void array; void readonlyTuple
}
void checkTypes
