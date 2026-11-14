import { createHash, randomUUID } from 'node:crypto'
import { HarnessSdkError } from '@anureo/sdk'
import { atomicPublish } from './atomic'
import { canonicalJson, jsonCopy, type JsonValue } from './json'
import type { JournalEvent } from './records'

/** Prior terminal failure returned to memoizedAgent on a miss. */
export interface PriorFailure {
  code: string
  /** The backend outcome is uncertain, so memoizedAgent rejects before redispatch. */
  outcomeUnknown: boolean
}

/** Replay lookup built from validated events. A key left at started can be respawned. */
export interface JournalIndex {
  results: Map<string, JsonValue>
  started: Set<string>
  failures: Map<string, PriorFailure>
}

/** Fold validated events in file order. Clear the earlier entry for each key so a newer
 * start or failure supersedes any older result when AgentJournal initializes its replay lookup. */
export function indexJournal(events: readonly JournalEvent[]): JournalIndex {
  const index: JournalIndex = { results: new Map(), started: new Set(), failures: new Map() }
  for (const event of events) {
    index.started.delete(event.key)
    index.failures.delete(event.key)
    index.results.delete(event.key)
    if (event.type === 'started') index.started.add(event.key)
    else indexTerminalEvent(index, event)
  }
  return index
}

/**
 * Internal agent-call journal created by publishInitialRun for a new run and exposed
 * by workflow through the ambient run context.
 * memoizedAgent reserves keys in invocation order, checks replay, and awaits markers before
 * dispatch or settlement. Each key hashes its predecessor, prompt and semantic options,
 * so upstream changes invalidate later call identities. The run handle owns the writer lock.
 * workflow drains registered agent work before final publication and closure.
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

  /** Return an isolated cached result while reuse remains open, or undefined for execution.
   * memoizedAgent revalidates typed hits against the current output schema before returning them. */
  resultFor(key: string): JsonValue | undefined {
    if (!this.reuseOpen) return undefined
    const result = this.index.results.get(key)
    return result === undefined ? undefined : jsonCopy(result)
  }

  /** Record a miss after resultFor returns undefined. A source key left at started can be
   * respawned while preserving eligibility for later keys. Any other miss closes result reuse
   * for the rest of the run. Return the exact key's prior terminal failure, if any, so
   * memoizedAgent can reject an unknown outcome before dispatch. */
  beginExecution(key: string): PriorFailure | undefined {
    if (!this.index.started.has(key)) this.reuseOpen = false
    return this.index.failures.get(key)
  }

  /** Queue a copied event and await serialized atomic publication before indexing terminal data.
   * memoizedAgent awaits started before dispatch and terminals before settlement. Keep the
   * event unchanged until settlement and its result payload immutable while the lookup retains it.
   * On publication failure the event remains queued. Non-SDK I/O failures reject as
   * WORKFLOW_STORAGE_FAILED and stop subsequent workflow dispatch. */
  async append(event: JournalEvent): Promise<void> {
    this.events.push(jsonCopy(event))
    // Concurrent callers must not race atomic renames: an earlier snapshot
    // landing last would silently drop later events from the published file.
    const publish = this.publishQueue.catch(() => {}).then(async () => {
      try {
        await atomicPublish(this.path, this.events)
      } catch (cause) {
        if (cause instanceof HarnessSdkError) throw cause
        throw new HarnessSdkError('WORKFLOW_STORAGE_FAILED')
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

/** Generate a UUID suitable for a journal event's agentId; this does not reserve a cache key. */
export function newAgentId(): string {
  return randomUUID()
}

/** Populate the terminal lookup. The replay fold clears superseded entries before calling
 * this helper. Live append retains the source prefix markers for miss handling. */
function indexTerminalEvent(index: JournalIndex, event: Exclude<JournalEvent, { type: 'started' }>): void {
  if (event.type === 'result') {
    index.results.set(event.key, event.result)
  } else {
    index.failures.set(event.key, { code: event.code, outcomeUnknown: event.outcomeUnknown })
  }
}
