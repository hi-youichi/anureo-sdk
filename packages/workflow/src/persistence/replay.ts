import { HarnessSdkError } from '@anureo/sdk'
import type { Origin, PriorStep } from './store'
import { hostname } from 'node:os'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from './json'
import { attemptSchema, checkpointSchema, inheritedSchema, invalidCheckpoint, lockSchema,
  manifestSchema, missing, readJson, regularDirectory, verifyRecord, type Manifest } from './records'

export interface IndexedStep {
  key: string
  recordedIn: Origin
  state: Exclude<PriorStep, { kind: 'missing' }>
}

export function mergeSourceIndex(
  inherited: readonly IndexedStep[],
  current: readonly IndexedStep[],
): IndexedStep[] {
  const effective = new Map<string, IndexedStep>()
  for (const layer of [inherited, current]) {
    const seen = new Set<string>()
    for (const entry of layer) {
      if (seen.has(entry.key)) throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID')
      seen.add(entry.key)
      effective.set(entry.key, entry)
    }
  }
  return [...effective.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

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

export async function loadSource(directory: string, name: string, runId: string): Promise<IndexedStep[]> {
  await regularDirectory(directory)
  await assertInactive(directory)
  const manifest = verifyRecord(manifestSchema, await requiredJson(join(directory, 'run.json')))
  if (manifest.identity.runId !== runId) invalidCheckpoint()
  if (manifest.identity.name !== name) throw new HarnessSdkError('WORKFLOW_INCOMPATIBLE_RUN')
  for (const child of ['inherited', 'attempts', 'checkpoints', 'results']) await regularDirectory(join(directory, child))
  const inherited = verifyRecord(inheritedSchema, await requiredJson(join(directory, 'inherited', 'index.json')))
  const current = new Map<string, IndexedStep>()
  const attempts = new Map<string, ReturnType<typeof attemptSchema.parse>>()
  for (const filename of await readdir(join(directory, 'attempts'))) {
    if (filename.endsWith('.tmp')) continue
    const attempt = verifyRecord(attemptSchema, await requiredJson(join(directory, 'attempts', filename)))
    const { step } = attempt
    if (filename !== `${attempt.attemptId}.json` || attempt.runId !== runId
      || current.has(step.key) || step.schemaDigest !== digest(step.schema)
      || step.inputDigest !== stepDigest(manifest, step)) invalidCheckpoint()
    attempts.set(attempt.attemptId, attempt)
    current.set(step.key, { key: step.key, recordedIn: { runId, attemptId: attempt.attemptId },
      state: { kind: 'uncommitted', outcome: attempt.status } })
  }
  for (const filename of await readdir(join(directory, 'checkpoints'))) {
    if (filename.endsWith('.tmp')) continue
    const checkpoint = verifyRecord(checkpointSchema, await requiredJson(join(directory, 'checkpoints', filename)))
    const attempt = attempts.get(checkpoint.attemptId)
    if (!attempt || attempt.status !== 'started' || checkpoint.runId !== runId
      || checkpoint.stepKey !== attempt.step.key || filename !== `${digest(checkpoint.stepKey)}.json`
      || checkpoint.inputDigest !== attempt.step.inputDigest || checkpoint.schemaDigest !== attempt.step.schemaDigest
      || checkpoint.resultFile !== `results/${attempt.attemptId}.json`) invalidCheckpoint()
    const value = await requiredJson(join(directory, checkpoint.resultFile))
    if (digest(value) !== checkpoint.resultDigest) invalidCheckpoint()
    current.set(checkpoint.stepKey, { key: checkpoint.stepKey,
      recordedIn: { runId, attemptId: attempt.attemptId }, state: { kind: 'committed',
        inputDigest: checkpoint.inputDigest, schemaDigest: checkpoint.schemaDigest, value,
        origin: checkpoint.reusedFrom ?? { runId, attemptId: attempt.attemptId } } })
  }
  if (manifest.status === 'completed' || manifest.status === 'incomplete') {
    if (digest(await requiredJson(join(directory, 'result.json'))) !== manifest.resultDigest) invalidCheckpoint()
  }
  return mergeSourceIndex(inherited.steps, [...current.values()])
}

function stepDigest(manifest: Manifest, step: { key: string; input: unknown; schemaDigest: string }) {
  const { name, revision, input: workflowInput } = manifest.identity
  return digest({ fingerprintVersion: 1, name, revision, workflowInput,
    stepKey: step.key, stepInput: step.input, schemaDigest: step.schemaDigest })
}
