import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import schema from '../schema/v1/ahp.schema.json'
import { AHP_METHOD_DEFINITIONS } from './generated/types'
import type {
  Capabilities, AhpEvent, AhpMethod, AhpRequestMap, AhpResultMap,
  InteractionRequested, InteractionResponse, JsonSchema, JsonValue,
} from './generated/types'

export * from './generated/types'
export { default as ahpSchema } from '../schema/v1/ahp.schema.json'
export const AHP_PROTOCOL_VERSION = 1 as const

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema(schema)
const validators = new Map<string, ValidateFunction>()
function validator(name: string): ValidateFunction {
  let value = validators.get(name)
  if (!value) {
    value = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })
    validators.set(name, value)
  }
  return value
}
export type ValidationIssue = Pick<ErrorObject, 'instancePath' | 'keyword' | 'message'>
export class ProtocolValidationError extends Error {
  readonly code = 'INVALID_PARAMS'
  readonly retryable = false
  readonly outcomeUnknown = false
  readonly issues: ValidationIssue[]
  constructor(message: string, issues: readonly ErrorObject[] = []) {
    super(message)
    this.name = 'ProtocolValidationError'
    // Never copy data/params into diagnostics: these can contain secret answers.
    this.issues = issues.map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message }))
  }
}
export function validateDefinition<T = unknown>(name: string, value: unknown): value is T { return !!validator(name)(value) }
export function assertDefinition<T = unknown>(name: string, value: unknown): asserts value is T {
  const check = validator(name)
  if (!check(value)) throw new ProtocolValidationError(`Invalid AHP ${name}`, check.errors ?? [])
}
export function validateRequest<M extends AhpMethod>(method: M, value: unknown): value is AhpRequestMap[M] {
  return !!validator(AHP_METHOD_DEFINITIONS[method][0])(value)
}
export function assertRequest<M extends AhpMethod>(method: M, value: unknown): asserts value is AhpRequestMap[M] {
  assertDefinition<AhpRequestMap[M]>(AHP_METHOD_DEFINITIONS[method][0], value)
}
export function validateResult<M extends AhpMethod>(method: M, value: unknown): value is AhpResultMap[M] {
  return !!validator(AHP_METHOD_DEFINITIONS[method][1])(value)
}
export function assertResult<M extends AhpMethod>(method: M, value: unknown): asserts value is AhpResultMap[M] {
  assertDefinition<AhpResultMap[M]>(AHP_METHOD_DEFINITIONS[method][1], value)
}
export function validateEvent(value: unknown): value is AhpEvent { return validateDefinition<AhpEvent>('AhpEvent', value) }
export function assertEvent(value: unknown): asserts value is AhpEvent { assertDefinition<AhpEvent>('AhpEvent', value) }
export function isAhpMethod(value: string): value is AhpMethod { return Object.hasOwn(AHP_METHOD_DEFINITIONS, value) }

export function negotiateVersion(versions: readonly number[], supported: readonly number[] = [AHP_PROTOCOL_VERSION]): number {
  const agreed = versions.filter(value => supported.includes(value)).sort((a, b) => b - a)[0]
  if (agreed === undefined) {
    const error = new Error('No mutually supported AHP protocol version') as Error & { code: string; retryable: boolean; outcomeUnknown: boolean }
    error.name = 'ProtocolVersionError'; error.code = 'PROTOCOL_VERSION_UNSUPPORTED'; error.retryable = false; error.outcomeUnknown = false
    throw error
  }
  return agreed
}

/** Missing values and empty supported-value lists are unsupported. */
export function supportsCapability(capabilities: Capabilities, path: string, value?: string): boolean {
  let current: unknown = capabilities
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return false
    current = (current as Record<string, unknown>)[part]
  }
  if (Array.isArray(current)) return value === undefined ? current.length > 0 : current.includes(value)
  return current === true
}
export function supportsExtension(capabilities: Capabilities, name: string, version?: string): boolean {
  return !!capabilities.extensions?.some(extension => extension.name === name && (version === undefined || extension.version === version))
}

/** Validates caller-supplied answer schemas with the same draft 2020-12 engine. */
export function validateJsonSchema(schemaValue: JsonSchema, value: unknown): boolean {
  try { return !!ajv.compile(schemaValue)(value) } catch { return false }
}
export function validateInteractionResponse(request: InteractionRequested, response: unknown): response is InteractionResponse {
  if (!validateDefinition<InteractionResponse>('InteractionResponse', response) || request.kind !== response.kind) return false
  switch (response.kind) {
    case 'approval': return request.kind === 'approval' && request.options.some(option => option.id === response.optionId)
    case 'userInput': {
      if (request.kind !== 'userInput') return false
      if (request.schema !== undefined && !validateJsonSchema(request.schema, response.answers)) return false
      return request.questions.every(question => {
        const answer = response.answers[question.id]
        if (question.required !== false && answer === undefined) return false
        if (answer === undefined || !question.options?.length) return true
        const selected = Array.isArray(answer) ? answer : [answer]
        return selected.every(value => typeof value === 'string' && question.options!.some(option => option.id === value))
      })
    }
    case 'elicitation': return request.kind === 'elicitation' && (response.action !== 'accept' || request.schema === undefined || validateJsonSchema(request.schema, response.content))
    case 'dynamicTool': return request.kind === 'dynamicTool' && (request.schema === undefined || validateJsonSchema(request.schema, response))
  }
}
export function assertInteractionResponse(request: InteractionRequested, response: unknown): asserts response is InteractionResponse {
  if (!validateInteractionResponse(request, response)) throw new ProtocolValidationError('Invalid interaction response')
}

const sensitiveKey = /^(?:password|secret|token|accessToken|refreshToken|apiKey|api_key|authorization|credentials?|headers|env)$/i
function safeString(value: string): string {
  // Authorization URL query and fragments never enter public histories.
  return value.replace(/https?:\/\/[^\s<>"']+/g, url => url.split(/[?#]/, 1)[0]!)
}
function project(value: unknown, sensitive = false): unknown {
  if (sensitive) return '[redacted]'
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
/** Produces a detached public projection; privatePayload is never modified in-place. */
export function publicEvent<T extends AhpEvent>(event: T): T { return project(event) as T }
export function publicInteraction<T extends InteractionRequested>(request: T): T { return project(request) as T }
export function publicValue<T extends JsonValue>(value: T): T { return project(value) as T }
export function itemIdentity(sessionId: string, turnId: string, itemId: string): string { return JSON.stringify([sessionId, turnId, itemId]) }
