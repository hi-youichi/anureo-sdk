/** Owns AHP runtime validation, compatibility checks and public JSON projections. */
import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import schema from '../schema/v1/ahp.schema.json'
import { AHP_METHOD_DEFINITIONS } from './generated/types'
import type {
  Capabilities, AhpEvent, AhpMethod, AhpRequestMap, AhpResultMap,
  InteractionRequested, InteractionResponse, JsonSchema, JsonValue, UserQuestion,
} from './generated/types'

export * from './generated/types'
/** Access the source schema for consumers implementing their own AHP validators. */
export { default as ahpSchema } from '../schema/v1/ahp.schema.json'
/** Protocol major version offered by default during negotiation. */
export const AHP_PROTOCOL_VERSION = 1 as const
/** Required handshake discriminator distinguishing the revised major-1 lifecycle contract. */
export const AHP_PROTOCOL_CONTRACT = 'native-lifecycle' as const

/** Schema failure metadata retained without Ajv's rejected data or keyword parameters. */
export type ValidationIssue = Pick<ErrorObject, 'instancePath' | 'keyword' | 'message'>
/** Report a definite, non-retryable parameter failure with limited schema diagnostics. */
export class ProtocolValidationError extends Error {
  readonly code = 'INVALID_PARAMS'
  readonly retryable = false
  readonly outcomeUnknown = false
  readonly issues: ValidationIssue[]
  /** Supply a non-sensitive message; only path, keyword and message are copied from issues. */
  constructor(message: string, issues: readonly ErrorObject[] = []) {
    super(message)
    this.name = 'ProtocolValidationError'
    // Never copy data/params into diagnostics: these can contain secret answers.
    this.issues = issues.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }))
  }
}
/**
 * Test a value against a named AHP $defs entry without modifying it. Unknown names throw
 * during schema compilation; the caller must choose a T matching that definition.
 * All schema checks in this entry point leave format annotations unenforced.
 */
export function validateDefinition<T = unknown>(name: string, value: unknown): value is T {
  return !!validator(name)(value)
}
/**
 * Assert a named AHP definition, throwing ProtocolValidationError on a mismatch.
 * Unknown names throw a schema compilation error; the caller must match T to the definition.
 */
export function assertDefinition<T = unknown>(name: string, value: unknown): asserts value is T {
  const check = validator(name)
  if (!check(value)) throw new ProtocolValidationError(`Invalid AHP ${name}`, check.errors ?? [])
}
/** Test request parameters for a known method without coercing values or applying defaults. */
export function validateRequest<M extends AhpMethod>(method: M, value: unknown): value is AhpRequestMap[M] {
  return !!validator(AHP_METHOD_DEFINITIONS[method][0])(value)
}
/**
 * Reject malformed parameters for a known method with ProtocolValidationError before dispatch.
 * guardRequest and AhpAdapter.initialize call this before native work; callers still
 * own binding, capability and lifecycle checks.
 */
export function assertRequest<M extends AhpMethod>(method: M, value: unknown): asserts value is AhpRequestMap[M] {
  assertDefinition<AhpRequestMap[M]>(AHP_METHOD_DEFINITIONS[method][0], value)
}
/** Test a result's schema for a known method; request/result identity matching remains with the caller. */
export function validateResult<M extends AhpMethod>(method: M, value: unknown): value is AhpResultMap[M] {
  return !!validator(AHP_METHOD_DEFINITIONS[method][1])(value)
}
/**
 * Assert a known method's result or throw ProtocolValidationError before the caller consumes it.
 * This checks shape, leaving request/result identity and lifecycle consistency to the caller.
 */
export function assertResult<M extends AhpMethod>(method: M, value: unknown): asserts value is AhpResultMap[M] {
  assertDefinition<AhpResultMap[M]>(AHP_METHOD_DEFINITIONS[method][1], value)
}
/** Test a complete source envelope, requiring an execution ID for item events; does not track sequence order. */
export function validateEvent(value: unknown): value is AhpEvent {
  return validateDefinition<AhpEvent>('AhpEvent', value) && (!value.type.startsWith('item/') || !!value.turnId)
}
/**
 * Assert an event envelope or throw ProtocolValidationError without issue details.
 * AhpAdapter.notification checks incoming envelopes and Session.publish checks outgoing events
 * before publication; those callers enforce stream ordering and lifecycle state separately.
 */
export function assertEvent(value: unknown): asserts value is AhpEvent {
  if (!validateEvent(value)) throw new ProtocolValidationError('Invalid AHP event')
}
/** Recognize method names in the generated request/result table, excluding extension methods. */
export function isAhpMethod(value: string): value is AhpMethod {
  return Object.hasOwn(AHP_METHOD_DEFINITIONS, value)
}

/**
 * Select the highest shared version; omitted local support offers only AHP_PROTOCOL_VERSION.
 * Throw a non-retryable ProtocolVersionError with code PROTOCOL_VERSION_UNSUPPORTED and
 * outcomeUnknown=false when none is shared. This does not check the handshake discriminator.
 */
export function negotiateVersion(versions: readonly number[], supported: readonly number[] = [AHP_PROTOCOL_VERSION]): number {
  const agreed = versions.filter(value => supported.includes(value)).sort((a, b) => b - a)[0]
  if (agreed === undefined) {
    const error = new Error('No mutually supported AHP protocol version') as Error & { code: string; retryable: boolean; outcomeUnknown: boolean }
    error.name = 'ProtocolVersionError'
    error.code = 'PROTOCOL_VERSION_UNSUPPORTED'
    error.retryable = false
    error.outcomeUnknown = false
    throw error
  }
  return agreed
}

/**
 * Look up a dot-separated own-property path in negotiated capabilities. Boolean leaves ignore
 * value and require true; list leaves require the supplied value, or a non-empty list when omitted.
 * Missing values and other leaf types are unsupported.
 */
export function supportsCapability(capabilities: Capabilities, path: string, value?: string): boolean {
  let current: unknown = capabilities
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return false
    current = (current as Record<string, unknown>)[part]
  }
  if (Array.isArray(current)) return value === undefined ? current.length > 0 : current.includes(value)
  return current === true
}
/** Match an advertised extension by exact name and, when supplied, exact version. */
export function supportsExtension(capabilities: Capabilities, name: string, version?: string): boolean {
  return !!capabilities.extensions?.some(extension => extension.name === name && (version === undefined || extension.version === version))
}

/**
 * Test a value against a caller-supplied draft 2020-12 schema without mutation or format checks.
 * Return false for both a mismatch and schema compilation/validation errors.
 */
export function validateJsonSchema(schemaValue: JsonSchema, value: unknown): boolean {
  try { return !!ajv.compile(schemaValue)(value) } catch { return false }
}
/**
 * Test an answer against an already-valid request: kinds and offered approval IDs must match,
 * user questions are required unless required=false, and non-empty option lists constrain answers.
 * Embedded schemas check user answers, accepted elicitation content, or the whole tool response.
 * Return false for invalid responses or failing embedded schemas; do not settle the interaction.
 */
export function validateInteractionResponse(request: InteractionRequested, response: unknown): response is InteractionResponse {
  if (!validateDefinition<InteractionResponse>('InteractionResponse', response) || request.kind !== response.kind) return false
  switch (response.kind) {
    case 'approval': return request.kind === 'approval' && request.options.some(option => option.id === response.optionId)
    case 'userInput': {
      if (request.kind !== 'userInput') return false
      if (request.schema !== undefined && !validateJsonSchema(request.schema, response.answers)) return false
      return request.questions.every(question => validatesQuestionAnswer(question, response.answers[question.id]))
    }
    case 'elicitation': return request.kind === 'elicitation' && (response.action !== 'accept' || request.schema === undefined || validateJsonSchema(request.schema, response.content))
    case 'dynamicTool': return request.kind === 'dynamicTool' && (request.schema === undefined || validateJsonSchema(request.schema, response))
  }
}
/**
 * Throw ProtocolValidationError for an answer that fails request-specific validation.
 * InteractionRegistry.respond calls this before secret registration, replay checks and native
 * delivery, so a mismatch rejects the response attempt without settling the pending interaction.
 */
export function assertInteractionResponse(request: InteractionRequested, response: unknown): asserts response is InteractionResponse {
  if (!validateInteractionResponse(request, response)) throw new ProtocolValidationError('Invalid interaction response')
}

/**
 * Copy an event for public history using the same redaction rules as publicValue, without
 * modifying the original. Projection does not validate the result's schema.
 */
export function publicEvent<T extends AhpEvent>(event: T): T { return project(event) as T }
/**
 * Copy a request with publicValue's redactions, replacing privatePayload with an availability marker.
 * Session.requestInteraction publishes this copy while retaining the original for native settlement.
 */
export function publicInteraction<T extends InteractionRequested>(request: T): T { return project(request) as T }
/**
 * Copy acyclic JSON, removing privatePayload, redacting authentication keys and secret-marked
 * content, and stripping HTTP(S) URL queries/fragments. Secret classification booleans survive.
 * Redaction can replace structured fields with strings despite the retained T annotation;
 * callers still own removal of secrets embedded in arbitrary text.
 */
export function publicValue<T extends JsonValue>(value: T): T { return project(value) as T }
/** Encode the full session/execution/item tuple as an unambiguous key, even when IDs contain separators. */
export function itemIdentity(sessionId: string, turnId: string, itemId: string): string {
  return JSON.stringify([sessionId, turnId, itemId])
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(schema)
const validators = new Map<string, ValidateFunction>()
const sensitiveKey = /^(?:password|secret|token|accessToken|refreshToken|apiKey|api_key|authorization|credentials?|headers|env)$/i

/** Cache named AHP validators; unresolved definitions throw instead of being treated as mismatches. */
function validator(name: string): ValidateFunction {
  let value = validators.get(name)
  if (!value) {
    value = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })
    validators.set(name, value)
  }
  return value
}

/** Enforce required answers and offered IDs; missing/empty options permit arbitrary JSON answers. */
function validatesQuestionAnswer(question: UserQuestion, answer: JsonValue | undefined): boolean {
  if (question.required !== false && answer === undefined) return false
  const options = question.options
  if (answer === undefined || !options?.length) return true
  const selected = Array.isArray(answer) ? answer : [answer]
  return selected.every(value => typeof value === 'string' && options.some(option => option.id === value))
}

/** Remove URL query/fragment credentials while preserving surrounding text and URL paths. */
function safeString(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/g, url => url.split(/[?#]/, 1)[0]!)
}
/** Rebuild JSON recursively, applying privacy rules before descending into potentially private fields. */
function project(value: unknown): unknown {
  if (typeof value === 'string') return safeString(value)
  if (Array.isArray(value)) return value.map(entry => project(entry))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    if (key === 'privatePayload') { output.privatePayloadAvailable = true; continue }
    if (key === 'secret' && typeof child === 'boolean') { output[key] = child; continue }
    if (sensitiveKey.test(key)) { output[key] = '[redacted]'; continue }
    if (record.secret === true && /^(?:value|answer|content|text|default)$/i.test(key)) { output[key] = '[redacted]'; continue }
    output[key] = project(child)
  }
  return output
}
