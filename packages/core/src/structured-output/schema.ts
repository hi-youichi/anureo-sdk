// Owns synchronous local schema compilation and value checks.
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { JsonSchema } from '@anureo/protocol'
import { HarnessSdkError } from '../errors'

/**
 * Prepare a detached schema and synchronous candidate checks without network I/O or source mutation.
 * This package-internal compiler defaults to draft-07 and supports explicit 2020-12; formats are not
 * validated. Unsupported or invalid definitions throw INVALID_PARAMS; cloning failures propagate
 * directly. OutputSession.prepareOutput compiles before retaining submission state or dispatching
 * input, then retains the returned operations until submission cleanup. No disposal is required.
 */
export function compileOutputSchema(source: JsonSchema) {
  const schema = structuredClone(source)
  const validate = compileValidator(schema)
  /**
   * Admit a value without coercion or default insertion; throw STRUCTURED_OUTPUT_INVALID with at
   * most sixteen path/keyword issues on mismatch. OutputSession.submitCandidate converts failures
   * into retry decisions; publishOutput converts them into failed terminals before serialization.
   */
  const check = (value: unknown): void => {
    if (!validate(value)) throw new HarnessSdkError('STRUCTURED_OUTPUT_INVALID', 'Output does not match its schema', false, false,
      { issues: validate.errors?.slice(0, 16).map(error => ({ path: error.instancePath, code: error.keyword })) ?? [] })
  }
  return {
    schema,
    check,
    /**
     * Decode and check JSON, throwing STRUCTURED_OUTPUT_MISSING for blank text,
     * STRUCTURED_OUTPUT_NOT_JSON for malformed JSON or check's invalid-value error for a mismatch.
     * OutputSession.outputValue parses native finals; publishOutput rechecks projected JSON so
     * privacy redaction cannot bypass schema constraints. publishOutput turns parse failures into a
     * failed terminal, using STRUCTURED_OUTPUT_REDACTED when the projected JSON fails revalidation.
     */
    parse(text: string): unknown {
      if (!text.trim()) throw new HarnessSdkError('STRUCTURED_OUTPUT_MISSING')
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new HarnessSdkError('STRUCTURED_OUTPUT_NOT_JSON') }
      check(value)
      return value
    },
  }
}

/**
 * Compile an already cloned schema for compileOutputSchema, normalizing definition/compilation
 * failures to INVALID_PARAMS without wrapping later candidate failures in the same error boundary.
 */
function compileValidator(schema: JsonSchema) {
  try {
    validateSchemaDefinition(schema)
    const dialect = typeof schema === 'object' ? schema.$schema : undefined
    const engine = dialect === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020 : Ajv
    const ajv = new engine({ allErrors: true, strict: false, validateFormats: false, multipleOfPrecision: 6, logger: false })
    return ajv.compile(schema)
  } catch (cause) {
    if (cause instanceof HarnessSdkError) throw cause
    throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported or invalid output schema')
  }
}

/**
 * compileValidator invokes this before choosing Ajv and converts its failures to INVALID_PARAMS.
 * Reject external references, async schemas, excessive nesting and unsupported root dialects without
 * changing the schema. Instance annotations are skipped because their contents need not be schemas.
 */
function validateSchemaDefinition(schema: JsonSchema): void {
  validateSchemaNode(schema, 0)
  const dialect = typeof schema === 'object' ? schema.$schema : undefined
  if (dialect !== undefined && dialect !== 'http://json-schema.org/draft-07/schema#' && dialect !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('dialect')
}

/**
 * Reject external references, async schemas and traversal beyond 128 levels for
 * validateSchemaDefinition. Follow only schema-bearing keywords so example/default instance data
 * stays opaque. Check depth even for absent or scalar children to preserve the traversal bound.
 */
function validateSchemaNode(node: unknown, depth: number): void {
  if (depth > 128) throw new Error('depth')
  if (!node || typeof node !== 'object') return
  const value = node as Record<string, unknown>
  for (const key of ['$ref', '$dynamicRef']) {
    if (typeof value[key] === 'string' && !value[key].startsWith('#')) throw new Error('external reference')
  }
  if (value.$async) throw new Error('async schema')
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
    const children = value[key]
    if (children && typeof children === 'object') Object.values(children).forEach(child => validateSchemaNode(child, depth + 1))
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const children = value[key]
    if (Array.isArray(children)) children.forEach(child => validateSchemaNode(child, depth + 1))
  }
  for (const key of ['items', 'contains', 'additionalProperties', 'additionalItems', 'propertyNames', 'not', 'if', 'then', 'else']) {
    const child = value[key]
    if (Array.isArray(child)) child.forEach(item => validateSchemaNode(item, depth + 1))
    else validateSchemaNode(child, depth + 1)
  }
}
