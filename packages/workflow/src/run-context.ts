import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentJournal } from './persistence/journal'
import type { RunState } from './workflow-state'

/** Internal run context installed for the workflow body and inherited by agent calls. */
export interface RunContext {
  /** Source replay and target journal used by memoizedAgent. */
  readonly journal: AgentJournal
  /** Admission, pending work and failure state shared with workflow. */
  readonly state: RunState
}

/** Invoke completeRun's body callback with context inherited by asynchronous descendants.
 * Return the callback's promise or propagate a synchronous throw. The calling context is
 * restored when the callback returns or throws, while completeRun owns the subsequent drain. */
export function runWith<T>(context: RunContext, body: () => Promise<T>): Promise<T> {
  return storage.run(context, body)
}

/** Read the current async context so agent can choose journaled or ordinary execution.
 * Async descendants can retain a closed context. RunState.track then rejects admission. */
export function currentRun(): RunContext | undefined {
  return storage.getStore()
}

const storage = new AsyncLocalStorage<RunContext>()
