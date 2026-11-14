import { createHash } from 'node:crypto'
import { HarnessSdkError } from '@anureo/sdk'

/** Lossless workflow data: finite numbers, dense arrays and string-keyed JSON objects. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue
}

/** Encode strict JSON with sorted object keys for persistence and cache identity.
 * Throws WORKFLOW_NON_JSON_VALUE for lossy values, cycles, non-plain objects, symbol keys,
 * accessors or non-enumerable fields. Shared acyclic objects are allowed; toJSON is never called. */
export function canonicalJson(value: unknown): string {
  return encodeJson(value, new Set())
}

/** Return an isolated JSON copy, rejecting the same unsupported values as canonicalJson. */
export function jsonCopy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

/** Deeply freeze an already validated, acyclic JSON value in place and return it.
 * prepareRun applies this to its private copy before exposing workflow's body input. */
export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/** Hash canonical JSON as lowercase SHA-256 hex; unsupported values throw as in canonicalJson. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Track only the current ancestry so repeated references encode normally while cycles reject. */
function encodeJson(item: unknown, ancestors: Set<object>): string {
  if (item === null) return 'null'
  if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
  if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : invalidJson()
  if (typeof item !== 'object' || ancestors.has(item)) return invalidJson()
  if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) return invalidJson()
  const descriptors = Object.getOwnPropertyDescriptors(item)
  ancestors.add(item)
  try {
    return Array.isArray(item)
      ? encodeArray(item, descriptors, ancestors)
      : encodeObject(item, descriptors, ancestors)
  } finally { ancestors.delete(item) }
}

/** Dense array slots must be the only own properties besides length to avoid silent data loss. */
function encodeArray(item: unknown[], descriptors: Record<string, PropertyDescriptor>, ancestors: Set<object>): string {
  if (Object.keys(descriptors).length !== item.length + 1) return invalidJson()
  const values: string[] = []
  for (let i = 0; i < item.length; i++) {
    values.push(encodeDataProperty(descriptors[String(i)], ancestors))
  }
  return `[${values.join(',')}]`
}

/** Restrict objects to plain data and sort their keys so insertion order cannot change identity. */
function encodeObject(item: object, descriptors: Record<string, PropertyDescriptor>, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(item)
  if (prototype !== Object.prototype && prototype !== null) return invalidJson()
  return `{${Object.keys(descriptors).sort().map(key =>
    `${JSON.stringify(key)}:${encodeDataProperty(descriptors[key], ancestors)}`
  ).join(',')}}`
}

/** Inspect descriptors instead of reading properties so getters never supply persisted data. */
function encodeDataProperty(field: PropertyDescriptor | undefined, ancestors: Set<object>): string {
  if (!field || !field.enumerable || !('value' in field)) return invalidJson()
  return encodeJson(field.value, ancestors)
}

function invalidJson(): never { throw new HarnessSdkError('WORKFLOW_NON_JSON_VALUE') }
