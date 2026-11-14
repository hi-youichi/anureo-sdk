/** Publishes AHP runtime validation, compatibility checks and public JSON projections. */
import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import schema from '../schema/v1/ahp.schema.json'
import { AHP_METHOD_DEFINITIONS } from './generated/types'
import type {
  Capabilities, AhpEvent, AhpMethod, AhpRequestMap, AhpResultMap,
  InteractionRequested, InteractionResponse, JsonSchema, JsonValue, UserQuestion,
} from './generated/types'

export * from './generated/types'
export { publicEvent, publicInteraction, publicValue } from './public-projection'
/** AHP v1 draft 2020-12 schema for consumers that compile their own validators. */
export { default as ahpSchema } from '../schema/v1/ahp.schema.json'
/** Protocol major version offered by default during negotiation. */
export const AHP_PROTOCOL_VERSION = 1 as const
/** Required `protocolContract` value in both `initialize` parameters and results. */
export const AHP_PROTOCOL_CONTRACT = 'native-lifecycle' as const

/** Schema failure metadata retained without Ajv's rejected data or keyword parameters. */
export type ValidationIssue = Pick<ErrorObject, 'instancePath' | 'keyword' | 'message'>
/** Report a definite, non-retryable validation failure with limited schema diagnostics. */
export class ProtocolValidationError extends Error {
  /** Supply a non-sensitive message. Only the path, keyword and message are copied from each issue. */
  constructor(message: string, issues: readonly ErrorObject[] = []) {
    super(message)
    this.name = 'ProtocolValidationError'
    // Never copy data/params into diagnostics: these can contain secret answers.
    this.issues = issues.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }))
  }
  readonly code = 'INVALID_PARAMS'
  readonly retryable = false
  readonly outcomeUnknown = false
  /** Diagnostics supplied by the check. Envelope and interaction assertions leave this empty. */
  readonly issues: ValidationIssue[]
}
/**
 * Test a value against a named AHP `$defs` entry without modifying it. An unknown name throws
 * during schema compilation. The caller must choose a `T` matching the definition.
 * The validators in this entry point leave format annotations unenforced.
 */
export function validateDefinition<T = unknown>(name: string, value: unknown): value is T {
  return !!validator(name)(value)
}
/**
 * Assert a named AHP definition, throwing ProtocolValidationError on a mismatch.
 * An unknown name throws a schema compilation error. The caller must match `T` to the definition.
 */
export function assertDefinition<T = unknown>(name: string, value: unknown): asserts value is T {
  const check = validator(name)
  if (!check(value)) throw new ProtocolValidationError(`Invalid AHP ${name}`, check.errors ?? [])
}
/** Test request parameters for a known method without coercing values or applying defaults. Use isAhpMethod for untrusted method names. */
export function validateRequest<M extends AhpMethod>(method: M, value: unknown): value is AhpRequestMap[M] {
  return validateDefinition<AhpRequestMap[M]>(AHP_METHOD_DEFINITIONS[method][0], value)
}
/**
 * Reject malformed parameters for a known method with ProtocolValidationError before dispatch.
 * guardRequest lets this failure reach the SDK caller before dispatch. Callers still own
 * binding, capability and lifecycle checks.
 */
export function assertRequest<M extends AhpMethod>(method: M, value: unknown): asserts value is AhpRequestMap[M] {
  assertDefinition<AhpRequestMap[M]>(AHP_METHOD_DEFINITIONS[method][0], value)
}
/** Check the result shape for a known method. The caller must match its identities to the request. */
export function validateResult<M extends AhpMethod>(method: M, value: unknown): value is AhpResultMap[M] {
  return validateDefinition<AhpResultMap[M]>(AHP_METHOD_DEFINITIONS[method][1], value)
}
/**
 * Assert the result shape for a known method or throw ProtocolValidationError. The caller owns
 * request/result identity and lifecycle checks. Session.validateNativeResult treats a failure
 * as an unknown native outcome and starts observation teardown.
 */
export function assertResult<M extends AhpMethod>(method: M, value: unknown): asserts value is AhpResultMap[M] {
  assertDefinition<AhpResultMap[M]>(AHP_METHOD_DEFINITIONS[method][1], value)
}
/** Check an event payload and its source envelope, including a turn ID for item events. The caller tracks sequence order. */
export function validateEvent(value: unknown): value is AhpEvent {
  return validateDefinition<AhpEvent>('AhpEvent', value) && (!value.type.startsWith('item/') || !!value.turnId)
}
/**
 * Assert an event envelope or throw ProtocolValidationError without issue details.
 * AhpAdapter.notification checks incoming envelopes before routing them. A malformed envelope
 * rejects the notification callback and the wire closes. Session.publish checks the projected
 * envelope before publishing it and a failure rejects the emit operation. Callers enforce stream
 * ordering and lifecycle state separately.
 */
export function assertEvent(value: unknown): asserts value is AhpEvent {
  if (!validateEvent(value)) throw new ProtocolValidationError('Invalid AHP event')
}
/** Recognize method names in the generated request/result table, excluding extension methods. */
export function isAhpMethod(value: string): value is AhpMethod {
  return Object.hasOwn(AHP_METHOD_DEFINITIONS, value)
}

/**
 * Select the highest shared major version. Omit `supported` to offer only AHP_PROTOCOL_VERSION.
 * Throw an error named ProtocolVersionError with code PROTOCOL_VERSION_UNSUPPORTED,
 * `retryable: false` and `outcomeUnknown: false` when there is no shared version. Validate
 * the initialization request or result separately to check the handshake discriminator.
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
 * Look up a dot-separated own-property path in negotiated capabilities. A boolean leaf supports
 * the capability when true regardless of `value`. A list leaf must include `value` when supplied
 * and must be non-empty when omitted. Missing paths and other leaf types are unsupported.
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
/** Match an advertised extension by exact name and, when supplied, exact version. Omit the version to accept any advertised version. */
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
 * Test an answer against an already-valid request without settling the interaction. The kinds must
 * match and an approval must select an offered ID. User questions are required unless `required`
 * is false. A non-empty option list limits an answer to an offered ID or an array of offered IDs.
 * Embedded schemas check the user answers object, accepted elicitation content, or the whole tool
 * response. Return false for invalid responses or failing embedded schemas.
 */
export function validateInteractionResponse(request: InteractionRequested, response: unknown): response is InteractionResponse {
  if (!validateDefinition<InteractionResponse>('InteractionResponse', response) || request.kind !== response.kind) return false
  switch (response.kind) {
    case 'approval':
      return request.kind === 'approval' && request.options.some(option => option.id === response.optionId)
    case 'userInput':
      return request.kind === 'userInput' && validatesUserInput(request, response)
    case 'elicitation':
      if (request.kind !== 'elicitation') return false
      if (response.action !== 'accept' || request.schema === undefined) return true
      return validateJsonSchema(request.schema, response.content)
    case 'dynamicTool':
      return request.kind === 'dynamicTool' && (request.schema === undefined || validateJsonSchema(request.schema, response))
  }
}
/**
 * Throw ProtocolValidationError for an answer that fails request-specific validation.
 * InteractionRegistry.respond calls this before its pre-response callback, replay checks and
 * native delivery. A mismatch rejects the response attempt without settling the interaction.
 */
export function assertInteractionResponse(request: InteractionRequested, response: unknown): asserts response is InteractionResponse {
  if (!validateInteractionResponse(request, response)) throw new ProtocolValidationError('Invalid interaction response')
}

/** Encode the full session/execution/item tuple as an unambiguous key, even when IDs contain separators. */
export function itemIdentity(sessionId: string, turnId: string, itemId: string): string {
  return JSON.stringify([sessionId, turnId, itemId])
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(schema)
const validators = new Map<string, ValidateFunction>()

/** Compile and cache an AHP definition on first use. Compilation failures propagate without populating the cache. */
function validator(name: string): ValidateFunction {
  let value = validators.get(name)
  if (!value) {
    value = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })
    validators.set(name, value)
  }
  return value
}

/** Check the embedded answers schema before evaluating the individual questions. */
function validatesUserInput(
  request: Extract<InteractionRequested, { kind: 'userInput' }>,
  response: Extract<InteractionResponse, { kind: 'userInput' }>,
): boolean {
  if (request.schema !== undefined && !validateJsonSchema(request.schema, response.answers)) return false
  return request.questions.every(question => validatesQuestionAnswer(question, response.answers[question.id]))
}

/** Check required answers and offered IDs. Missing or empty options permit any JSON answer. */
function validatesQuestionAnswer(question: UserQuestion, answer: JsonValue | undefined): boolean {
  if (question.required !== false && answer === undefined) return false
  const options = question.options
  if (answer === undefined || !options?.length) return true
  const selected = Array.isArray(answer) ? answer : [answer]
  return selected.every(value => typeof value === 'string' && options.some(option => option.id === value))
}
