import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from './json'

/** Windows supports file flushes, but Node does not provide directory fsync there. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export async function atomicPublish(path: string, value: unknown): Promise<void> {
  const text = `${canonicalJson(value)}\n`
  const temporary = `${path}.${randomUUID()}.tmp`
  let temporaryExists = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    temporaryExists = true
    try { await file.writeFile(text, 'utf8'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
    temporaryExists = false
    await syncDirectory(dirname(path))
  } catch (cause) {
    if (temporaryExists) {
      try { await unlink(temporary) }
      catch (cleanup) { throw new AggregateError([cause, cleanup], 'Atomic publish failed') }
    }
    throw cause
  }
}
