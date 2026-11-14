// Produces the public copies of protocol events, interactions and JSON values.
import type { AhpEvent, InteractionRequested, JsonObject, JsonSchema, JsonValue } from './generated/types'

/**
 * Copy an event for public history with the same redactions as {@link publicValue}. Validate the
 * copy separately if it will be used as a protocol event.
 */
export function publicEvent<T extends AhpEvent>(event: T): T {
  if (event.type !== 'interaction/requested') return project(event) as T
  const { payload, ...envelope } = event
  return { ...project(envelope) as typeof envelope, payload: publicInteraction(payload) } as T
}
/**
 * Copy a request for public display with {@link publicValue}'s redactions. The private payload is
 * mapped to an availability marker. Schema annotations are projected without changing validation
 * rules. Session.requestInteraction emits the copy after the interaction registry stores the original.
 */
export function publicInteraction<T extends InteractionRequested>(request: T): T {
  if (!('schema' in request)) return project(request) as T
  const { schema, ...rest } = request
  const output = project(rest) as typeof rest
  return { ...output, schema: schema === undefined ? undefined : projectSchema(schema) } as T
}
/**
 * Copy acyclic JSON without modifying the input. Map `privatePayload` entries to
 * `privatePayloadAvailable: true` in property order. Redact recognized sensitive keys and content
 * fields whose containing object has `secret: true`. The boolean marker survives. Strip queries
 * and fragments from URLs with a lowercase `http://` or `https://` prefix. Redaction can replace
 * structured fields with strings. Callers still own removal of secrets embedded in arbitrary text.
 */
export function publicValue(value: JsonValue): JsonValue { return project(value) as JsonValue }
const sensitiveKey = /^(?:password|secret|token|accessToken|refreshToken|apiKey|api_key|authorization|credentials?|headers|env)$/i
const secretContentKey = /^(?:value|answer|content|text|default)$/i
const schemaMaps = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']
const schemaChildren = ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items', 'contains',
  'additionalItems', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema']
const schemaArrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems']

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Detach validation data intact, then redact annotations at schema locations. */
function projectSchema(schema: JsonSchema): JsonSchema {
  if (typeof schema === 'boolean') return schema
  const output = JSON.parse(JSON.stringify(schema)) as JsonObject
  redactSchemaAnnotations(output)
  return output
}

function redactSchemaAnnotations(schema: JsonValue | undefined, secret = false): void {
  if (!isJsonObject(schema)) return
  const privateExamples = secret || schema.secret === true || schema.writeOnly === true
  if (Object.hasOwn(schema, 'privatePayload')) {
    delete schema.privatePayload
    schema.privatePayloadAvailable = true
  }
  for (const key of Object.keys(schema)) {
    if (sensitiveKey.test(key) && !(key === 'secret' && typeof schema.secret === 'boolean')) schema[key] = '[redacted]'
  }
  for (const key of ['title', 'description', '$comment']) {
    if (schema[key] !== undefined) schema[key] = publicValue(schema[key])
  }
  if (schema.default !== undefined) schema.default = privateExamples ? '[redacted]' : publicValue(schema.default)
  if (Array.isArray(schema.examples)) {
    schema.examples = schema.examples.map(example => privateExamples ? '[redacted]' : publicValue(example))
  }
  for (const key of schemaMaps) {
    const map = schema[key]
    if (isJsonObject(map)) {
      for (const [name, child] of Object.entries(map)) redactSchemaAnnotations(child, privateExamples || sensitiveKey.test(name))
    }
  }
  for (const key of schemaChildren) redactSchemaAnnotations(schema[key], privateExamples)
  for (const key of schemaArrays) {
    const children = schema[key]
    if (Array.isArray(children)) {
      for (const child of children) redactSchemaAnnotations(child, privateExamples)
    }
  }
}

/** Strip query strings and fragments from URL matches while keeping surrounding text and URL paths. */
function stripUrlParameters(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/g, url => {
    const end = url.search(/[?#]/)
    return end === -1 ? url : url.slice(0, end)
  })
}
/** Rebuild JSON recursively, applying privacy rules before descending into potentially private fields. */
function project(value: unknown): unknown {
  if (typeof value === 'string') return stripUrlParameters(value)
  if (Array.isArray(value)) return value.map(entry => project(entry))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'privatePayload') {
      output.privatePayloadAvailable = true
    } else if (key === 'secret' && typeof child === 'boolean') {
      output[key] = child
    } else if (sensitiveKey.test(key) || (record.secret === true && secretContentKey.test(key))) {
      output[key] = '[redacted]'
    } else {
      output[key] = project(child)
    }
  }
  return output
}
