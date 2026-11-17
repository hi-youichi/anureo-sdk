// Shared journaling for call-shaped workflow steps; agent() and adapter-owned primitives reuse it.
import { sdkError } from '@anureo/sdk'
import { currentRun, type RunContext } from './run-context'
import { isFatal } from './workflow-state'
import { jsonCopy, type JsonValue } from './persistence/json'
import { newAgentId, type JournalEvent } from './persistence/journal'

export interface JournaledCall {
  /** The step prompt; participates in the journal chain key and cache identity. */
  prompt: string
  /** Canonical semantic options; presentation-only fields must never be included. */
  canonical: JsonValue
  /** Client input-hook revision recorded on started records. */
  inputHookRevision?: string
  /** Journal failure code for a null (dropped) outcome; defaults to AGENT_DROPPED. */
  droppedCode?: string
  /** Journal failure code fallback when a cause carries no SDK error; defaults to AGENT_FAILED. */
  failureCode?: string
}

type JournalKey = ReturnType<import('./persistence/journal').AgentJournal['nextKey']>

/**
 * Execute one journaled workflow step. Inside a workflow() body the call is
 * memoized by prompt plus canonical options and chained onto the run journal;
 * outside a body it executes unbundled. Mirrors agent() journaling exactly.
 */
export function journaledCall<T extends JsonValue>(
  call: JournaledCall,
  execute: (agentId: string) => Promise<T | null>,
): Promise<T | null>
export function journaledCall<T extends JsonValue, R>(
  call: JournaledCall,
  execute: (agentId: string) => Promise<T | null>,
  revive: (stored: JsonValue) => R,
): Promise<R | null>
export async function journaledCall<T extends JsonValue, R = T>(
  call: JournaledCall,
  execute: (agentId: string) => Promise<T | null>,
  revive?: (stored: JsonValue) => R,
): Promise<(T | R) | null> {
  const run = currentRun()
  if (!run) return execute(newAgentId())
  // The key advances synchronously here: host invocation order fixes the chain.
  const key = run.journal.nextKey(call.prompt, call.canonical)
  return memoized(run, key, call, execute, revive)
}

async function memoized<T extends JsonValue, R>(
  run: RunContext,
  key: JournalKey,
  call: JournaledCall,
  execute: (agentId: string) => Promise<T | null>,
  revive?: (stored: JsonValue) => R,
): Promise<(T | R) | null> {
  const { journal, state } = run
  return state.track(async () => {
    state.assertDispatch()
    const conflict = journal.resumeConflict(key, call.inputHookRevision)
    if (conflict) {
      state.stop(conflict)
      throw conflict
    }
    const hit = journal.resultFor(key)
    if (hit !== undefined) {
      return revive ? revive(hit) : (hit as T)
    }
    journal.beginExecution(key)
    const agentId = newAgentId()
    await journal.append({ type: 'started', key, agentId, ...(call.inputHookRevision === undefined ? {} : { inputHookRevision: call.inputHookRevision }) } satisfies JournalEvent)
    state.assertDispatch()
    try {
      const value = await execute(agentId)
      if (value === null) {
        await journal.append({ type: 'failed', key, agentId, code: call.droppedCode ?? 'AGENT_DROPPED', outcomeUnknown: false } satisfies JournalEvent)
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
        await journal.append({ type: 'failed', key, agentId, code: error.code, outcomeUnknown: error.outcomeUnknown === true } satisfies JournalEvent)
      }
      throw error
    }
  }) as Promise<(T | R) | null>
}
