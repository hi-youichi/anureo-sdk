import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentJournal } from './persistence/journal'
import type { RunState } from './workflow-state'

/** Internal context supplied by workflow and read by agent to share a journal and dispatch state. */
export interface RunContext {
  readonly journal: AgentJournal
  readonly state: RunState
}

/** Run the body supplied by workflow's completeRun phase with context inherited by asynchronous descendants.
 * Returns the body's promise without draining or closing the run; workflow owns that lifecycle.
 * Nested calls restore the enclosing context when their synchronous invocation returns. */
export function runWith<T>(context: RunContext, body: () => Promise<T>): Promise<T> {
  return storage.run(context, body)
}

/** Let agent select journaled execution in an inherited run context, or ordinary execution
 * when absent. A retained context may already be closed; RunState enforces dispatch admission. */
export function currentRun(): RunContext | undefined {
  return storage.getStore()
}

const storage = new AsyncLocalStorage<RunContext>()
