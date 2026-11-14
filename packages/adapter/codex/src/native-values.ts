/** Owns native value coercion and public JSON sanitization; transport and session state belong to callers. */
import { publicValue, type JsonValue } from '@anureo/protocol'

/** Unvalidated fields for native decoders and projections; this type promises neither plain objects nor validated contents. */
export type NativeRecord = Record<string, unknown>

/** Inspect a non-array object without cloning or field validation; other values become empty records. The returned object aliases the input, so decoders must validate fields before use and avoid mutating shared native data. */
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

/** Build a JSON-compatible payload with protocol redaction for public items/events. mapItems and CodexBackendSession.notification embed the result in their projections; callers still choose which native fields to expose. JSON normalization runs hooks and propagates serialization errors before redaction. */
export function safe(value: unknown): JsonValue {
  return publicValue(json(value))
}
