import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HarnessSdkError } from '@anureo/sdk'
import { atomicPublish } from './atomic'
import { canonicalJson, jsonCopy, type JsonValue } from './json'
import { journalEventSchema } from './records'

export type JournalEvent = z.output<typeof journalEventSchema>

export interface PriorFailure {
  code: string
  outcomeUnknown: boolean
}

/** Last result wins per key; started without terminal marks a respawnable call. */
export interface JournalIndex {
  results: Map<string, JsonValue>
  started: Set<string>
  failures: Map<string, PriorFailure>
}

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
 * Appended agent-call journal. Cache identity is a chain: each call's key hashes
 * the previous key, the prompt, and the canonical semantic options, so any
 * upstream change invalidates the whole downstream prefix automatically.
 */
export class AgentJournal {
  private readonly events: JournalEvent[] = []
  private readonly index: JournalIndex
  private previousKey = ''
  private reuseOpen = true
  private publishQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    source: readonly JournalEvent[],
  ) {
    this.events.push(...jsonCopy(source))
    this.index = indexJournal(this.events)
  }

  nextKey(prompt: string, canonicalOptions: JsonValue): string {
    const key = `v1:${createHash('sha256')
      .update(this.previousKey).update('\0')
      .update(prompt).update('\0')
      .update(canonicalJson(canonicalOptions)).digest('hex')}`
    this.previousKey = key
    return key
  }

  /** Returns a copy of the cached result, or undefined when this call must execute. */
  resultFor(key: string): JsonValue | undefined {
    if (!this.reuseOpen) return undefined
    const result = this.index.results.get(key)
    return result === undefined ? undefined : jsonCopy(result)
  }

  /**
   * Marks a cache miss. A source entry with only `started` (crash during a call)
   * is a respawnable prefix: it stays reuse-eligible for later calls, matching
   * the "longest unchanged prefix" semantics. Returns the prior terminal
   * failure of this exact key, if any.
   */
  beginExecution(key: string): PriorFailure | undefined {
    if (!this.index.started.has(key)) this.reuseOpen = false
    return this.index.failures.get(key)
  }

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
}

export function newAgentId(): string {
  return randomUUID()
}
