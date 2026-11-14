import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from './json'

/** Flush directory-entry changes and close the directory handle. I/O failures reject.
 * On Windows this resolves without a flush because Node does not provide directory fsync. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** Replace a checkpoint with canonical JSON after flushing a sibling temporary file, then
 * flush its parent directory where supported. The caller must create the parent and serialize
 * competing writes to the same path. Invalid JSON rejects before any file I/O.
 * A directory flush can fail after replacement.
 * If temporary-file cleanup fails, the rejection includes both failures. */
export async function atomicPublish(path: string, value: unknown): Promise<void> {
  const text = `${canonicalJson(value)}\n`
  const temporary = `${path}.${randomUUID()}.tmp`
  // An exclusive open establishes ownership. Cleanup must leave an existing file alone.
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(text, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch (cause) {
    try {
      await unlink(temporary)
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Atomic publish failed')
    }
    throw cause
  }
  await syncDirectory(dirname(path))
}
