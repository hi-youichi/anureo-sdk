// Checks the filesystem entries that replay reads before validating checkpoint schemas.
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { canonicalJson, type JsonValue } from './json'
import { invalidCheckpoint } from './records'

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

/** Require the source's final path component to be a real directory. Other file kinds
 * reject as WORKFLOW_CHECKPOINT_INVALID before replay reads it. Filesystem errors propagate. */
export async function regularDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
}

/** Test for ENOENT so replay can allow an absent writer lock and reject absent required files. */
export function missing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
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
