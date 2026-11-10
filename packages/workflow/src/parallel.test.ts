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
  await expect(result).rejects.toBe(failure)
  expect(started).toBe(true)
})

test('a rejected batch does not cancel its pending sibling', async () => {
  let finish!: (value: string) => void
  let completed = false
  const sibling = new Promise<string>(resolve => { finish = resolve }).then(value => { completed = true; return value })
  const failure = new Error('failed')
  await expect(parallel([() => Promise.reject(failure), () => sibling])).rejects.toBe(failure)
  expect(completed).toBe(false)
  finish('still running')
  expect(await sibling).toBe('still running')
  expect(completed).toBe(true)
})

function checkTypes() {
  const values = parallel([() => 1, async () => 'two', () => true])
  const tuple: Promise<[number, string, boolean]> = values
  // @ts-expect-error the first task returns a number
  const wrong: Promise<[string, string, boolean]> = values
  const empty: Promise<[]> = parallel([])
  const callbacks: ReadonlyArray<() => Promise<number>> = [async () => 1]
  const array: Promise<number[]> = parallel(callbacks)
  void tuple; void wrong; void empty; void array
}
void checkTypes
