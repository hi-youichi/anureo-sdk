/** Provides native field readers and JSON projection for transport and mapping code. */
import { publicValue, type JsonValue } from '@anureo/protocol'

/** An object whose native fields still need validation before use. */
export type NativeRecord = Record<string, unknown>

/**
 * Return the original non-array object or a new empty record for other values.
 * Decoders must validate fields and avoid mutating the shared input.
 */
export function record(value: unknown): NativeRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : {}
}

/** Return a string field as supplied, including an empty string. Other values yield undefined. */
export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Copy a value through JSON serialization, mapping top-level undefined to null.
 * Serialization can run toJSON hooks. Their errors and any stringify or parse failures propagate.
 * Use safe when the result also needs protocol redaction.
 */
export function json(value: unknown): JsonValue {
  return value === undefined ? null : JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Build a JSON payload with protocol redaction. JSON normalization can run hooks and throw
 * before redaction. mapItems embeds the result in items, and CodexBackendSession.notification
 * uses it in hook and notice events. Callers choose which native fields to expose and remove
 * secrets embedded in arbitrary text.
 */
export function safe(value: unknown): JsonValue {
  return publicValue(json(value))
}
