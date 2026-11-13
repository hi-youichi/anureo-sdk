// Owns synchronous local schema compilation and value checks. Reference fetching and result publication belong to other layers.
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { JsonSchema } from '@anureo/protocol'
import { HarnessSdkError } from '../errors'

/**
 * OutputSession.prepareOutput calls this before retaining submission state or dispatching input.
 * Return a detached schema plus synchronous check/parse operations for candidate admission and final
 * commitment. Compilation defaults to draft-07 and supports explicit 2020-12. Unsupported or invalid
 * definitions throw INVALID_PARAMS, while source-cloning failures propagate directly. The caller owns
 * the returned validator's lifetime and converts candidate/publication failures into its tool or
 * terminal outcomes. Compilation performs no network I/O and leaves source untouched.
 */
export function compileOutputSchema(source: JsonSchema) {
  const schema = structuredClone(source)
  try {
    validateSchemaDefinition(schema)
    const dialect = typeof schema === 'object' ? schema.$schema : undefined
    const engine = dialect === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020 : Ajv
    const ajv = new engine({ allErrors: true, strict: false, validateFormats: false, multipleOfPrecision: 6, logger: false })
    const validate = ajv.compile(schema)
    /**
     * OutputSession.submitCandidate uses this for provisional admission and publishOutput uses
     * it before serialization. parse also invokes it after JSON decoding. Return void on a match or
     * throw STRUCTURED_OUTPUT_INVALID with at most sixteen path/keyword issues. Values are neither
     * coerced nor filled with defaults, so accepted output preserves the producer's JSON.
     */
    const check = (value: unknown): void => {
      if (!validate(value)) throw new HarnessSdkError('STRUCTURED_OUTPUT_INVALID', 'Output does not match its schema', false, false,
        { issues: validate.errors?.slice(0, 16).map(error => ({ path: error.instancePath, code: error.keyword })) ?? [] })
    }
    return {
      schema,
      check,
      /**
       * OutputSession.outputValue parses native finals and publishOutput rechecks projected JSON
       * so privacy redaction cannot bypass schema constraints. Return the decoded value after check,
       * or throw STRUCTURED_OUTPUT_MISSING, STRUCTURED_OUTPUT_NOT_JSON or check's invalid-value error.
       * The caller retains responsibility for converting these failures into a failed terminal.
       */
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

/**
 * compileOutputSchema invokes this before choosing Ajv and converts its failures to INVALID_PARAMS.
 * Reject external references, async schemas, excessive nesting and unsupported root dialects without
 * changing the schema. Instance annotations are skipped because their contents need not be schemas.
 */
function validateSchemaDefinition(schema: JsonSchema): void {
  /**
   * validateSchemaDefinition walks the root with this callback. Recurse only through schema-bearing
   * keywords and throw on unsupported nodes or excessive depth. Object/array iteration supplies child
   * nodes with incremented depth, leaving example/default instance data untouched.
   */
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
