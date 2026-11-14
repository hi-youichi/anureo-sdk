// Owns synchronous local schema compilation and value checks.
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { JsonSchema } from '@anureo/protocol'
import { HarnessSdkError } from '../errors'

/**
 * Prepare a detached schema and synchronous candidate checks without network I/O or source mutation.
 * This package-internal compiler defaults to draft-07, supports explicit 2020-12 and ignores
 * formats during value checks. Unsupported or invalid definitions throw INVALID_PARAMS. Cloning
 * failures propagate directly. OutputSession.prepareOutput compiles before retaining submission state
 * or dispatching input. The returned checks require no disposal.
 */
export function compileOutputSchema(source: JsonSchema) {
  const schema = structuredClone(source)
  const validate = compileValidator(schema)
  /**
   * Check a value without coercion or default insertion. Throw STRUCTURED_OUTPUT_INVALID with at
   * most sixteen path/keyword issues on mismatch. OutputSession.submitCandidate converts failures
   * into retry decisions. OutputSession.publishOutput converts them into failed terminals before serialization.
   */
  const check = (value: unknown): void => {
    if (validate(value)) return
    const issues = validate.errors?.slice(0, 16).map(error => ({ path: error.instancePath, code: error.keyword })) ?? []
    throw new HarnessSdkError('STRUCTURED_OUTPUT_INVALID', 'Output does not match its schema', false, false, { issues })
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
 * Compile an already cloned schema for compileOutputSchema. Normalize definition and compilation
 * failures to INVALID_PARAMS, leaving an existing HarnessSdkError intact.
 */
function compileValidator(schema: JsonSchema) {
  try {
    validateSchemaNode(schema, 0)
    const engine = schemaEngine(schema)
    const ajv = new engine({ allErrors: true, strict: false, validateFormats: false, multipleOfPrecision: 6, logger: false })
    return ajv.compile(schema)
  } catch (cause) {
    if (cause instanceof HarnessSdkError) throw cause
    throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported or invalid output schema')
  }
}

/**
 * Choose the Ajv implementation for the root dialect after traversal. An absent dialect uses
 * draft-07, including for boolean schemas. compileValidator normalizes unsupported dialect errors.
 */
function schemaEngine(schema: JsonSchema): typeof Ajv | typeof Ajv2020 {
  const dialect = typeof schema === 'object' ? schema.$schema : undefined
  switch (dialect) {
    case undefined:
    case 'http://json-schema.org/draft-07/schema#':
      return Ajv
    case 'https://json-schema.org/draft/2020-12/schema':
      return Ajv2020
    default:
      throw new Error('dialect')
  }
}

/**
 * Reject non-fragment references and async schemas at visited nodes, and traversal beyond 128
 * levels, for compileValidator. Follow the supported child keywords so example/default instance data
 * stays opaque. Check depth even for absent or scalar children to preserve the traversal bound.
 */
function validateSchemaNode(node: unknown, depth: number): void {
  if (depth > 128) throw new Error('depth')
  if (!node || typeof node !== 'object') return
  const value = node as Record<string, unknown>
  assertLocalReference(value.$ref)
  assertLocalReference(value.$dynamicRef)
  if (value.$async) throw new Error('async schema')
  const visitChild = (child: unknown) => validateSchemaNode(child, depth + 1)
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
    const children = value[key]
    if (children && typeof children === 'object') Object.values(children).forEach(visitChild)
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const children = value[key]
    if (Array.isArray(children)) children.forEach(visitChild)
  }
  for (const key of ['items', 'contains', 'additionalProperties', 'additionalItems', 'propertyNames', 'not', 'if', 'then', 'else']) {
    const child = value[key]
    if (Array.isArray(child)) child.forEach(visitChild)
    else visitChild(child)
  }
}

/** Restrict string references to local fragments during traversal. Ajv checks malformed keyword values. */
function assertLocalReference(reference: unknown): void {
  if (typeof reference === 'string' && !reference.startsWith('#')) throw new Error('external reference')
}
