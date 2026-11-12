import { createHash } from 'node:crypto'
import { HarnessSdkError } from '@anureo/sdk'

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue
}

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const invalid = (): never => { throw new HarnessSdkError('WORKFLOW_NON_JSON_VALUE') }
  function encode(item: unknown): string {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : invalid()
    if (typeof item !== 'object' || ancestors.has(item)) return invalid()
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) return invalid()
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const keys = Object.keys(descriptors)
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        if (keys.length !== item.length + 1) return invalid()
        const values: string[] = []
        for (let i = 0; i < item.length; i++) {
          const field = descriptors[String(i)]
          if (!field || !field.enumerable || !('value' in field)) return invalid()
          values.push(encode(field.value))
        }
        return `[${values.join(',')}]`
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return invalid()
      return `{${keys.sort().map(key => {
        const field = descriptors[key]!
        if (!field.enumerable || !('value' in field)) return invalid()
        return `${JSON.stringify(key)}:${encode(field.value)}`
      }).join(',')}}`
    } finally { ancestors.delete(item) }
  }
  return encode(value)
}

export function jsonCopy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}

export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
