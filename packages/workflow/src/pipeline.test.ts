import { expect, test } from 'bun:test'
import { pipeline } from './index'

test('a fast item reaches the next stage without waiting for a slow item', async () => {
  let releaseSlow!: () => void
  let reachedFast!: () => void
  const slow = new Promise<void>(resolve => { releaseSlow = resolve })
  const fast = new Promise<void>(resolve => { reachedFast = resolve })
  const result = pipeline(
    ['fast', 'slow'],
    async value => { if (value === 'slow') await slow; return { value } },
    value => { if (value.value === 'fast') reachedFast(); return value.value.toUpperCase() },
  )
  await fast
  releaseSlow()
  expect(await result).toEqual(['FAST', 'SLOW'])
})

test('supports multiple asynchronous type transitions', async () => {
  expect(await pipeline(
    ['one', 'four'],
    value => ({ length: value.length }),
    async value => value.length,
    value => value > 3,
    async value => value ? new Date(0) : null,
  )).toEqual([null, new Date(0)])
})

test('supports one stage, empty input, and ordinary object identity', async () => {
  const map = new Map([['key', 1]])
  const values = await pipeline([map], value => value)
  expect(values[0]).toBe(map)
  expect(await pipeline([] as number[], value => value + 1)).toEqual([])
})

test('supports arbitrarily long chains of typed stage functions', async () => {
  const increment = (value: number) => value + 1
  expect(await pipeline([0], increment, increment, increment, increment, increment, increment, increment, increment)).toEqual([8])
})

test('a failed item skips its remaining stages while other items continue', async () => {
  const failure = new Error('bad item')
  let release!: () => void
  let completed!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sibling = new Promise<void>(resolve => { completed = resolve })
  const finalItems: number[] = []
  let settled = false
  const result = pipeline(
    [1, 2],
    async value => { if (value === 1) throw failure; await gate; return value },
    value => { finalItems.push(value); completed(); return value },
  ).then(values => { settled = true; return values })
  // Give the failed item's rejection handling a chance to advance before checking
  // that the sibling blocked on gate keeps the pipeline pending. These two yields
  // provide bounded scheduling progress, without guaranteeing failure handling is complete.
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(finalItems).toEqual([])
  release()
  await sibling
  expect(finalItems).toEqual([2])
  expect(await result).toEqual([null, 2])
})

test('passes the previous result, original item and index to every stage', async () => {
  const first = Promise.resolve('first')
  const second = Promise.resolve('second')
  const originals = [first, second] as const
  const seen: unknown[][] = []
  const result = await pipeline(
    originals,
    (value, original, index) => {
      expect(original).toBe(originals[index]!)
      seen.push([value, index])
      return value.length
    },
    async (length, original, index) => {
      expect(original).toBe(originals[index]!)
      return { length, item: await original, index }
    },
  )
  expect(seen).toEqual([['first', 0], ['second', 1]])
  expect(result).toEqual([{ length: 5, item: 'first', index: 0 }, { length: 6, item: 'second', index: 1 }])
})

test('null input or stage results skip later stages while other falsy values continue', async () => {
  const entered: unknown[] = []
  const next: unknown[] = []
  const result = await pipeline(
    [null, 0, false, '', undefined, 'drop'],
    value => { entered.push(value); return value === 'drop' ? null : value },
    value => { next.push(value); return value },
  )
  expect(result).toEqual([null, 0, false, '', undefined, null])
  expect(entered).toEqual([0, false, '', undefined, 'drop'])
  expect(next).toEqual([0, false, '', undefined])
})

test('isolates rejected input promises and synchronous stage failures', async () => {
  const entered: number[] = []
  expect(await pipeline(
    [Promise.reject(new Error('input')), Promise.resolve(1), Promise.resolve(2)],
    value => { entered.push(value); if (value === 1) throw new Error('stage'); return value * 10 },
  )).toEqual([null, null, 20])
  expect(entered).toEqual([1, 2])
})

test('zero stages await input values and convert input rejection to null', async () => {
  expect(await pipeline([Promise.resolve(1), Promise.reject(new Error('failed')), null, 0, undefined])).toEqual([1, null, null, 0, undefined])
  expect(await pipeline([])).toEqual([])
})

test('validates arrays and all stages before processing nonempty input', async () => {
  let started = false
  // @ts-expect-error invalid stage from a JavaScript caller
  await expect(pipeline([1], () => { started = true }, undefined)).rejects.toBeInstanceOf(TypeError)
  expect(started).toBe(false)
  // @ts-expect-error array-like objects are not arrays
  await expect(pipeline({ map: () => [] })).rejects.toBeInstanceOf(TypeError)
  // @ts-expect-error missing input
  await expect(pipeline()).rejects.toBeInstanceOf(TypeError)
  // @ts-expect-error empty inputs return before validating stages, matching the reference
  expect(await pipeline([], undefined)).toEqual([])
})

function checkTypes() {
  const firstStage = (value: string) => value.length
  const secondStage = (value: number) => value > 0
  const namedStages: Promise<(boolean | null)[]> = pipeline(['x'], firstStage, secondStage)
  const increment = (value: number) => value + 1
  const longChain: Promise<(number | null)[]> = pipeline([0], increment, increment, increment, increment, increment, increment, increment)
  // @ts-expect-error the last named stage cannot consume the preceding number
  pipeline([0], increment, increment, increment, increment, increment, increment, (value: string) => value)
  const result = pipeline(
    ['file.ts'],
    file => ({ file, valid: true }),
    async review => review.valid,
    valid => valid ? 1 : 0,
  )
  const values: Promise<(number | null)[]> = result
  // @ts-expect-error the last stage returns numbers
  const wrong: Promise<(string | null)[]> = result
  // @ts-expect-error failure or an earlier null result can skip the final stage
  const missingNull: Promise<number[]> = result
  // @ts-expect-error stage two expects a string but stage one produces a number
  pipeline(['x'], value => value.length, (value: string) => value.toUpperCase())
  // @ts-expect-error first stage must accept the input item type
  pipeline([1], (value: string) => value)
  const zero: Promise<(number | null)[]> = pipeline([Promise.resolve(1)])
  const empty: Promise<null[]> = pipeline([])
  const context = pipeline([Promise.resolve('x')], (value, original, index) => {
    const text: string = value
    const input: Promise<string> = original
    const position: number = index
    void input
    return text.length + position
  }, (value, original, index) => {
    const length: number = value
    const input: Promise<string> = original
    void input
    return length + index
  })
  const nullable: Promise<(number | null)[]> = pipeline([1], () => Math.random() ? null : 1, value => {
    const number: number = value
    return number + 1
  })
  pipeline([undefined as number | undefined | null], value => {
    const allowed: number | undefined = value
    // @ts-expect-error undefined is passed to stages normally
    const required: number = value
    void required
    return allowed
  })
  const six = pipeline(['x'], value => value.length, value => value > 0,
    value => ({ valid: value }), value => value.valid ? 'yes' : 'no',
    (value, original, index) => value.length + original.length + index, value => value > 0)
  const sixResult: Promise<(boolean | null)[]> = six
  void values; void wrong; void missingNull; void namedStages; void longChain; void zero; void empty; void context; void nullable; void sixResult
}
void checkTypes
