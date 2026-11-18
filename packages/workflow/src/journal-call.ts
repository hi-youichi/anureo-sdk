// Shared journaling for call-shaped workflow steps; agent() and adapter-owned primitives reuse it.
import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import { currentRun, isFatal, type RunContext } from './workflow-state'
import { jsonCopy, type JsonValue } from './persistence/json'
import type { JournalEvent } from './persistence/records'

export interface JournaledCall {
  /** The step prompt; participates in the journal chain key and cache identity. */
  prompt: string
  /** Canonical semantic options; presentation-only fields must never be included. */
  canonical: JsonValue
  /** Journal failure code for a null (dropped) outcome; a function is read lazily at append
   * time so the real terminal code can be captured after execution; defaults to AGENT_DROPPED. */
  droppedCode?: string | (() => string | undefined)
  /** Journal failure code fallback when a cause carries no SDK error; defaults to AGENT_FAILED. */
  failureCode?: string
}

/**
 * Execute one journaled workflow step. Inside a workflow() body the call is
 * memoized by prompt plus canonical options and chained onto the run journal;
 * outside a body it executes unbundled. Journal semantics follow AgentJournal:
 * keys reserve in invocation order, replay serves isolated saved results, and a
 * source failure with an unknown outcome rejects with
 * WORKFLOW_RECONCILIATION_REQUIRED before dispatch.
 * Pass the call directly, or as a thunk evaluated inside the tracked region when
 * building it can throw preflight failures that must mark the run incomplete.
 */
export function journaledCall<T extends JsonValue>(
  call: JournaledCall | (() => JournaledCall),
  execute: (agentId: string) => Promise<T | null>,
): Promise<T | null>
export function journaledCall<T extends JsonValue, R>(
  call: JournaledCall | (() => JournaledCall),
  execute: (agentId: string) => Promise<T | null>,
  revive: (stored: JsonValue) => R,
): Promise<R | null>
export async function journaledCall<T extends JsonValue, R = T>(
  call: JournaledCall | (() => JournaledCall),
  execute: (agentId: string) => Promise<T | null>,
  revive?: (stored: JsonValue) => R,
): Promise<(T | R) | null> {
  const run = currentRun()
  if (!run) {
    if (typeof call === 'function') call()
    return execute(randomUUID())
  }
  return memoized(run, call, execute, revive)
}

async function memoized<T extends JsonValue, R>(
  run: RunContext,
  input: JournaledCall | (() => JournaledCall),
  execute: (agentId: string) => Promise<T | null>,
  revive?: (stored: JsonValue) => R,
): Promise<(T | R) | null> {
  const { journal, state } = run
  return state.track(async () => {
    state.assertDispatch()
    // Resolve the call and reserve its key synchronously inside the tracked
    // region, so preflight failures land on the run state and the chain keeps
    // host invocation order.
    const call = typeof input === 'function' ? input() : input
    const key = journal.nextKey(call.prompt, call.canonical)
    const decision = journal.resolveCall(key)
    if (decision.action === 'reconcile') {
      throw new HarnessSdkError('WORKFLOW_RECONCILIATION_REQUIRED',
        'A previous run left this agent call with an unknown outcome; reconcile it before resuming', false, true)
    }
    if (decision.action === 'replay') {
      return revive ? revive(decision.result) : (decision.result as T)
    }
    const agentId = randomUUID()
    await journal.append({ type: 'started', key, agentId } satisfies JournalEvent)
    state.assertDispatch()
    try {
      const value = await execute(agentId)
      if (value === null) {
        const dropped = typeof call.droppedCode === 'function' ? call.droppedCode() : call.droppedCode
        await journal.append({ type: 'failed', key, agentId, code: dropped ?? 'AGENT_DROPPED', outcomeUnknown: false } satisfies JournalEvent)
        state.noteIncomplete()
        return null
      }
      const stored = jsonCopy(value) as JsonValue
      await journal.append({ type: 'result', key, agentId, result: stored } satisfies JournalEvent)
      return revive ? revive(stored) : (jsonCopy(stored) as T)
    } catch (cause) {
      const error = sdkError(cause, call.failureCode ?? 'AGENT_FAILED')
      if (isFatal(error)) state.stop(error)
      // The storage layer may have published a terminal record already; never
      // append a contradictory failure after a storage error.
      if (error.code !== 'WORKFLOW_STORAGE_FAILED') {
        try {
          await journal.append({ type: 'failed', key, agentId, code: error.code, outcomeUnknown: error.outcomeUnknown === true } satisfies JournalEvent)
        } catch {
          state.noteStorageFailure()
          throw new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown,
            { ...error.details, journalErrorCode: 'WORKFLOW_STORAGE_FAILED' })
        }
      }
      throw error
    }
  }) as Promise<(T | R) | null>
}
