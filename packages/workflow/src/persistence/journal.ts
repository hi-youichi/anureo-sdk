import { createHash } from 'node:crypto'
import { atomicPublish, storageError } from './checkpoint-files'
import { canonicalJson, jsonCopy, type JsonValue } from './json'
import type { JournalEvent } from './records'

/**
 * Internal agent-call journal created by publishInitialRun for a new run and exposed
 * by workflow through the ambient run context.
 * memoizedAgent reserves keys in invocation order and checks replay. On a miss,
 * executeJournaledAgent awaits markers before dispatch and settlement. Each key hashes its
 * predecessor, prompt and semantic options, so upstream changes invalidate later call identities.
 * workflow drains registered agent work before final publication and releases the writer
 * lock through the run handle.
 */
export class AgentJournal {
  /** Copy validated source events into a new run's journal; construction performs no file I/O. */
  constructor(
    private readonly path: string,
    source: readonly JournalEvent[],
  ) {
    this.events.push(...jsonCopy(source))
    this.index = indexJournal(this.events)
  }

  /** Advance the chain synchronously before memoizedAgent's first await, including cache hits.
   * Options must be strict JSON. If canonicalJson throws, the chain stays unchanged. */
  nextKey(prompt: string, canonicalOptions: JsonValue): string {
    const key = `v1:${createHash('sha256')
      .update(this.previousKey).update('\0')
      .update(prompt).update('\0')
      .update(canonicalJson(canonicalOptions)).digest('hex')}`
    this.previousKey = key
    return key
  }

  /** Decide how memoizedAgent should handle the reserved key. A replay carries an isolated
   * result for the caller to validate. A miss closes result reuse unless the source left this
   * key at started. Even after reuse closes, an exact-key failure with an unknown outcome
   * requires reconciliation before memoizedAgent can dispatch. */
  resolveCall(key: string): JournalDecision {
    if (this.reuseOpen) {
      const result = this.index.results.get(key)
      if (result !== undefined) return { action: 'replay', result: jsonCopy(result) }
    }
    if (!this.index.started.has(key)) this.reuseOpen = false
    return this.index.uncertain.has(key) ? { action: 'reconcile' } : { action: 'execute' }
  }

  /** Queue a copied event and await serialized atomic publication before indexing terminal data.
   * executeJournaledAgent awaits started before dispatch and terminals before settlement. Keep the
   * event unchanged until settlement and its result payload immutable while the lookup retains it.
   * On publication failure the event stays in the in-memory snapshot. Non-SDK I/O failures
   * reject as WORKFLOW_STORAGE_FAILED, which RunState records to stop later dispatch. */
  async append(event: JournalEvent): Promise<void> {
    this.events.push(jsonCopy(event))
    // Concurrent callers must not race atomic renames: an earlier snapshot
    // landing last would silently drop later events from the published file.
    const publish = this.publishQueue.catch(() => {}).then(async () => {
      try {
        await atomicPublish(this.path, this.events)
      } catch (cause) {
        throw storageError(cause)
      }
    })
    this.publishQueue = publish
    await publish
    if (event.type !== 'started') indexTerminalEvent(this.index, event)
  }

  private readonly events: JournalEvent[] = []
  private readonly index: JournalIndex
  private previousKey = ''
  private reuseOpen = true
  private publishQueue: Promise<void> = Promise.resolve()
}

/** Result handling stays with memoizedAgent, which owns validation, dispatch and rejection. */
type JournalDecision = { action: 'replay'; result: JsonValue } | { action: 'execute' | 'reconcile' }

/** Replay lookup built from validated events. A key left at started can be respawned. */
interface JournalIndex {
  results: Map<string, JsonValue>
  started: Set<string>
  uncertain: Set<string>
}

/** Fold validated events in file order. Clear the earlier entry for each key so a newer
 * start or failure supersedes any older result when AgentJournal initializes its replay lookup. */
function indexJournal(events: readonly JournalEvent[]): JournalIndex {
  const index: JournalIndex = { results: new Map(), started: new Set(), uncertain: new Set() }
  for (const event of events) {
    index.started.delete(event.key)
    index.uncertain.delete(event.key)
    index.results.delete(event.key)
    if (event.type === 'started') index.started.add(event.key)
    else indexTerminalEvent(index, event)
  }
  return index
}

/** Populate the terminal lookup. The replay fold clears superseded entries before calling
 * this helper. Live append retains the source prefix markers for miss handling. */
function indexTerminalEvent(index: JournalIndex, event: Exclude<JournalEvent, { type: 'started' }>): void {
  if (event.type === 'result') {
    index.results.set(event.key, event.result)
  } else if (event.outcomeUnknown) {
    index.uncertain.add(event.key)
  } else {
    index.uncertain.delete(event.key)
  }
}
