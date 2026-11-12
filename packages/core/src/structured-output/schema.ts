import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { JsonSchema } from '@anureo/protocol'
import { HarnessSdkError } from '../errors'

export function compileOutputSchema(source: JsonSchema) {
  const schema = structuredClone(source)
  try {
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
        if (Array.isArray(child)) child.forEach(value => visit(value, depth + 1))
        else visit(child, depth + 1)
      }
    }
    visit(schema)
    const dialect = typeof schema === 'object' ? schema.$schema : undefined
    if (dialect !== undefined && dialect !== 'http://json-schema.org/draft-07/schema#' && dialect !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('dialect')
    const engine = dialect === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020 : Ajv
    const ajv = new engine({ allErrors: true, strict: false, validateFormats: false, multipleOfPrecision: 6, logger: false })
    const validate = ajv.compile(schema)
    const check = (value: unknown): void => {
      if (!validate(value)) throw new HarnessSdkError('STRUCTURED_OUTPUT_INVALID', 'Output does not match its schema', false, false,
        { issues: validate.errors?.slice(0, 16).map(error => ({ path: error.instancePath, code: error.keyword })) ?? [] })
    }
    return {
      schema,
      check,
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
