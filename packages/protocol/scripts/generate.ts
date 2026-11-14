/** Deterministic type generation and drift checking for the AHP schema vocabulary. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

type Schema = boolean | SchemaObject
type SchemaObject = {
  [key: string]: unknown
  $ref?: string
  properties?: Record<string, Schema>
  oneOf?: Schema[]
  anyOf?: Schema[]
}
type MethodTable = Record<string, [params: string, result: string]>
type ProtocolSchema = {
  $defs: Record<string, Schema>
  'x-methods': MethodTable
  'x-extension-methods'?: MethodTable
}
type GenerationOptions = { version: 'v1'; mode: 'check' | 'write' }
type EmissionContext = {
  definitions: Record<string, Schema>
  definitionName: string
  /** Omission keeps types inline; a string enables multiline union/object formatting. */
  indentation?: string
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const definitionRef = /^#\/\$defs\/(\w+)$/

/** Read and render before touching the target; IO, JSON and unsupported-schema failures reject the CLI run. */
async function generate({ version, mode }: GenerationOptions): Promise<void> {
  const document = await readProtocolSchema(version)
  assertRpcMethodCoverage(document)
  const output = renderTypes(document, version)
  await saveTypes(output, mode)
}

/** Load the package-relative schema without depending on the invoking shell's working directory. */
async function readProtocolSchema(version: 'v1'): Promise<ProtocolSchema> {
  const source = await readFile(path.join(root, `schema/${version}/ahp.schema.json`), 'utf8')
  return JSON.parse(source) as ProtocolSchema
}

function schemaObject(value: Schema | undefined): SchemaObject | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

/** Check wire request dispatch and the allowed shapes of methodless success frames. */
function assertRpcMethodCoverage(document: ProtocolSchema): void {
  const definitions = document.$defs
  const requestBranches = schemaObject(definitions.AhpRpcRequest)?.oneOf
  const result = schemaObject(definitions.AhpRpcSuccess)?.properties?.result
  const resultBranches = schemaObject(result)?.anyOf
  if (!Array.isArray(requestBranches) || !Array.isArray(resultBranches)) {
    throw new Error('Expected AhpRpcRequest.oneOf and AhpRpcSuccess.properties.result.anyOf')
  }

  const wireRequests = new Map<string, string>()
  for (const branch of requestBranches) {
    const ref = schemaObject(branch)?.$ref
    const name = definitionRef.exec(ref ?? '')?.[1]
    const wrapper = name === undefined ? undefined : schemaObject(definitions[name])
    const method = schemaObject(wrapper?.properties?.method)?.const
    const params = schemaObject(wrapper?.properties?.params)?.$ref
    if (typeof method !== 'string' || typeof params !== 'string') {
      throw new Error(`Invalid request wrapper in AhpRpcRequest.oneOf: ${ref ?? '(missing reference)'}`)
    }
    if (wireRequests.has(method)) throw new Error(`Duplicate RPC request wrapper for ${method}`)
    wireRequests.set(method, params)
  }

  const wireResults = new Set(resultBranches.map(branch => {
    const ref = schemaObject(branch)?.$ref
    if (typeof ref !== 'string') throw new Error('Expected a result reference in AhpRpcSuccess.properties.result.anyOf')
    return ref
  }))
  const expectedResults = new Set<string>()
  const methods = [...Object.entries(document['x-methods']), ...Object.entries(document['x-extension-methods'] ?? {})]
  for (const [method, [params, result]] of methods) {
    if (wireRequests.get(method) !== `#/$defs/${params}`) {
      throw new Error(`${method}: expected ${params} in the AhpRpcRequest wrapper`)
    }
    wireRequests.delete(method)
    const resultRef = `#/$defs/${result}`
    if (!wireResults.has(resultRef)) {
      throw new Error(`${method}: add ${result} to AhpRpcSuccess.properties.result.anyOf`)
    }
    expectedResults.add(resultRef)
  }
  if (wireRequests.size) {
    throw new Error(`AhpRpcRequest contains methods missing from the method tables: ${[...wireRequests.keys()].join(', ')}`)
  }
  const extraResults = [...wireResults].filter(ref => !expectedResults.has(ref))
  if (extraResults.length) {
    throw new Error(`AhpRpcSuccess contains results missing from the method tables: ${extraResults.join(', ')}`)
  }
}

/** Render definitions and method maps in schema order, ending the generated source with a newline. */
function renderTypes(document: ProtocolSchema, version: 'v1'): string {
  const definitions = document.$defs
  const aliases = Object.entries(definitions).map(([name, schema]) => {
    const context = { definitions, definitionName: name }
    // Keep notification methods and the required item turnId intersections visible.
    if (name === 'AhpEventNotification') return `export type ${name} =\n  ${emit(schema, { ...context, indentation: '  ' })};`
    return `export type ${name} = ${emit(schema, context)};`
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
  const compositions = ['oneOf', 'anyOf', 'allOf'].filter(keyword => keyword in value)
  if (compositions.length > 1 || ['if', 'then', 'else', 'not'].some(keyword => keyword in value) ||
      (compositions.length > 0 && ['$ref', 'const', 'enum', 'type', 'properties', 'required', 'additionalProperties', 'items']
        .some(keyword => keyword in value))) {
    throw new Error(`Unsupported composition in $defs.${context.definitionName}`)
  }
  if (typeof value.$ref === 'string') {
    const name = definitionRef.exec(value.$ref)?.[1]
    if (name === undefined || !Object.hasOwn(context.definitions, name)) throw new Error(`Unsupported reference ${value.$ref}`)
    return name
  }
  if ('const' in value) return JSON.stringify(value.const)
  if (Array.isArray(value.enum)) return value.enum.map(entry => JSON.stringify(entry)).join(' | ')
  if (Array.isArray(value.oneOf)) return emitComposition(value.oneOf, '|', context)
  if (Array.isArray(value.anyOf)) return emitComposition(value.anyOf, '|', context)
  if (Array.isArray(value.allOf)) return emitComposition(value.allOf, '&', context)
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
function emitObject(value: SchemaObject, context: EmissionContext): string {
  const { indentation } = context
  const required = new Set((value.required ?? []) as string[])
  const properties = value.properties ?? {}
  const nestedContext = { ...context, indentation: indentation === undefined ? undefined : `${indentation}    ` }
  const fields = Object.entries(properties).map(([key, prop]) => {
    const optional = required.has(key) ? '' : '?'
    return `${JSON.stringify(key)}${optional}: ${emit(prop, nestedContext)}`
  })
  if (typeof value.additionalProperties === 'object') fields.push(`[key: string]: ${emit(value.additionalProperties as Schema, nestedContext)}`)
  if (indentation !== undefined) return `{\n${indentation}  ${fields.join(`;\n${indentation}  `)}\n${indentation}}`
  return `{ ${fields.join('; ')} }`
}

await generate({ version: 'v1', mode: process.argv.includes('--check') ? 'check' : 'write' })
