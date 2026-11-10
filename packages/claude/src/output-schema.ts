import Ajv, { type ValidateFunction } from 'ajv'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject, JsonSchema } from '@anureo/protocol'

export interface OutputSchema {
  schema: JsonObject
  validate: ValidateFunction
}

/** Claude's tool-input schemas use draft-07, independently of AHP's validator. */
export function compileOutputSchema(schema: JsonSchema): OutputSchema {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object' || schema.$async) {
    throw new HarnessSdkError('INVALID_PARAMS', 'Claude outputSchema must declare an object root and cannot be asynchronous')
  }
  try {
    const copy = structuredClone(schema)
    const ajv = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6 })
    return { schema: copy, validate: ajv.compile(copy) }
  } catch {
    // Schema descriptions, enum values and reference URLs may contain private data.
    throw new HarnessSdkError('INVALID_PARAMS', 'Claude outputSchema must be a valid, self-contained draft-07 JSON Schema')
  }
}
