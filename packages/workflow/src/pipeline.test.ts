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
  const result = pipeline(
    [1, 2],
    async value => { if (value === 1) throw failure; await gate; return value },
    value => { finalItems.push(value); completed(); return value },
  )
  await expect(result).rejects.toBe(failure)
  expect(finalItems).toEqual([])
  release()
  await sibling
  expect(finalItems).toEqual([2])
})

test('requires at least one stage for JavaScript callers', async () => {
  // @ts-expect-error exercise the untyped JavaScript call
  await expect(pipeline([1])).rejects.toBeInstanceOf(TypeError)
})

function checkTypes() {
  const firstStage = (value: string) => value.length
  const secondStage = (value: number) => value > 0
  const namedStages: Promise<boolean[]> = pipeline(['x'], firstStage, secondStage)
  const increment = (value: number) => value + 1
  const longChain: Promise<number[]> = pipeline([0], increment, increment, increment, increment, increment, increment, increment)
  // @ts-expect-error the last named stage cannot consume the preceding number
  pipeline([0], increment, increment, increment, increment, increment, increment, (value: string) => value)
  const result = pipeline(
    ['file.ts'],
    file => ({ file, valid: true }),
    async review => review.valid,
    valid => valid ? 1 : 0,
  )
  const values: Promise<number[]> = result
  // @ts-expect-error the last stage returns numbers
  const wrong: Promise<string[]> = result
  // @ts-expect-error stage two expects a string but stage one produces a number
  pipeline(['x'], value => value.length, (value: string) => value.toUpperCase())
  // @ts-expect-error first stage must accept the input item type
  pipeline([1], (value: string) => value)
  // @ts-expect-error at least one stage is required
  pipeline([])
  void values; void wrong; void namedStages; void longChain
}
void checkTypes
