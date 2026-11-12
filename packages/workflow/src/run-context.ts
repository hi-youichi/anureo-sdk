import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentJournal } from './persistence/journal'
import type { RunState } from './workflow-state'

/** Ambient context linking agent() calls inside a workflow body to its journal. */
export interface RunContext {
  readonly journal: AgentJournal
  readonly state: RunState
}

const storage = new AsyncLocalStorage<RunContext>()

export function runWith<T>(context: RunContext, body: () => Promise<T>): Promise<T> {
  return storage.run(context, body)
}

export function currentRun(): RunContext | undefined {
  return storage.getStore()
}
