/** Owns native value coercion and public JSON sanitization; transport and session state belong to callers. */
import { publicValue, type JsonValue } from '@anureo/protocol'

/** Unvalidated fields for native decoders and projections; this type promises neither plain objects nor validated contents. */
export type NativeRecord = Record<string, unknown>

/** Let native decoders inspect non-array objects without cloning; other values become empty records. Does not validate fields, mutate inputs or perform I/O. */
export function record(value: unknown): NativeRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : {}
}

/** Let native decoders distinguish strings (including empty strings) from absent/invalid fields; returns undefined otherwise, without coercion, mutation or I/O. */
export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** For projections, JSON-clone a value, mapping top-level undefined to null. Runs native toJSON hooks and propagates stringify/parse errors; performs no I/O itself. */
export function json(value: unknown): JsonValue {
  return value === undefined ? null : JSON.parse(JSON.stringify(value)) as JsonValue
}

/** For public payload builders, clone before protocol redaction so sanitization cannot mutate native data. Runs JSON hooks and propagates serialization errors; performs no I/O itself. */
export function safe(value: unknown): JsonValue {
  return publicValue(json(value))
}
