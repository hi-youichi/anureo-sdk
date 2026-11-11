import Ajv, { type ValidateFunction } from 'ajv'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject } from '@anureo/protocol'

export interface AgentOutputSchema<S extends z.ZodObject = z.ZodObject> {
  schema: JsonObject
  parse(text: string): Promise<z.output<S>>
}

class SchemaParameterError extends HarnessSdkError {
  constructor(rule: string) { super('INVALID_PARAMS', 'Unsupported agent output schema', false, false, { rule }) }
}

function invalid(rule: string): never {
  throw new SchemaParameterError(rule)
}

/** Zod's converter can hide input-side transforms in output mode. Check the original graph too. */
function checkZod(root: z.ZodObject): void {
  const seen = new WeakSet<object>()
  const rejected = new Set(['optional', 'record', 'tuple', 'pipe', 'transform', 'catch', 'prefault',
    'date', 'bigint', 'symbol', 'map', 'set', 'nan', 'undefined', 'void', 'custom', 'function', 'promise', 'file'])
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (value instanceof z.ZodType) {
      const def = value._zod.def
      if (rejected.has(def.type) || ('coerce' in def && def.coerce)) invalid('valueConversionOrNonportableType')
      if (def.checks?.some(check => check._zod.def.check === 'overwrite')) invalid('valueConversion')
      if (value instanceof z.ZodLazy) visit(value._zod.def.getter())
      // Refinement checks can themselves be ZodCustom instances; they validate, not convert.
      for (const [key, child] of Object.entries(def)) if (key !== 'checks') visit(child)
    } else {
      for (const child of Object.values(value)) visit(child)
    }
  }
  visit(root)
}

/** Walk schema locations, never examples/defaults/enum data that may contain schema-like keys. */
function checkJsonSchema(root: JsonObject): void {
  function visit(node: unknown): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    const schema = node as JsonObject
    if (schema.$async || (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#'))) invalid('externalOrAsyncSchema')
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      if (schema.additionalProperties !== false) invalid('openObject')
      const properties = schema.properties as JsonObject | undefined
      const required = new Set(Array.isArray(schema.required) ? schema.required : [])
      if (properties && Object.keys(properties).some(key => !required.has(key))) invalid('optionalProperty')
      const patterns = schema.patternProperties && typeof schema.patternProperties === 'object'
        ? Object.keys(schema.patternProperties).map(pattern => new RegExp(pattern, 'u')) : []
      if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string'
        && !Object.hasOwn(properties ?? {}, key) && !patterns.some(pattern => pattern.test(key)))) invalid('unsatisfiableRequired')
    }
    if (Array.isArray(schema.items) || schema.prefixItems) invalid('tuple')
    const type = schema.type
    const pairs: Array<[string, string]> = type === 'string' ? [['minLength', 'maxLength']] : type === 'array' ? [['minItems', 'maxItems']]
      : type === 'object' ? [['minProperties', 'maxProperties']] : []
    for (const [min, max] of pairs) {
      const lower = schema[min], upper = schema[max]
      if (typeof lower === 'number' && typeof upper === 'number' && lower > upper) invalid('unsatisfiableBounds')
    }
    if (type === 'number' || type === 'integer') {
      const lower = Math.max(typeof schema.minimum === 'number' ? schema.minimum : -Infinity, typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : -Infinity)
      const upper = Math.min(typeof schema.maximum === 'number' ? schema.maximum : Infinity, typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : Infinity)
      if (lower > upper || (lower === upper && (schema.exclusiveMinimum === lower || schema.exclusiveMaximum === upper))) invalid('unsatisfiableBounds')
    }
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
      const children = schema[key]
      if (children && typeof children === 'object' && !Array.isArray(children)) Object.values(children).forEach(visit)
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const children = schema[key]
      if (Array.isArray(children)) children.forEach(visit)
    }
    for (const key of ['items', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) visit(schema[key])
  }
  visit(root)
}

export function prepareOutputSchema<S extends z.ZodObject>(source: S): AgentOutputSchema<S> {
  if (!(source instanceof z.ZodObject)) invalid('objectRootRequired')
  let schema: JsonObject
  let validate: ValidateFunction
  try {
    checkZod(source)
    schema = structuredClone(z.toJSONSchema(source, { target: 'draft-7', io: 'output', unrepresentable: 'throw' })) as JsonObject
    delete schema.$schema
    if (schema.type !== 'object') invalid('objectRootRequired')
    checkJsonSchema(schema)
    validate = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6, logger: false }).compile(schema)
  } catch (cause) {
    if (cause instanceof SchemaParameterError) throw cause
    invalid('invalidOrUnrepresentableSchema')
  }
  return {
    schema,
    async parse(text) {
      if (!text.trim()) throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_MISSING')
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_NOT_JSON') }
      if (!value || typeof value !== 'object' || Array.isArray(value) || !validate(value)) {
        throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_INVALID', 'Agent output does not match its schema', false, false,
          { issues: validate.errors?.map(error => ({ path: error.instancePath, code: error.keyword })) ?? [] })
      }
      // User refinements may throw independently of an ordinary validation mismatch.
      let parsed: z.ZodSafeParseResult<z.output<S>>
      try { parsed = await source.safeParseAsync(value) } catch {
        throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_VALIDATION_FAILED')
      }
      if (!parsed.success) throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_INVALID', 'Agent output does not match its schema', false, false,
        { issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) })
      return parsed.data
    },
  }
}
