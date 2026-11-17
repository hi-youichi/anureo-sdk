import { randomUUID } from 'node:crypto'
import { HarnessSdkError, type TurnResult } from '@anureo/sdk'
import { preview, type ResultDescriptor } from '../results'
import { ChangeSignal } from './change-signal'

export interface SwarmMailboxOptions { maxNotices?: number; maxBytes?: number }
export interface CompletionNotice {
  seq: number; messageId: string; taskId: string; attemptId: string; beeId: string; outerTurnId: string
  kind: 'task.completed' | 'task.failed' | 'task.interrupted'
  resultRef: string; preview: string; previewTruncated: boolean; outcomeUnknown: boolean
}

const slotBytes = 4096

/** Non-consuming completion history with capacity reserved before accepting each task. */
export class CompletionMailbox {
  private readonly changes = new ChangeSignal()
  private readonly notices: CompletionNotice[] = []
  private readonly reserved = new Set<string>()
  private turnId?: string
  private highest = 0
  private waiters = 0
  private readonly limits: Required<SwarmMailboxOptions>

  constructor(options: SwarmMailboxOptions = {}) {
    this.limits = { maxNotices: options.maxNotices ?? 256, maxBytes: options.maxBytes ?? 1024 * 1024 }
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new HarnessSdkError('SWARM_INVALID_MAILBOX_LIMITS')
    if (this.limits.maxBytes < slotBytes) throw new HarnessSdkError('SWARM_INVALID_MAILBOX_LIMITS')
  }

  begin(turnId: string) { this.turnId = turnId }

  reserve(taskId: string) {
    const capacity = Math.min(this.limits.maxNotices, Math.floor(this.limits.maxBytes / slotBytes))
    while (this.notices.length + this.reserved.size >= capacity && this.notices[0]?.outerTurnId !== this.turnId && this.notices.length) this.notices.shift()
    if (this.notices.length + this.reserved.size >= capacity) throw new HarnessSdkError('SWARM_MAILBOX_FULL')
    this.reserved.add(taskId)
  }

  rollback(taskId: string) { this.reserved.delete(taskId) }

  publish(task: { id: string; attemptId: string; beeId: string; turnId: string }, result: ResultDescriptor, outcome: TurnResult) {
    if (!this.reserved.has(task.id)) throw new HarnessSdkError('SWARM_MAILBOX_RESERVATION_MISSING')
    if (this.highest === Number.MAX_SAFE_INTEGER) throw new HarnessSdkError('SWARM_MAILBOX_SEQUENCE_EXHAUSTED')
    const short = preview(result.preview, 1024)
    const notice: CompletionNotice = {
      seq: this.highest + 1, messageId: randomUUID(), taskId: task.id, attemptId: task.attemptId,
      beeId: task.beeId, outerTurnId: task.turnId,
      kind: outcome.status === 'completed' ? 'task.completed' : outcome.status === 'failed' ? 'task.failed' : 'task.interrupted',
      resultRef: result.resultRef, preview: short.text, previewTruncated: short.truncated || result.previewTruncated,
      outcomeUnknown: outcome.status !== 'completed' && outcome.error?.outcomeUnknown === true,
    }
    while (Buffer.byteLength(JSON.stringify(notice)) > slotBytes) {
      if (!notice.preview) throw new HarnessSdkError('SWARM_MAILBOX_METADATA_TOO_LARGE')
      notice.preview = preview(notice.preview, Math.floor(Buffer.byteLength(notice.preview) / 2)).text
      notice.previewTruncated = true
    }
    this.reserved.delete(task.id)
    this.highest = notice.seq
    this.notices.push(notice)
    this.changes.touch()
  }

  page(after: number | undefined, limit: number) {
    const firstCursor = (this.notices[0]?.seq ?? this.highest + 1) - 1
    const position = after ?? firstCursor
    if (!Number.isSafeInteger(position) || position < 0 || position > this.highest) throw new HarnessSdkError('SWARM_INVALID_CURSOR')
    if (position < firstCursor) throw new HarnessSdkError('SWARM_MAILBOX_CURSOR_EXPIRED', `SWARM_MAILBOX_CURSOR_EXPIRED: firstAvailableCursor=${firstCursor}`)
    const available = this.notices.filter(notice => notice.seq > position)
    const notices: CompletionNotice[] = []
    let bytes = 0
    for (const notice of available.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(notice))
      if (bytes + size > 60 * 1024) break
      bytes += size
      notices.push(structuredClone(notice))
    }
    return { notices, nextCursor: notices.at(-1)?.seq ?? position, hasMore: available.length > notices.length, timedOut: false }
  }

  async receive(after: number | undefined, limit: number, timeoutMs: number, signal?: AbortSignal) {
    if (this.waiters >= 16) throw new HarnessSdkError('SWARM_WAITER_LIMIT')
    this.waiters++
    const deadline = performance.now() + timeoutMs
    try {
      while (true) {
        if (signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED')
        const version = this.changes.current()
        const page = this.page(after, limit)
        const remaining = Math.max(0, deadline - performance.now())
        if (page.notices.length || !remaining) return { ...page, timedOut: !page.notices.length }
        // Preserve the initial position across awaits, including an initially empty mailbox.
        after = page.nextCursor
        await this.changes.waitAfter(version, remaining, signal)
      }
    } finally { this.waiters-- }
  }

  close() { this.changes.close() }
}
