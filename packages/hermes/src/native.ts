import { createHash } from 'node:crypto'
import { HarnessSdkError } from '@anureo/sdk'
import type { JsonObject, JsonValue } from '@anureo/protocol'

export type NativeObject = Record<string, unknown>
export const protocolError = () => new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Hermes gateway message', false, true)
export function object(value: unknown): NativeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError()
  return value as NativeObject
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw protocolError()
  return value
}
export function identity(value: unknown): string {
  const result = text(value)
  if (!result.length || result.length > 4096) throw protocolError()
  return result
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw protocolError()
  return value
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw protocolError()
  return value
}
export function stableId(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
export function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

export interface Description {
  instanceId: string
  profileId: string
  epoch: number
  createParameters: string[]
  editorMcp: boolean
}
export function describe(value: unknown, expected: { instanceId: string; profileId: string }): Description {
  const data = object(value), creation = object(data.session_create)
  if (data.instance_id !== expected.instanceId || data.profile_id !== expected.profileId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
  const capabilities = array(data.capabilities).map(identity)
  const sources = array(creation.sources).map(identity), parameters = array(creation.parameters).map(identity)
  if (!['durable-admission-v1', 'event-replay-v1', 'local-cli-create-v1'].every(value => capabilities.includes(value)) || !sources.includes('tool') || !['request_id', 'source', 'cwd', 'model'].every(value => parameters.includes(value))) {
    throw new HarnessSdkError('HERMES_GATEWAY_UNSUPPORTED', 'Hermes canonical gateway capabilities are required')
  }
  return { instanceId: expected.instanceId, profileId: expected.profileId, epoch: integer(data.authority_epoch), createParameters: parameters,
    editorMcp: capabilities.includes('acp-session-mcp-v1') && sources.includes('acp') && parameters.includes('editor') }
}

export interface Receipt {
  id: string
  sequence: number
  status: 'queued' | 'started' | 'unknown' | 'terminal'
  outcome: string | null
  epoch: number
  generation?: number
  inputId?: string
  steering?: boolean
  result?: NativeObject
}
export function receipt(value: unknown, profileId: string, sessionId: string): Receipt {
  const data = object(value), ref = object(data.ref)
  if (ref.profile_id !== profileId || ref.session_id !== sessionId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
  if (!['queued', 'started', 'unknown', 'terminal'].includes(String(data.status))) throw protocolError()
  const generation = data.execution_generation == null ? undefined : integer(data.execution_generation)
  if (data.status === 'started' && generation === undefined) throw protocolError()
  return {
    id: identity(data.admission_id), sequence: integer(data.sequence), status: data.status as Receipt['status'],
    outcome: data.outcome == null ? null : text(data.outcome), epoch: integer(data.authority_epoch), generation,
    ...(data.input_id !== undefined ? { inputId: identity(data.input_id) } : {}),
    ...(data.steering === true ? { steering: true } : {}),
    ...(data.result != null ? { result: object(data.result) } : {}),
  }
}
export function publicReceipt(value: Receipt): JsonObject {
  return { admissionId: value.id, sequence: value.sequence, status: value.status, authorityEpoch: value.epoch,
    ...(value.generation !== undefined ? { executionGeneration: value.generation } : {}) }
}

export interface NativeEvent {
  type: string
  session_id?: string
  payload: NativeObject
  seq?: number
  replay_epoch?: string
  authority_epoch?: number
  execution_generation?: number
  admission_id?: string
}
export function event(value: unknown): NativeEvent {
  const data = object(value)
  return {
    type: identity(data.type), payload: data.payload == null ? {} : object(data.payload),
    // Global notifications such as sessions.changed use an empty session ID.
    ...(data.session_id !== undefined && data.session_id !== '' ? { session_id: identity(data.session_id) } : {}),
    ...(data.seq !== undefined ? { seq: integer(data.seq) } : {}),
    ...(data.replay_epoch !== undefined ? { replay_epoch: identity(data.replay_epoch) } : {}),
    ...(data.authority_epoch !== undefined ? { authority_epoch: integer(data.authority_epoch) } : {}),
    ...(data.execution_generation !== undefined ? { execution_generation: integer(data.execution_generation) } : {}),
    ...(data.admission_id !== undefined ? { admission_id: identity(data.admission_id) } : {}),
  }
}

const REASONS: Record<string, string> = {
  invalid_params: 'INVALID_PARAMS', permission_denied: 'AUTHORIZATION_FAILED', profile_mismatch: 'SESSION_BINDING_MISMATCH',
  stale_generation: 'TURN_NOT_ACTIVE', not_found: 'SESSION_NOT_FOUND', admission_conflict: 'SUBMISSION_ID_CONFLICT',
  queue_full: 'BACKPRESSURE_EXCEEDED', session_busy: 'SESSION_BUSY', storage_unavailable: 'HARNESS_UNAVAILABLE',
  unsupported_control: 'CAPABILITY_UNSUPPORTED', execution_not_ready: 'TURN_NOT_ACTIVE',
}
export class HermesRpcError extends HarnessSdkError {
  constructor(error: NativeObject) {
    const reason = error.data && typeof error.data === 'object' ? object(error.data).reason : undefined
    const code = typeof reason === 'string' ? REASONS[reason] : undefined
    super(code ?? (error.code === -32601 ? 'METHOD_NOT_FOUND' : error.code === -32602 ? 'INVALID_PARAMS' : 'NATIVE_RPC_ERROR'),
      'Hermes gateway refused the request', reason === 'storage_unavailable', false)
  }
}
