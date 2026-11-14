import { createHash } from 'node:crypto'
import { atomicPublish, storageError } from './checkpoint-files'
import { canonicalJson, digest, jsonCopy, type JsonValue } from './json'
import { journalKeyPrefix, type JournalEvent, type UnknownFailure } from './records'

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
    this.sourceIndex = indexJournal(this.events)
    if (this.sourceIndex.results.size || this.sourceIndex.started.size) this.replayPrefix = new Set()
    this.publishedCount = this.events.length
  }

  /** Advance the chain synchronously before memoizedAgent's first await, including cache hits.
   * Options must be strict JSON. If canonicalJson throws, the chain stays unchanged. */
  nextKey(prompt: string, canonicalOptions: JsonValue): string {
    const key = `${journalKeyPrefix}${createHash('sha256')
      .update(this.previousKey).update('\0')
      .update(JSON.stringify(prompt)).update('\0')
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
      const result = this.sourceIndex.results.get(key)
      if (result !== undefined) {
        this.replayPrefix?.add(key)
        return { action: 'replay', result: jsonCopy(result) }
      }
      if (this.sourceIndex.started.has(key)) this.replayPrefix?.add(key)
      else this.reuseOpen = false
    }
    return this.sourceIndex.uncertain.has(key) ? { action: 'reconcile' } : { action: 'execute' }
  }

  /** Queue a copied event and await serialized atomic publication. Replay decisions use the
   * index built from inherited events. The first start after divergence records the surviving
   * replay prefix in the same publication.
   * On publication failure the event stays in the in-memory snapshot. Non-SDK I/O failures
   * reject as WORKFLOW_STORAGE_FAILED, which RunState records to stop later dispatch. */
  async append(event: JournalEvent): Promise<void> {
    if (event.type === 'started' && !this.reuseOpen && this.replayPrefix) {
      event = { ...event, retainReplayKeys: [...this.replayPrefix] }
      this.replayPrefix = undefined
    }
    this.events.push(jsonCopy(event))
    // Concurrent callers must not race atomic renames: an earlier snapshot
    // landing last would silently drop later events from the published file.
    const publish = this.publishQueue.catch(() => {}).then(async () => {
      try {
        const count = this.events.length
        await atomicPublish(this.path, this.events, () => { this.publishedCount = count })
      } catch (cause) {
        throw storageError(cause)
      }
    })
    this.publishQueue = publish
    await publish
  }

  /** After agent work drains, bind the manifest to the last installed snapshot and carry
   * uncertain failures that never reached it. */
  checkpoint(): { journalDigest: string; unpublishedUnknownFailures: UnknownFailure[] } {
    return {
      journalDigest: digest(this.events.slice(0, this.publishedCount)),
      unpublishedUnknownFailures: this.events.slice(this.publishedCount).filter(
        (event): event is UnknownFailure => event.type === 'failed' && event.outcomeUnknown,
      ),
    }
  }

  private readonly events: JournalEvent[] = []
  private readonly sourceIndex: JournalIndex
  private publishedCount: number
  private previousKey = ''
  private reuseOpen = true
  private replayPrefix?: Set<string>
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
    if (event.type === 'started') {
      if (event.retainReplayKeys) {
        const retained = new Set(event.retainReplayKeys)
        for (const key of index.results.keys()) if (!retained.has(key)) index.results.delete(key)
        for (const key of index.started) if (!retained.has(key)) index.started.delete(key)
      }
      index.started.add(event.key)
    } else if (event.type === 'result') {
      index.results.set(event.key, event.result)
    } else if (event.outcomeUnknown) {
      index.uncertain.add(event.key)
    }
  }
  return index
}
