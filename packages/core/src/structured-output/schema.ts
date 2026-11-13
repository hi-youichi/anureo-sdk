// Compiles local synchronous output schemas; must not fetch references or publish execution results.
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { JsonSchema } from '@anureo/protocol'
import { HarnessSdkError } from '../errors'

/** Reject unsupported references, async schemas, excessive nesting and unknown dialects before Ajv compilation; ignore schema-like instance annotations. */
function validateSchemaDefinition(schema: JsonSchema): void {
  /** Walk only schema-bearing keywords; examples and defaults are instance data and may legitimately resemble schemas. */
  const visit = (node: unknown, depth = 0): void => {
    if (depth > 128) throw new Error('depth')
    if (!node || typeof node !== 'object') return
    const value = node as Record<string, unknown>
    for (const key of ['$ref', '$dynamicRef']) if (typeof value[key] === 'string' && !value[key].startsWith('#')) throw new Error('external reference')
    if (value.$async) throw new Error('async schema')
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
      const children = value[key]
      if (children && typeof children === 'object') Object.values(children).forEach(child => visit(child, depth + 1))
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(value[key])) value[key].forEach(child => visit(child, depth + 1))
    for (const key of ['items', 'contains', 'additionalProperties', 'additionalItems', 'propertyNames', 'not', 'if', 'then', 'else']) {
      const child = value[key]
      if (Array.isArray(child)) child.forEach(item => visit(item, depth + 1))
      else visit(child, depth + 1)
    }
  }
  visit(schema)
  const dialect = typeof schema === 'object' ? schema.$schema : undefined
  if (dialect !== undefined && dialect !== 'http://json-schema.org/draft-07/schema#' && dialect !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('dialect')
}

/** Clone and compile a local synchronous draft-07/2020-12 schema for the output adapter; reject unsupported schemas with INVALID_PARAMS. No references are fetched and caller schemas are not mutated. */
export function compileOutputSchema(source: JsonSchema) {
  const schema = structuredClone(source)
  try {
    validateSchemaDefinition(schema)
    const dialect = typeof schema === 'object' ? schema.$schema : undefined
    const engine = dialect === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020 : Ajv
    const ajv = new engine({ allErrors: true, strict: false, validateFormats: false, multipleOfPrecision: 6, logger: false })
    const validate = ajv.compile(schema)
    /** Validate an uncoerced candidate or throw STRUCTURED_OUTPUT_INVALID with bounded path/keyword issues; retain no raw candidate values in diagnostics. */
    const check = (value: unknown): void => {
      if (!validate(value)) throw new HarnessSdkError('STRUCTURED_OUTPUT_INVALID', 'Output does not match its schema', false, false,
        { issues: validate.errors?.slice(0, 16).map(error => ({ path: error.instancePath, code: error.keyword })) ?? [] })
    }
    return {
      schema,
      check,
      /** Parse nonempty JSON and check the compiled schema; throw structured-output missing, not-JSON or invalid errors without changing the input/schema. */
      parse(text: string): unknown {
        if (!text.trim()) throw new HarnessSdkError('STRUCTURED_OUTPUT_MISSING')
        let value: unknown
        try { value = JSON.parse(text) } catch { throw new HarnessSdkError('STRUCTURED_OUTPUT_NOT_JSON') }
        check(value)
        return value
      },
    }
  } catch (cause) {
    if (cause instanceof HarnessSdkError) throw cause
    throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported or invalid output schema')
  }
}
