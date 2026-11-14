import Ajv, { type ValidateFunction } from 'ajv'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject, JsonSchema } from '@anureo/protocol'

/** Internal pair retained by ClaudeBackendSession for native setup and terminal validation. */
export interface OutputSchema {
  /** Detached schema supplied to the native query; keep it consistent with validate. */
  schema: JsonObject
  /** Synchronous draft-07 validator; a false result prevents final JSON publication. */
  validate: ValidateFunction
}

/** Compile a detached, self-contained draft-07 object schema for Claude tool output.
 * ClaudeBackendSession.submitInput calls this before replacing a query or dispatching input;
 * invalid, asynchronous or uncloneable schemas throw INVALID_PARAMS without exposing schema data.
 * completeTurn uses the synchronous validator before publishing structured output as final text.
 * Format assertions are disabled, independently of AHP's validator. */
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
