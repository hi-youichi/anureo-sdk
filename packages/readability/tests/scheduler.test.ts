import { expect, test } from 'bun:test'
import { mapSettled } from '../src/scheduler'

test('bounds active tasks, preserves input order and waits for failed-task siblings', async () => {
  let active = 0
  let peak = 0
  const releases: Array<() => void> = []
  const pending = mapSettled([0, 1, 2, 3], 2, async value => {
    peak = Math.max(peak, ++active)
    await new Promise<void>(resolve => { releases[value] = resolve })
    active--
    if (value === 1) throw new Error('expected failure')
    return value
  })
  expect(active).toBe(2)
  releases[1]!()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  releases[0]!()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  releases[2]!(); releases[3]!()
  const result = await pending
  expect(peak).toBe(2)
  expect(active).toBe(0)
  expect(result.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
  expect(result[3]).toEqual({ status: 'fulfilled', value: 3 })
})

test('abort stops scheduling, drains started tasks and rejects the operation', async () => {
  const controller = new AbortController()
  let release!: () => void
  const started: number[] = []
  const pending = mapSettled([0, 1, 2], 1, async value => {
    started.push(value)
    await new Promise<void>(resolve => { release = resolve })
  }, controller.signal)
  const captured = pending.catch(cause => cause)
  controller.abort(new Error('cancelled'))
  release()
  expect((await captured).message).toBe('cancelled')
  expect(started).toEqual([0])
})
