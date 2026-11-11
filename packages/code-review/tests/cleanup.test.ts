import { expect, test } from 'bun:test'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupFixtures } from './fixtures/cleanup'

test('fixture release failure waits for other clients and explicitly retains directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anureo-cleanup-'))
  let finish!: () => void, settled = false, delayedReleased = false
  const barrier = new Promise<void>(resolve => { finish = resolve })
  const clients = [
    { dispose: async () => { throw new Error('release failed') } },
    { dispose: async () => { await barrier; delayedReleased = true } },
  ]
  const directories = [directory]
  const cleanup = cleanupFixtures(clients, directories).catch(error => { settled = true; return error })
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    finish()
    const error = await cleanup
    expect(delayedReleased).toBe(true)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain(`retained directories: ${directory}`)
    expect((await stat(directory)).isDirectory()).toBe(true)
    expect(directories).toEqual([])
    expect(clients).toEqual([])
  } finally { finish(); await cleanup; await rm(directory, { recursive: true, force: true }) }
})
