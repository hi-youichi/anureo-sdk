import { join } from 'node:path'
import { atomicPublish } from './atomic'
import { digest, jsonCopy, type JsonValue } from './json'
import type { AttemptRef, Origin } from './store'

export async function commitStep(
  runDirectory: string,
  attempt: AttemptRef,
  value: JsonValue,
  origin: Origin | null,
): Promise<void> {
  const result = jsonCopy(value)
  const resultFile = `results/${attempt.attemptId}.json`
  await atomicPublish(join(runDirectory, resultFile), result)
  const record = {
    checkpointFormatVersion: 1,
    runId: attempt.runId,
    stepKey: attempt.step.key,
    attemptId: attempt.attemptId,
    inputDigest: attempt.step.inputDigest,
    schemaDigest: attempt.step.schemaDigest,
    resultDigest: digest(result),
    resultFile,
    completedAt: new Date().toISOString(),
    reusedFrom: origin,
  }
  await atomicPublish(join(runDirectory, 'checkpoints', `${digest(attempt.step.key)}.json`),
    { ...record, recordDigest: digest(record) })
}
