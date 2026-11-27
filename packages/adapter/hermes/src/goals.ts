import type { GoalState, JsonObject } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import { object, protocolError } from './native'
import type { HermesRpc } from './rpc'

/** Older owners return method-not-found. The probe deliberately supplies no session or writable action. */
export async function supportsHermesGoals(rpc: HermesRpc): Promise<boolean> {
  try { await rpc.request('session.control.read') }
  catch (cause) { return cause instanceof HarnessSdkError && cause.code === 'INVALID_PARAMS' }
  return false
}

export function hermesGoal(value: unknown, completionTurnId?: string): GoalState {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { throw protocolError() }
  }
  if (value === null) return { goal: null, status: 'cleared' }
  const raw = object(value)
  if (raw.status === 'cleared') return { goal: null, status: 'cleared' }
  const objective = raw.goal ?? raw.title
  if (typeof objective !== 'string' || typeof raw.status !== 'string') throw protocolError()
  const used = raw.turns_used, budget = raw.max_turns
  const waiting = Boolean(raw.wait_barrier) || raw.status === 'active' && typeof raw.wait_kind === 'string' && raw.wait_kind.length > 0
  let status = raw.status === 'done' ? 'complete' : raw.status
  if (status === 'active' && waiting) status = 'waiting'
  else if (status === 'paused' && typeof used === 'number' && typeof budget === 'number' && used >= budget && raw.paused_reason !== 'user-paused') status = 'limited'
  else if (status === 'paused' && raw.last_verdict === 'blocked' && raw.paused_reason !== 'user-paused') status = 'blocked'
  const goal: JsonObject = { objective, status }
  if (typeof used === 'number') goal.turnsUsed = used
  if (typeof budget === 'number') goal.turnBudget = budget
  if (typeof raw.created_at === 'number' && raw.created_at > 0) goal.createdAt = raw.created_at
  const updated = raw.updated_at ?? raw.last_turn_at
  if (typeof updated === 'number' && updated > 0) goal.updatedAt = updated
  if (status === 'complete' && completionTurnId) goal.completionTurnId = completionTurnId
  return { goal, status: status === 'active' ? 'active' : 'cleared' }
}
