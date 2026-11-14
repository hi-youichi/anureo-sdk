import Ajv, { type ValidateFunction } from 'ajv'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject } from '@anureo/protocol'

/** Package-internal schema and parser for agent execution and journal replay. */
export interface AgentOutputSchema<S extends z.ZodObject = z.ZodObject> {
  /** Closed draft-07 object schema for submission, JSON-text fallback prompts and journal cache keys. */
  schema: JsonObject
  /**
   * Validate a complete JSON object before Zod can strip extra fields or fill omitted fields.
   * Resolve with the typed value after local Zod checks, including async refinements.
   * Blank text, malformed JSON and schema mismatches reject with AGENT_STRUCTURED_OUTPUT_MISSING,
   * AGENT_STRUCTURED_OUTPUT_NOT_JSON and AGENT_STRUCTURED_OUTPUT_INVALID, respectively. Exceptions
   * from Zod reject with AGENT_STRUCTURED_OUTPUT_VALIDATION_FAILED and omit the original cause.
   * observeAgentTurn awaits this parser for completed turns and retains failures for settlement
   * after session cleanup. memoizedAgent returns this promise for typed cache hits without opening
   * a session.
   */
  parse(text: string): Promise<z.output<S>>
}

/**
 * Compile a Zod object into a draft-07 schema and a parser for the same output type.
 * Require closed objects and required JSON fields. Reject conversion schemas. JSON-compatible
 * defaults may be declared, and raw validation still requires their fields. Unsupported or
 * unrepresentable schemas synchronously throw INVALID_PARAMS with a safe rule code.
 * executeAgent prepares the pair before acquiring its session and passes it to observeAgentTurn.
 * memoizedAgent prepares it before deriving the journal key and uses the parser on typed hits.
 */
export function prepareOutputSchema<S extends z.ZodObject>(source: S): AgentOutputSchema<S> {
  const { schema, validate } = compileSchema(source)
  return {
    schema,
    async parse(text) {
      const value = parseRawOutput(text, validate)
      let parsed: z.ZodSafeParseResult<z.output<S>>
      try {
        parsed = await source.safeParseAsync(value)
      } catch {
        throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_VALIDATION_FAILED')
      }
      if (!parsed.success) {
        throw outputMismatch(parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })))
      }
      return parsed.data
    },
  }
}

/**
 * Decode one JSON value and require a schema-valid object before parse runs any Zod checks.
 * Throw the missing, malformed or invalid output error synchronously and capture Ajv's
 * current diagnostics before the parser can yield.
 */
function parseRawOutput(text: string, validate: ValidateFunction): unknown {
  if (!text.trim()) throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_MISSING')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_NOT_JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validate(value)) {
    const issues = validate.errors?.map(error => ({ path: error.instancePath, code: error.keyword })) ?? []
    throw outputMismatch(issues)
  }
  return value
}

/** Use the same failure envelope for Ajv and Zod with only issue paths and codes. */
function outputMismatch(issues: Array<{ path: string | PropertyKey[]; code: string }>): HarnessSdkError {
  return new HarnessSdkError('AGENT_STRUCTURED_OUTPUT_INVALID', 'Agent output does not match its schema', false, false, { issues })
}

/** Let compileSchema preserve known preflight rule codes while sanitizing user callback exceptions. */
class SchemaParameterError extends HarnessSdkError {
  constructor(rule: string) { super('INVALID_PARAMS', 'Unsupported agent output schema', false, false, { rule }) }
}

function rejectSchema(rule: string): never {
  throw new SchemaParameterError(rule)
}

/**
 * Give prepareOutputSchema a detached draft-07 schema and a synchronous validator.
 * Check the Zod source before conversion, then check portability before compiling. Ajv leaves
 * fields as supplied and skips format assertions so Zod can run its own format checks.
 * Sanitize unexpected failures from conversion, schema callbacks and Ajv into INVALID_PARAMS.
 */
function compileSchema(source: z.ZodObject): { schema: JsonObject; validate: ValidateFunction } {
  if (!(source instanceof z.ZodObject)) rejectSchema('objectRootRequired')
  try {
    checkZodSource(source)
    const schema = structuredClone(z.toJSONSchema(source, { target: 'draft-7', io: 'output', unrepresentable: 'throw' })) as JsonObject
    delete schema.$schema
    if (schema.type !== 'object') rejectSchema('objectRootRequired')
    checkJsonSchema(schema)
    const validate = new Ajv({ allErrors: true, validateFormats: false, multipleOfPrecision: 6, logger: false }).compile(schema)
    return { schema, validate }
  } catch (cause) {
    if (cause instanceof SchemaParameterError) throw cause
    rejectSchema('invalidOrUnrepresentableSchema')
  }
}

/** Reject conversions and nonportable types in the source graph before Zod's output-mode converter can hide them. */
function checkZodSource(root: z.ZodObject): void {
  const seen = new WeakSet<object>()
  const nonportableTypes = new Set(['optional', 'record', 'tuple', 'pipe', 'transform', 'catch', 'prefault',
    'date', 'bigint', 'symbol', 'map', 'set', 'nan', 'undefined', 'void', 'custom', 'function', 'promise', 'file'])
  /** Follow definition fields and invoke lazy getters once per visited lazy node. Propagate getter failures to compileSchema. */
  function visitZodNode(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (!(value instanceof z.ZodType)) {
      for (const child of Object.values(value)) visitZodNode(child)
      return
    }

    const def = value._zod.def
    if (nonportableTypes.has(def.type) || ('coerce' in def && def.coerce)) {
      rejectSchema('valueConversionOrNonportableType')
    }
    if (def.checks?.some(check => check._zod.def.check === 'overwrite')) rejectSchema('valueConversion')
    if (value instanceof z.ZodLazy) visitZodNode(value._zod.def.getter())
    // Skip the checks list when walking child schemas because refinements can be ZodCustom instances.
    for (const [key, child] of Object.entries(def)) {
      if (key !== 'checks') visitZodNode(child)
    }
  }
  visitZodNode(root)
}

/**
 * Reject portability violations before Ajv compiles the generated schema. Follow only
 * subschema keywords because examples, defaults and enum values may contain schema-like keys.
 */
function checkJsonSchema(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const schema = node as JsonObject
  if (schema.$async || (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#'))) {
    rejectSchema('externalOrAsyncSchema')
  }
  checkObjectProperties(schema)
  if (Array.isArray(schema.items) || schema.prefixItems) rejectSchema('tuple')
  checkSchemaBounds(schema)

  for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
    const children = schema[key]
    if (children && typeof children === 'object' && !Array.isArray(children)) {
      Object.values(children).forEach(checkJsonSchema)
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[key]
    if (Array.isArray(children)) children.forEach(checkJsonSchema)
  }
  for (const key of ['items', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else']) {
    checkJsonSchema(schema[key])
  }
}

/** Reject open/optional objects and required keys that a closed object cannot admit, including pattern keys. */
function checkObjectProperties(schema: JsonObject): void {
  if (schema.type !== 'object' && !(Array.isArray(schema.type) && schema.type.includes('object'))) return
  if (schema.additionalProperties !== false) rejectSchema('openObject')
  const properties = schema.properties as JsonObject | undefined
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  if (properties && Object.keys(properties).some(key => !required.has(key))) rejectSchema('optionalProperty')
  const patterns = schema.patternProperties && typeof schema.patternProperties === 'object'
    ? Object.keys(schema.patternProperties).map(pattern => new RegExp(pattern, 'u')) : []
  if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string'
    && !Object.hasOwn(properties ?? {}, key) && !patterns.some(pattern => pattern.test(key)))) {
    rejectSchema('unsatisfiableRequired')
  }
}

/** Check bounds for the declared type because other types' keywords do not constrain the instance. */
function checkSchemaBounds(schema: JsonObject): void {
  switch (schema.type) {
    case 'string': return checkSizeBounds(schema.minLength, schema.maxLength)
    case 'array': return checkSizeBounds(schema.minItems, schema.maxItems)
    case 'object': return checkSizeBounds(schema.minProperties, schema.maxProperties)
    case 'number':
    case 'integer': return checkNumericBounds(schema)
  }
}

/** Reject contradictory sizes. Ajv checks the validity of the individual keyword values. */
function checkSizeBounds(lower: unknown, upper: unknown): void {
  if (typeof lower === 'number' && typeof upper === 'number' && lower > upper) {
    rejectSchema('unsatisfiableBounds')
  }
}

/** Reject crossed bounds or a shared endpoint excluded by either bound. */
function checkNumericBounds(schema: JsonObject): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema
  const lower = Math.max(
    typeof minimum === 'number' ? minimum : -Infinity,
    typeof exclusiveMinimum === 'number' ? exclusiveMinimum : -Infinity,
  )
  const upper = Math.min(
    typeof maximum === 'number' ? maximum : Infinity,
    typeof exclusiveMaximum === 'number' ? exclusiveMaximum : Infinity,
  )
  const equalBoundsExcludeValue = lower === upper && (exclusiveMinimum === lower || exclusiveMaximum === upper)
  if (lower > upper || equalBoundsExcludeValue) {
    rejectSchema('unsatisfiableBounds')
  }
}
