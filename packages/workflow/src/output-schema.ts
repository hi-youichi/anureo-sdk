import Ajv, { type ValidateFunction } from 'ajv'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject } from '@anureo/protocol'

/** Internal schema/validator pair for agent execution and journal replay; not re-exported by the package. */
export interface AgentOutputSchema<S extends z.ZodObject = z.ZodObject> {
  /** Closed draft-07 object schema sent to session.submit and included in the journal cache key. */
  schema: JsonObject
  /**
   * Validate raw terminal or cached JSON before Zod can strip fields or supply defaults, then await
   * local refinements. Reject missing/non-JSON/invalid output with distinct AGENT_STRUCTURED_OUTPUT
   * codes; a thrown refinement becomes VALIDATION_FAILED without exposing its exception.
   */
  parse(text: string): Promise<z.output<S>>
}

/**
 * Prepare portable structured output for executeAgent and memoizedAgent before session acquisition
 * or cache lookup. Require a Zod object with closed objects, required JSON fields and no conversions;
 * unsupported/unrepresentable schemas synchronously throw INVALID_PARAMS with a safe rule code.
 * The returned parser validates new terminal text and revalidates typed journal hits, including async
 * refinements. No session is acquired here; callers still own execution and cleanup.
 */
export function prepareOutputSchema<S extends z.ZodObject>(source: S): AgentOutputSchema<S> {
  const { schema, validate } = compileSchema(source)
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

/** Distinguish our safe preflight rule failures from exceptions thrown by user schema callbacks. */
class SchemaParameterError extends HarnessSdkError {
  constructor(rule: string) { super('INVALID_PARAMS', 'Unsupported agent output schema', false, false, { rule }) }
}

function invalid(rule: string): never {
  throw new SchemaParameterError(rule)
}

/** Convert and compile without coercion/default insertion; sanitize converter, lazy callback and Ajv failures. */
function compileSchema(source: z.ZodObject): { schema: JsonObject; validate: ValidateFunction } {
  if (!(source instanceof z.ZodObject)) invalid('objectRootRequired')
  try {
    checkZod(source)
    const schema = structuredClone(z.toJSONSchema(source, { target: 'draft-7', io: 'output', unrepresentable: 'throw' })) as JsonObject
    delete schema.$schema
    if (schema.type !== 'object') invalid('objectRootRequired')
    checkJsonSchema(schema)
    const validate = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6, logger: false }).compile(schema)
    return { schema, validate }
  } catch (cause) {
    if (cause instanceof SchemaParameterError) throw cause
    invalid('invalidOrUnrepresentableSchema')
  }
}

/** Zod's converter can hide input-side transforms in output mode. Reject them in the original graph too. */
function checkZod(root: z.ZodObject): void {
  const seen = new WeakSet<object>()
  const rejected = new Set(['optional', 'record', 'tuple', 'pipe', 'transform', 'catch', 'prefault',
    'date', 'bigint', 'symbol', 'map', 'set', 'nan', 'undefined', 'void', 'custom', 'function', 'promise', 'file'])
  /** Follow lazy schemas and definition fields once per object, without treating refinement checks as conversions. */
  function visitZodNode(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (value instanceof z.ZodType) {
      const def = value._zod.def
      if (rejected.has(def.type) || ('coerce' in def && def.coerce)) invalid('valueConversionOrNonportableType')
      if (def.checks?.some(check => check._zod.def.check === 'overwrite')) invalid('valueConversion')
      if (value instanceof z.ZodLazy) visitZodNode(value._zod.def.getter())
      // Refinement checks can themselves be ZodCustom instances; they validate, not convert.
      for (const [key, child] of Object.entries(def)) if (key !== 'checks') visitZodNode(child)
    } else {
      for (const child of Object.values(value)) visitZodNode(child)
    }
  }
  visitZodNode(root)
}

/** Walk schema locations, never examples/defaults/enum data that may contain schema-like keys. */
function checkJsonSchema(root: JsonObject): void {
  /** Apply portability rules only to schema nodes; business data can legitimately contain the same keys. */
  function visitJsonSchemaNode(node: unknown): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    const schema = node as JsonObject
    if (schema.$async || (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#'))) invalid('externalOrAsyncSchema')
    checkObjectProperties(schema)
    if (Array.isArray(schema.items) || schema.prefixItems) invalid('tuple')
    checkSchemaBounds(schema)
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
      const children = schema[key]
      if (children && typeof children === 'object' && !Array.isArray(children)) Object.values(children).forEach(visitJsonSchemaNode)
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const children = schema[key]
      if (Array.isArray(children)) children.forEach(visitJsonSchemaNode)
    }
    for (const key of ['items', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) visitJsonSchemaNode(schema[key])
  }
  visitJsonSchemaNode(root)
}

/** Reject open/optional objects and required keys that a closed object cannot admit, including pattern keys. */
function checkObjectProperties(schema: JsonObject): void {
  if (schema.type !== 'object' && !(Array.isArray(schema.type) && schema.type.includes('object'))) return
  if (schema.additionalProperties !== false) invalid('openObject')
  const properties = schema.properties as JsonObject | undefined
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  if (properties && Object.keys(properties).some(key => !required.has(key))) invalid('optionalProperty')
  const patterns = schema.patternProperties && typeof schema.patternProperties === 'object'
    ? Object.keys(schema.patternProperties).map(pattern => new RegExp(pattern, 'u')) : []
  if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string'
    && !Object.hasOwn(properties ?? {}, key) && !patterns.some(pattern => pattern.test(key)))) invalid('unsatisfiableRequired')
}

/** Reject definite bound contradictions only for the declared type; unrelated keywords do not constrain it. */
function checkSchemaBounds(schema: JsonObject): void {
  const type = schema.type
  const pairs: Array<[string, string]> = type === 'string' ? [['minLength', 'maxLength']] : type === 'array' ? [['minItems', 'maxItems']]
    : type === 'object' ? [['minProperties', 'maxProperties']] : []
  for (const [min, max] of pairs) {
    const lower = schema[min], upper = schema[max]
    if (typeof lower === 'number' && typeof upper === 'number' && lower > upper) invalid('unsatisfiableBounds')
  }
  if (type === 'number' || type === 'integer') {
    const minimum = typeof schema.minimum === 'number' ? schema.minimum : -Infinity
    const exclusiveMinimum = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : -Infinity
    const lower = Math.max(minimum, exclusiveMinimum)
    const maximum = typeof schema.maximum === 'number' ? schema.maximum : Infinity
    const exclusiveMaximum = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : Infinity
    const upper = Math.min(maximum, exclusiveMaximum)
    const boundsCrossed = lower > upper
    const equalBoundsExcludeValue = lower === upper
      && (schema.exclusiveMinimum === lower || schema.exclusiveMaximum === upper)
    if (boundsCrossed || equalBoundsExcludeValue) invalid('unsatisfiableBounds')
  }
}
