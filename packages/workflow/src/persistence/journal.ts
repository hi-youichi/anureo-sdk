import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import { atomicPublish } from './atomic'
import { canonicalJson, jsonCopy, type JsonValue } from './json'
import { journalEventSchema } from './records'

/** Internal validated event persisted before dispatch or before exposing an agent outcome. */
export type JournalEvent = z.output<typeof journalEventSchema>

/** Prior terminal failure returned to memoizedAgent, which blocks redispatch of unknown outcomes. */
export interface PriorFailure {
  code: string
  outcomeUnknown: boolean
}

/** Latest event wins per key; a final started marker identifies a respawnable call. */
export interface JournalIndex {
  results: Map<string, JsonValue>
  started: Set<string>
  failures: Map<string, PriorFailure>
}

/** Fold validated events in file order into replay state; a later start/failure also removes
 * any older result so replay cannot expose a superseded successful execution. */
export function indexJournal(events: readonly JournalEvent[]): JournalIndex {
  const index: JournalIndex = { results: new Map(), started: new Set(), failures: new Map() }
  for (const event of events) {
    index.started.delete(event.key)
    index.failures.delete(event.key)
    index.results.delete(event.key)
    if (event.type === 'started') index.started.add(event.key)
    else if (event.type === 'failed') index.failures.set(event.key, { code: event.code, outcomeUnknown: event.outcomeUnknown })
    else index.results.set(event.key, event.result)
  }
  return index
}

/**
 * Internal agent-call journal created by publishInitialRun for a new run and exposed
 * by workflow through the ambient run context.
 * memoizedAgent reserves keys in invocation order, checks replay, and awaits markers before
 * dispatch or settlement. Each key hashes its predecessor, prompt and semantic options,
 * so upstream changes invalidate later call identities. The run handle owns the writer lock;
 * workflow must drain agent work before final publication and closure.
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
   * Options must be strict JSON; rejection by canonicalJson leaves the chain unchanged. */
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

  /**
   * Marks a cache miss. A source entry with only `started` (crash during a call)
   * is a respawnable prefix: it stays reuse-eligible for later calls, matching
   * the "longest unchanged prefix" semantics. Returns the prior terminal
   * failure of this exact key, if any; memoizedAgent rejects unknown outcomes before dispatch.
   * Call only after resultFor misses; a non-started miss permanently closes result reuse.
   */
  beginExecution(key: string): PriorFailure | undefined {
    if (!this.index.started.has(key)) this.reuseOpen = false
    return this.index.failures.get(key)
  }

  /** Queue a copied event and await serialized atomic publication before exposing terminal data
   * through the index. memoizedAgent awaits started before dispatch and terminals before settlement.
   * Keep the supplied event unchanged until settlement. Failed publication retains queued events;
   * non-SDK I/O failures reject as WORKFLOW_STORAGE_FAILED, which stops workflow dispatch. */
  async append(event: JournalEvent): Promise<void> {
    this.events.push(jsonCopy(event))
    // Concurrent callers must not race atomic renames: an earlier snapshot
    // landing last would silently drop later events from the published file.
    const publish = this.publishQueue.catch(() => {}).then(async () => {
      try { await atomicPublish(this.path, this.events) }
      catch (cause) {
        if (cause instanceof HarnessSdkError) throw cause
        throw new HarnessSdkError('WORKFLOW_STORAGE_FAILED')
      }
    })
    this.publishQueue = publish
    await publish
    if (event.type === 'result') this.index.results.set(event.key, event.result)
    else if (event.type === 'failed') this.index.failures.set(event.key, { code: event.code, outcomeUnknown: event.outcomeUnknown })
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
