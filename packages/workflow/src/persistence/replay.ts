import { lstat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { readJson } from './checkpoint-files'
import { digest } from './json'
import {
  checkpointFormat, invalidCheckpoint, journalEventSchema, lockSchema, manifestSchema, verifyRecord,
  type JournalEvent, type Manifest,
} from './records'

/** Load an inactive source run's validated events without modifying its files.
 * publishInitialRun calls this while holding the target lock, then copies the events
 * into the new journal. A mismatched run ID or invalid required record rejects as
 * WORKFLOW_CHECKPOINT_INVALID. Mismatched name or revision rejects as WORKFLOW_INCOMPATIBLE_RUN.
 * A valid lock without evidence of a dead local writer rejects as WORKFLOW_SOURCE_ACTIVE.
 * Completed and incomplete sources must have a result matching the manifest digest.
 * Other filesystem errors propagate for storage error normalization.
 * The caller supplies a separate target directory. This check acquires no source lock. */
export async function loadSourceJournal(directory: string, identity: SourceIdentity): Promise<JournalEvent[]> {
  await regularDirectory(directory)
  await assertInactive(directory)
  const manifest = verifyRecord(manifestSchema, await requiredJson(join(directory, checkpointFormat.manifest)))
  assertCompatibleIdentity(manifest.identity, identity)
  const raw = await requiredJson(join(directory, checkpointFormat.journal))
  const parsed = journalEventSchema.array().safeParse(raw)
  if (!parsed.success) invalidCheckpoint()
  if (manifest.status === 'completed' || manifest.status === 'incomplete') {
    if (digest(await requiredJson(join(directory, checkpointFormat.result))) !== manifest.resultDigest) invalidCheckpoint()
  }
  return parsed.data
}

type SourceIdentity = Pick<Manifest['identity'], 'name' | 'revision' | 'runId'>

/** Check that the manifest belongs to the selected run before checking workflow compatibility.
 * A misplaced manifest is checkpoint corruption even if its workflow name or revision differs. */
function assertCompatibleIdentity(actual: SourceIdentity, expected: SourceIdentity): void {
  if (actual.runId !== expected.runId) invalidCheckpoint()
  if (actual.name !== expected.name || actual.revision !== expected.revision) {
    throw new HarnessSdkError('WORKFLOW_INCOMPATIBLE_RUN')
  }
}

/** Map missing required files and symlink races reported as ELOOP to invalid checkpoints.
 * Other failures reach openFileRun for storage error normalization. */
async function requiredJson(path: string) {
  try { return await readJson(path) }
  catch (cause) {
    if (missing(cause) || (cause as NodeJS.ErrnoException)?.code === 'ELOOP') invalidCheckpoint()
    throw cause
  }
}

/** Permit an absent writer lock or a validated local claim whose PID no longer exists.
 * An invalid lock rejects through verifyRecord. A valid lock that fails the liveness
 * check blocks loadSourceJournal before it reads the manifest. */
async function assertInactive(directory: string): Promise<void> {
  let lock
  try {
    lock = verifyRecord(lockSchema, await readJson(join(directory, checkpointFormat.lock)))
  } catch (cause) {
    if (missing(cause)) return
    throw cause
  }
  if (!localWriterExited(lock)) throw new HarnessSdkError('WORKFLOW_SOURCE_ACTIVE')
}

/** Only a local PID probe returning ESRCH proves the recorded process is gone.
 * A foreign host, live or reused PID, or refused probe leaves inactivity unproven.
 * This evidence is limited to the writer process and cannot confirm backend termination. */
function localWriterExited(lock: { hostname: string; pid: number }): boolean {
  if (lock.hostname !== hostname()) return false
  try {
    process.kill(lock.pid, 0)
    return false
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** Reject a symlink or other non-directory source before loadSourceJournal reads its lock.
 * Filesystem errors propagate to openFileRun for normalization. */
async function regularDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
}

/** Test for ENOENT so replay can allow an absent writer lock and reject absent required files. */
function missing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
}
