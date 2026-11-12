import { HarnessSdkError } from '@anureo/sdk'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { digest } from './json'
import { journalEventSchema, lockSchema, manifestSchema, invalidCheckpoint, missing,
  readJson, regularDirectory, verifyRecord, type Manifest } from './records'
import type { JournalEvent } from './journal'

async function requiredJson(path: string) {
  try { return await readJson(path) }
  catch (cause) {
    if (missing(cause) || (cause as NodeJS.ErrnoException)?.code === 'ELOOP') invalidCheckpoint()
    throw cause
  }
}

async function assertInactive(directory: string): Promise<void> {
  let lock
  try { lock = verifyRecord(lockSchema, await readJson(join(directory, 'writer.lock'))) }
  catch (cause) { if (missing(cause)) return; throw cause }
  if (lock.hostname === hostname()) {
    try { process.kill(lock.pid, 0) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return }
  }
  // A reused PID is conservatively considered active. Never infer backend termination.
  throw new HarnessSdkError('WORKFLOW_SOURCE_ACTIVE')
}

/** Loads a finished or crashed source run's journal for cache replay. */
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
