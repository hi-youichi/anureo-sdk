import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import { digest, type JsonValue } from './json'

/** Validated manifest shape; its digest and referenced result still require separate verification. */
export type Manifest = z.output<typeof manifestSchema>

/** Persist only failure classification from workflow aborts, without diagnostic text. */
export type StoredFailure = z.output<typeof failureSchema>

/** Internal validated event persisted before dispatch or before exposing an agent outcome. */
export type JournalEvent = z.output<typeof journalEventSchema>

/** Reject unusable recovery material without treating corruption as an empty cache. */
export function invalidCheckpoint(): never { throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID') }

/** Add a digest of the supplied JSON payload for a lock or manifest. Callers must omit
 * recordDigest so the payload matches what verifyRecord later hashes. Strict JSON errors throw. */
export function record<T extends object>(value: T): T & { recordDigest: string } {
  return { ...value, recordDigest: digest(value) }
}

/** Return parsed lock or manifest data after verifying the payload digest. A schema
 * mismatch or different digest throws WORKFLOW_CHECKPOINT_INVALID. The schema must
 * yield strict JSON with a recordDigest field. */
export function verifyRecord<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) return invalidCheckpoint()
  const { recordDigest, ...payload } = parsed.data as Record<string, unknown>
  if (digest(payload) !== recordDigest) return invalidCheckpoint()
  return parsed.data
}

/** File names and version used by the target writer and the compatible-source reader. */
export const checkpointFormat = {
  version: 3,
  lock: 'writer.lock',
  manifest: 'run.json',
  journal: 'journal.json',
  result: 'result.json',
} as const

/** Check target and source basenames before joining paths. Reject blanks, separators,
 * control characters, dot traversal and names over 255 UTF-8 bytes. Unicode and spaces
 * support caller-assigned CLI basenames. */
export const runIdSchema = z.string().min(1).refine(value => value !== '.' && value !== '..'
  && value.trim().length > 0 && !/[\\/\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= 255)

// The exported record schemas evaluate their component schemas during initialization.
/** UUID rule shared by journal agent identities and writer-lock ownership tokens. */
const uuidSchema = z.string().uuid()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)

/** Writer claim. Replay checks host/PID liveness. Release checks the held inode. */
export const lockSchema = z.strictObject({
  checkpointFormatVersion: z.literal(checkpointFormat.version), token: uuidSchema, hostname: z.string(),
  pid: z.number().int().positive(), createdAt: z.string().datetime(), recordDigest: hashSchema,
})

const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]))
const identitySchema = z.strictObject({
  runId: runIdSchema, directory: z.string(), name: z.string().min(1), revision: z.string().min(1), input: jsonSchema,
})

/** Versioned chained SHA-256 identity for an agent call, independent of its execution UUID. */
export const journalKeyPrefix = 'v2:'
const journalKeySchema = z.string().refine(key =>
  key.startsWith(journalKeyPrefix) && hashSchema.safeParse(key.slice(journalKeyPrefix.length)).success)
const failedEventSchema = z.strictObject({ type: z.literal('failed'), key: journalKeySchema, agentId: uuidSchema,
  code: z.string().min(1), outcomeUnknown: z.boolean() })

/** Strict persisted events. Replay validates the entire array before handing it to AgentJournal.
 * The chained key determines reuse. The execution UUID is recorded as agentId. */
export const journalEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), key: journalKeySchema, agentId: uuidSchema,
    retainReplayKeys: journalKeySchema.array().optional() }),
  z.strictObject({ type: z.literal('result'), key: journalKeySchema, agentId: uuidSchema, result: jsonSchema }),
  failedEventSchema,
])

const unknownFailureSchema = failedEventSchema.extend({ outcomeUnknown: z.literal(true) })
export type UnknownFailure = z.output<typeof unknownFailureSchema>

/** Persist only safe failure metadata; diagnostic messages and details stay out of manifests. */
const failureSchema = z.strictObject({
  code: z.string(),
  retryable: z.boolean(),
  outcomeUnknown: z.boolean(),
  cleanupFailed: z.boolean(),
  unpublishedUnknownFailures: unknownFailureSchema.array().optional(),
})

/** Replay verifies the manifest digest and the journal of every terminal run. */
export const manifestSchema = z.strictObject({
  checkpointFormatVersion: z.literal(checkpointFormat.version),
  identity: identitySchema, createdAt: z.string().datetime(),
  resumedFrom: z.strictObject({ directory: z.string(), runId: runIdSchema }).nullable(),
  status: z.enum(['running', 'completed', 'incomplete', 'failed']),
  journalDigest: hashSchema.nullable(), resultDigest: hashSchema.nullable(),
  failure: failureSchema.nullable(), recordDigest: hashSchema,
})
