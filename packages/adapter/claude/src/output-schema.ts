import Ajv, { type ValidateFunction } from 'ajv'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject, JsonSchema } from '@anureo/protocol'

/** Internal pair retained by ClaudeBackendSession for the active query format. */
export interface OutputSchema {
  /** Detached schema used for format comparison and native query setup. Treat it as read-only. */
  schema: JsonObject
  /** Synchronous draft-07 validator used to decide whether terminal output can be published as JSON. */
  validate: ValidateFunction
}

/**
 * Compile a detached, self-contained draft-07 schema with an explicit object root. The validator
 * skips format assertions. Invalid, asynchronous or uncloneable schemas throw INVALID_PARAMS
 * synchronously with a message that omits schema contents.
 * ClaudeBackendSession.submitInput compiles a changed schema before replacing the query or
 * dispatching input. completeTurn uses the retained validator before publishing final JSON text.
 */
export function compileOutputSchema(schema: JsonSchema): OutputSchema {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object' || schema.$async) {
    throw new HarnessSdkError('INVALID_PARAMS', 'Claude outputSchema must declare an object root and cannot be asynchronous')
  }
  try {
    const copy = structuredClone(schema)
    const ajv = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6, logger: false })
    return { schema: copy, validate: ajv.compile(copy) }
  } catch {
    // Schema descriptions, enum values and reference URLs may contain private data.
    throw new HarnessSdkError('INVALID_PARAMS', 'Claude outputSchema must be a valid, self-contained draft-07 JSON Schema')
  }
}
