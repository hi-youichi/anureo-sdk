import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import { canonicalJson, digest, type JsonValue } from './json'

/** Internal run-directory component rule: nonblank, at most 255 UTF-8 bytes, without separators,
 * control characters or dot traversal. Unicode and spaces support caller-assigned CLI basenames. */
export const runIdSchema = z.string().min(1).refine(value => value !== '.' && value !== '..'
  && value.trim().length > 0 && !/[\\/\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= 255)
/** UUID rule shared by journal agent identities and writer-lock ownership tokens. */
export const uuidSchema = z.string().uuid()
/** Persist only safe failure metadata; diagnostic messages and details stay out of manifests. */
export const failureSchema = z.strictObject({
  code: z.string(), retryable: z.boolean(), outcomeUnknown: z.boolean(), cleanupFailed: z.boolean(),
})

/** Versioned chained SHA-256 identity for an agent call, independent of its execution UUID. */
export const journalKeySchema = z.string().regex(/^v1:[a-f0-9]{64}$/)

/** Validated manifest shape; its digest and referenced result still require separate verification. */
export type Manifest = z.output<typeof manifestSchema>

/** Reject unusable recovery material without treating corruption as an empty cache. */
export function invalidCheckpoint(): never { throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID') }

/** Add a digest of the supplied JSON payload; callers must omit any existing recordDigest. */
export function record<T extends object>(value: T): T & { recordDigest: string } {
  return { ...value, recordDigest: digest(value) }
}

/** Validate a record schema and its payload digest, returning parsed data or throwing
 * WORKFLOW_CHECKPOINT_INVALID. The schema must include a recordDigest field. */
export function verifyRecord<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) return invalidCheckpoint()
  const { recordDigest, ...payload } = parsed.data as Record<string, unknown>
  if (digest(payload) !== recordDigest) return invalidCheckpoint()
  return parsed.data
}

/** Read strict JSON from a regular file without following a final symlink, checking that the
 * opened inode matches lstat and always closing it. Invalid content/file kind rejects as
 * WORKFLOW_CHECKPOINT_INVALID; filesystem errors propagate for replay to classify.
 * Record/event schemas are checked by the caller, not by this reader. */
export async function readJson(path: string): Promise<JsonValue> {
  const before = await lstat(path)
  if (!before.isFile()) return invalidCheckpoint()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await file.stat()
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino) return invalidCheckpoint()
    const text = await file.readFile('utf8')
    let value: unknown
    try { value = JSON.parse(text); canonicalJson(value) } catch { return invalidCheckpoint() }
    return value as JsonValue
  } finally { await file.close() }
}

/** Require a directory rather than a symlink; filesystem failures propagate, other kinds reject
 * as WORKFLOW_CHECKPOINT_INVALID before replay reads recovery material. */
export async function regularDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
}

/** Only ENOENT permits replay to treat an absent writer lock as inactive. */
export function missing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
}

// These schemas must be initialized before the exported record schemas that compose them.
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]))
const identitySchema = z.strictObject({
  runId: runIdSchema, directory: z.string(), name: z.string().min(1), revision: z.string().min(1), input: jsonSchema,
})
/** Format-v2 run metadata. verifyRecord also checks recordDigest; replay separately checks
 * resultDigest against result.json for completed and incomplete runs. */
export const manifestSchema = z.strictObject({
  checkpointFormatVersion: z.literal(2),
  identity: identitySchema, createdAt: z.string().datetime(),
  resumedFrom: z.strictObject({ directory: z.string(), runId: runIdSchema }).nullable(),
  status: z.enum(['running', 'completed', 'incomplete', 'failed']),
  resultDigest: hashSchema.nullable(), failure: failureSchema.nullable(), recordDigest: hashSchema,
})
/** Strict persisted events; source replay validates the entire array before indexing any results. */
export const journalEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), key: journalKeySchema, agentId: uuidSchema }),
  z.strictObject({ type: z.literal('result'), key: journalKeySchema, agentId: uuidSchema, result: jsonSchema }),
  z.strictObject({ type: z.literal('failed'), key: journalKeySchema, agentId: uuidSchema,
    code: z.string().min(1), outcomeUnknown: z.boolean() }),
])
/** Format-v2 writer claim. Replay checks host/PID liveness; release checks the held inode. */
export const lockSchema = z.strictObject({
  checkpointFormatVersion: z.literal(2), token: uuidSchema, hostname: z.string(),
  pid: z.number().int().positive(), createdAt: z.string().datetime(), recordDigest: hashSchema,
})
