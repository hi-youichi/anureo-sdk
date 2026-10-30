import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Deterministic emitter for the JSON Schema vocabulary used by AHP.
 * Unsupported type-bearing keywords fail instead of silently emitting `any`.
 */
type Schema = boolean | { [key: string]: unknown }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(path.join(root, 'schema/v1/ahp.schema.json'), 'utf8')
const document = JSON.parse(source) as { $defs: Record<string, Schema>; 'x-methods': Record<string, [string, string]> }
function literal(value: unknown): string { return JSON.stringify(value) }
function emit(value: Schema): string {
  if (value === true) return 'unknown'
  if (value === false) return 'never'
  if (typeof value.$ref === 'string') {
    const match = /^#\/\$defs\/([\w]+)$/.exec(value.$ref)
    if (!match || !document.$defs[match[1]!]) throw new Error(`Unsupported reference ${value.$ref}`)
    return match[1]!
  }
  if ('const' in value) return literal(value.const)
  if (Array.isArray(value.enum)) return value.enum.map(literal).join(' | ')
  if (!value.type && Array.isArray(value.oneOf)) return value.oneOf.map(v => `(${emit(v as Schema)})`).join(' | ')
  if (!value.type && Array.isArray(value.anyOf)) return value.anyOf.map(v => `(${emit(v as Schema)})`).join(' | ')
  if (!value.type && Array.isArray(value.allOf)) return value.allOf.map(v => `(${emit(v as Schema)})`).join(' & ')
  switch (value.type) {
    case 'string': return 'string'
    case 'integer': case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    case 'array': return `Array<${emit(value.items as Schema)}>`
    case 'object': {
      const required = new Set((value.required ?? []) as string[])
      const properties = (value.properties ?? {}) as Record<string, Schema>
      const fields = Object.entries(properties).map(([key, prop]) => `${literal(key)}${required.has(key) ? '' : '?'}: ${emit(prop)}`)
      if (typeof value.additionalProperties === 'object') fields.push(`[key: string]: ${emit(value.additionalProperties as Schema)}`)
      return `{ ${fields.join('; ')} }`
    }
    default: throw new Error(`Unsupported schema: ${JSON.stringify(value).slice(0, 180)}`)
  }
}
const aliases = Object.entries(document.$defs).map(([name, schema]) => `export type ${name} = ${emit(schema)};`)
const methods = Object.entries(document['x-methods'])
const lines = [
  '// Generated from schema/v1/ahp.schema.json. Run `bun run generate`; do not edit.',
  ...aliases,
  'export interface AhpRequestMap {', ...methods.map(([method, [params]]) => `  ${literal(method)}: ${params};`), '}',
  'export interface AhpResultMap {', ...methods.map(([method, [, result]]) => `  ${literal(method)}: ${result};`), '}',
  'export type AhpMethod = keyof AhpRequestMap;',
  `export const AHP_METHODS = ${JSON.stringify(methods.map(([name]) => name), null, 2)} as const;`,
  `export const AHP_METHOD_DEFINITIONS = ${JSON.stringify(document['x-methods'], null, 2)} as const;`,
]
const output = lines.join('\n') + '\n'
const target = path.join(root, 'src/generated/types.ts')
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Generated AHP types differ; run bun run generate')
} else await writeFile(target, output)
