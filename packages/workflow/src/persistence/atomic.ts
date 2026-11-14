import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from './json'

/** Flush directory-entry changes and close the directory handle; I/O failures reject.
 * Windows skips this step because Node does not provide directory fsync there. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** Replace a file with canonical JSON after flushing a sibling temporary file, then flush
 * its parent directory. The caller must create the parent and serialize competing writes.
 * Rejections can occur after replacement; temporary-file cleanup failures aggregate with
 * the original failure, so rejection does not guarantee the destination was unchanged. */
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
