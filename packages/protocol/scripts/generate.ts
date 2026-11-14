/** Deterministic type generation and drift checking for the AHP schema vocabulary. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

type Schema = boolean | { [key: string]: unknown }
type ProtocolSchema = { $defs: Record<string, Schema>; 'x-methods': Record<string, [string, string]> }
type GenerationOptions = { version: 'v1'; mode: 'check' | 'write' }
type EmissionContext = {
  definitions: Record<string, Schema>
  /** Omission keeps types inline; a string enables multiline union/object formatting. */
  indentation?: string
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Read and render before touching the target; IO, JSON and unsupported-schema failures reject the CLI run. */
async function generate({ version, mode }: GenerationOptions): Promise<void> {
  const document = await readProtocolSchema(version)
  const output = renderTypes(document, version)
  await saveTypes(output, mode)
}

/** Load the package-relative schema without depending on the invoking shell's working directory. */
async function readProtocolSchema(version: 'v1'): Promise<ProtocolSchema> {
  const source = await readFile(path.join(root, `schema/${version}/ahp.schema.json`), 'utf8')
  return JSON.parse(source) as ProtocolSchema
}

/** Render definitions and method maps in schema order, ending the generated source with a newline. */
function renderTypes(document: ProtocolSchema, version: 'v1'): string {
  const definitions = document.$defs
  const aliases = Object.entries(definitions).map(([name, schema]) => {
    // Keep notification methods and the required item turnId intersections visible.
    if (name === 'AhpEventNotification') return `export type ${name} =\n  ${emit(schema, { definitions, indentation: '  ' })};`
    return `export type ${name} = ${emit(schema, { definitions })};`
  })
  const methods = Object.entries(document['x-methods'])
  const lines = [
    `// Generated from schema/${version}/ahp.schema.json. Run bun run generate; do not edit.`,
    ...aliases,
    'export interface AhpRequestMap {',
    ...methods.map(([method, [params]]) => `  ${JSON.stringify(method)}: ${params};`),
    '}',
    'export interface AhpResultMap {',
    ...methods.map(([method, [, result]]) => `  ${JSON.stringify(method)}: ${result};`),
    '}',
    'export type AhpMethod = keyof AhpRequestMap;',
    `export const AHP_METHODS = ${JSON.stringify(methods.map(([name]) => name), null, 2)} as const;`,
    `export const AHP_METHOD_DEFINITIONS = ${JSON.stringify(document['x-methods'], null, 2)} as const;`,
  ]
  return lines.join('\n') + '\n'
}

/** Check without writing, or await the generated file write; stale/missing targets and IO failures reject. */
async function saveTypes(output: string, mode: GenerationOptions['mode']): Promise<void> {
  const target = path.join(root, 'src/generated/types.ts')
  if (mode === 'check') {
    if (await readFile(target, 'utf8') !== output) throw new Error('Generated AHP types differ; run bun run generate')
  } else {
    await writeFile(target, output)
  }
}

/** Emit a TypeScript type from the schema vocabulary. Throw for unsupported references or type cases. */
function emit(value: Schema, context: EmissionContext): string {
  if (value === true) return 'unknown'
  if (value === false) return 'never'
  if (typeof value.$ref === 'string') {
    const name = /^#\/\$defs\/(\w+)$/.exec(value.$ref)?.[1]
    if (name === undefined || !context.definitions[name]) throw new Error(`Unsupported reference ${value.$ref}`)
    return name
  }
  if ('const' in value) return JSON.stringify(value.const)
  if (Array.isArray(value.enum)) return value.enum.map(entry => JSON.stringify(entry)).join(' | ')
  if (!value.type) {
    if (Array.isArray(value.oneOf)) return emitComposition(value.oneOf, '|', context)
    if (Array.isArray(value.anyOf)) return emitComposition(value.anyOf, '|', context)
    if (Array.isArray(value.allOf)) return emitComposition(value.allOf, '&', context)
  }
  switch (value.type) {
    case 'string': return 'string'
    case 'integer': case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    case 'array': return `Array<${emit(value.items as Schema, context)}>`
    case 'object': return emitObject(value, context)
    default: throw new Error(`Unsupported schema: ${JSON.stringify(value).slice(0, 180)}`)
  }
}

/** Parenthesize composed types so nesting preserves grouping and inherit the enclosing indentation. */
function emitComposition(members: readonly Schema[], operator: '|' | '&', context: EmissionContext): string {
  const { indentation } = context
  const separator = indentation === undefined ? ` ${operator} ` : `\n${indentation}${operator} `
  return members.map(member => `(${emit(member, context)})`).join(separator)
}

/** Own object-field optionality, index signatures and nested indentation for recursive emission. */
function emitObject(value: Exclude<Schema, boolean>, { definitions, indentation }: EmissionContext): string {
  const required = new Set((value.required ?? []) as string[])
  const properties = (value.properties ?? {}) as Record<string, Schema>
  const nestedContext = { definitions, indentation: indentation === undefined ? undefined : `${indentation}    ` }
  const fields = Object.entries(properties).map(([key, prop]) => {
    const optional = required.has(key) ? '' : '?'
    return `${JSON.stringify(key)}${optional}: ${emit(prop, nestedContext)}`
  })
  if (typeof value.additionalProperties === 'object') fields.push(`[key: string]: ${emit(value.additionalProperties as Schema, nestedContext)}`)
  if (indentation !== undefined) return `{\n${indentation}  ${fields.join(`;\n${indentation}  `)}\n${indentation}}`
  return `{ ${fields.join('; ')} }`
}

await generate({ version: 'v1', mode: process.argv.includes('--check') ? 'check' : 'write' })
