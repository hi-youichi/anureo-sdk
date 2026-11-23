import { validateHxRequest, validateHxResult, validateSessionListSummaryPage, type HostSessionListSummary, type HostSessionListSummaryPage, type HxMethod, type HxRequestMap, type HxResultMap, type PublicSession } from './legacy-protocol'
export { HX_METHODS, isHxMethod, validateHostEvent, validateSubscriptionError } from './legacy-protocol'
export type { HxMethod, HostEvent, EventPage, OperationResult } from './legacy-protocol'

export interface SessionListParams {
  scopeId: string
  archived?: boolean
  cursor?: string
  limit?: number
}

export type SessionSummary = HostSessionListSummary
export type SessionListResult = HostSessionListSummaryPage

type Scope<T> = {
  [Property in keyof T as Property extends 'projectId' ? 'scopeId' : Property]: T[Property]
}
export type HostRequestMap = { [Method in HxMethod]: Scope<HxRequestMap[Method]> }
export type HostResultMap = Omit<{ [Method in HxMethod]: Scope<HxResultMap[Method]> }, 'hx.session.list' | 'hx.session.reconcile'> & {
  'hx.session.list': SessionListResult
  'hx.session.reconcile': Omit<HxResultMap['hx.session.reconcile'], 'session'> & { session: Scope<PublicSession> }
}

export function validateHostRequest<Method extends HxMethod>(method: Method, params: unknown): asserts params is HostRequestMap[Method] {
  validateHxRequest(method, scopeParams(params))
}

export function validateHostResult<Method extends HxMethod>(method: Method, result: unknown): asserts result is HostResultMap[Method] {
  if (method === 'hx.session.list') {
    validateSessionListSummaryPage(result)
    return
  }
  if (method === 'hx.session.reconcile' && result && typeof result === 'object' && 'session' in result) {
    validateHxResult(method, { ...result, session: scopeParams(result.session) })
    return
  }
  validateHxResult(method, scopeParams(result))
}

/** Translate only protocol envelope fields. User content and metadata are opaque. */
export function scopeParams(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params
  if (Object.hasOwn(params, 'projectId')) throw new TypeError('The Host protocol accepts scopeId')
  if (!('scopeId' in params)) return params
  const { scopeId, ...rest } = params
  return { ...rest, projectId: scopeId }
}

function scopeObject(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('projectId' in value)) return value
  const { projectId, ...rest } = value
  return { ...rest, scopeId: projectId }
}

export function sessionSummary({ id, projectId, title, status, runtimeConfigId, updatedAt, archived }: Pick<PublicSession, 'id' | 'projectId' | 'title' | 'status' | 'runtimeConfigId' | 'updatedAt' | 'archived'>): SessionSummary {
  return { id, scopeId: projectId, ...(title === undefined ? {} : { title }), status, runtimeConfigId, ...(updatedAt === undefined ? {} : { updatedAt }), archived }
}

export function scopeResult(result: unknown, method?: string): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  if (method === 'hx.session.list') {
    const page = result as HxResultMap['hx.session.list']
    return { sessions: page.sessions.map(sessionSummary), nextCursor: page.nextCursor }
  }
  if ('session' in result) return { ...result, session: scopeObject(result.session) }
  if ('operationId' in result && 'result' in result) return { ...result, result: scopeObject(result.result) }
  return scopeObject(result)
}
