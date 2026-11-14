import { HarnessSdkError } from '@anureo/sdk'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { digest } from './json'
import { journalEventSchema, lockSchema, manifestSchema, invalidCheckpoint, missing,
  readJson, regularDirectory, verifyRecord, type Manifest } from './records'
import type { JournalEvent } from './journal'

/** Load an inactive source run's validated events without modifying its files.
 * publishInitialRun calls this while holding the target lock, then copies the events
 * into the new journal. Mismatched name/revision rejects as WORKFLOW_INCOMPATIBLE_RUN;
 * a mismatched run ID or corrupt/missing required records rejects as WORKFLOW_CHECKPOINT_INVALID.
 * Unproven writer inactivity rejects as WORKFLOW_SOURCE_ACTIVE; other I/O failures propagate.
 * Failed/running sources need no result file. No source lock is acquired or backend state inferred. */
export async function loadSourceJournal(
  directory: string,
  identity: { name: string; revision: string; runId: string },
): Promise<JournalEvent[]> {
  await regularDirectory(directory)
  await assertInactive(directory)
  // A format-v1 (explicit step) run directory fails manifest validation here.
  const manifest: Manifest = verifyRecord(manifestSchema, await requiredJson(join(directory, 'run.json')))
  if (manifest.identity.runId !== identity.runId) invalidCheckpoint()
  if (manifest.identity.name !== identity.name || manifest.identity.revision !== identity.revision) {
    throw new HarnessSdkError('WORKFLOW_INCOMPATIBLE_RUN')
  }
  const raw = await requiredJson(join(directory, 'journal.json'))
  const parsed = journalEventSchema.array().safeParse(raw)
  if (!parsed.success) invalidCheckpoint()
  if (manifest.status === 'completed' || manifest.status === 'incomplete') {
    if (digest(await requiredJson(join(directory, 'result.json'))) !== manifest.resultDigest) invalidCheckpoint()
  }
  return parsed.data
}

/** Missing required recovery files and final symlinks are invalid checkpoints, never cache misses. */
async function requiredJson(path: string) {
  try { return await readJson(path) }
  catch (cause) {
    if (missing(cause) || (cause as NodeJS.ErrnoException)?.code === 'ELOOP') invalidCheckpoint()
    throw cause
  }
}

/** Permit an absent writer lock or a validated local claim whose PID no longer exists.
 * Foreign hosts, permission failures and reused PIDs conservatively block replay; this
 * check says nothing about whether a prior backend execution terminated. */
async function assertInactive(directory: string): Promise<void> {
  let lock
  try { lock = verifyRecord(lockSchema, await readJson(join(directory, 'writer.lock'))) }
  catch (cause) { if (missing(cause)) return; throw cause }
  if (lock.hostname === hostname()) {
    try { process.kill(lock.pid, 0) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return }
  }
  throw new HarnessSdkError('WORKFLOW_SOURCE_ACTIVE')
}
