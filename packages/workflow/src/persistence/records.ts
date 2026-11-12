import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import { canonicalJson, digest, type JsonValue } from './json'

// Caller-assigned IDs also support existing CLI output basenames (including Unicode/spaces).
export const runIdSchema = z.string().min(1).refine(value => value !== '.' && value !== '..'
  && value.trim().length > 0 && !/[\\/\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= 255)
export const uuidSchema = z.string().uuid()
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]))
export const failureSchema = z.strictObject({
  code: z.string(), retryable: z.boolean(), outcomeUnknown: z.boolean(), cleanupFailed: z.boolean(),
})
const identitySchema = z.strictObject({
  runId: runIdSchema, directory: z.string(), name: z.string().min(1), revision: z.string().min(1), input: jsonSchema,
})
export const manifestSchema = z.strictObject({
  checkpointFormatVersion: z.literal(2),
  identity: identitySchema, createdAt: z.string().datetime(),
  resumedFrom: z.strictObject({ directory: z.string(), runId: runIdSchema }).nullable(),
  status: z.enum(['running', 'completed', 'incomplete', 'failed']),
  resultDigest: hashSchema.nullable(), failure: failureSchema.nullable(), recordDigest: hashSchema,
})
export const journalKeySchema = z.string().regex(/^v1:[a-f0-9]{64}$/)
export const journalEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), key: journalKeySchema, agentId: uuidSchema }),
  z.strictObject({ type: z.literal('result'), key: journalKeySchema, agentId: uuidSchema, result: jsonSchema }),
  z.strictObject({ type: z.literal('failed'), key: journalKeySchema, agentId: uuidSchema,
    code: z.string().min(1), outcomeUnknown: z.boolean() }),
])
export const lockSchema = z.strictObject({
  checkpointFormatVersion: z.literal(2), token: uuidSchema, hostname: z.string(),
  pid: z.number().int().positive(), createdAt: z.string().datetime(), recordDigest: hashSchema,
})
export type Manifest = z.output<typeof manifestSchema>

export function invalidCheckpoint(): never { throw new HarnessSdkError('WORKFLOW_CHECKPOINT_INVALID') }

export function record<T extends object>(value: T): T & { recordDigest: string } {
  return { ...value, recordDigest: digest(value) }
}

export function verifyRecord<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) return invalidCheckpoint()
  const { recordDigest, ...payload } = parsed.data as Record<string, unknown>
  if (digest(payload) !== recordDigest) return invalidCheckpoint()
  return parsed.data
}

/** Only ENOENT represents missing data; links, bad JSON and bad schemas are never cache misses. */
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

export async function regularDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) invalidCheckpoint()
}

export function missing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
}
