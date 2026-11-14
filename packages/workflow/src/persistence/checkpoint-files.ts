import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { canonicalJson, type JsonValue } from './json'
import { invalidCheckpoint } from './records'

/** Flush directory-entry changes and close the directory handle. I/O failures reject.
 * On Windows this resolves without a flush because Node does not provide directory fsync. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

/** Publish one complete checkpoint by renaming a flushed sibling temporary file, then flush
 * its parent directory where supported. FileRunHandle and AgentJournal serialize their own
 * writes because a rename alone cannot prevent an older snapshot from overwriting a newer one.
 * The caller creates the parent. Invalid JSON rejects before any file I/O.
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

/** Read strict JSON from a regular file and always close its descriptor. Check the final
 * component with lstat and verify the opened inode to catch replacement during open.
 * Invalid content or file kind rejects as WORKFLOW_CHECKPOINT_INVALID. Replay classifies
 * filesystem failures and validates the returned value against the checkpoint schema. */
export async function readJson(path: string): Promise<JsonValue> {
  const before = await lstat(path)
  if (!before.isFile()) return invalidCheckpoint()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await file.stat()
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino) return invalidCheckpoint()
    return parseCheckpointJson(await file.readFile('utf8'))
  } finally {
    await file.close()
  }
}

/** Normalize failures caught by openFileRun, FileRunHandle and AgentJournal.append.
 * Preserve SDK errors by identity; report other failures as WORKFLOW_STORAGE_FAILED
 * without passing filesystem diagnostics to workflow consumers. */
export function storageError(cause: unknown): HarnessSdkError {
  if (cause instanceof HarnessSdkError) return cause
  return new HarnessSdkError('WORKFLOW_STORAGE_FAILED')
}

/** Map malformed or nonrepresentable JSON to checkpoint corruption before schema validation.
 * JSON.parse alone accepts number literals that overflow to Infinity. */
function parseCheckpointJson(text: string): JsonValue {
  try {
    const value = JSON.parse(text) as JsonValue
    canonicalJson(value)
    return value
  } catch {
    return invalidCheckpoint()
  }
}
