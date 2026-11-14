import { HarnessSdkError } from '@anureo/sdk'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { digest } from './json'
import { readJson, regularDirectory, missing } from './read-json'
import {
  journalEventSchema, lockSchema, manifestSchema, invalidCheckpoint, verifyRecord, type Manifest, type JournalEvent,
} from './records'

/** Load an inactive source run's validated events without modifying its files.
 * publishInitialRun calls this while holding the target lock, then copies the events
 * into the new journal. A mismatched run ID or invalid required record rejects as
 * WORKFLOW_CHECKPOINT_INVALID. Mismatched name or revision rejects as WORKFLOW_INCOMPATIBLE_RUN.
 * A valid lock without evidence of a dead local writer rejects as WORKFLOW_SOURCE_ACTIVE.
 * Other filesystem errors propagate. Failed and running sources need no result file.
 * The caller supplies a separate target directory. This check acquires no source lock. */
export async function loadSourceJournal(
  directory: string,
  identity: SourceIdentity,
): Promise<JournalEvent[]> {
  await regularDirectory(directory)
  await assertInactive(directory)
  const manifest = verifyRecord(manifestSchema, await requiredJson(join(directory, 'run.json')))
  assertCompatibleIdentity(manifest.identity, identity)
  const raw = await requiredJson(join(directory, 'journal.json'))
  const parsed = journalEventSchema.array().safeParse(raw)
  if (!parsed.success) invalidCheckpoint()
  if (manifest.status === 'completed' || manifest.status === 'incomplete') {
    if (digest(await requiredJson(join(directory, 'result.json'))) !== manifest.resultDigest) invalidCheckpoint()
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

/** Classify missing recovery files and final symlinks as invalid checkpoints.
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
    lock = verifyRecord(lockSchema, await readJson(join(directory, 'writer.lock')))
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
