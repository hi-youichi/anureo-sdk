/** Projects read-only native thread pages for discovery callers; it must not own connections or mutate threads. */
import { HarnessSdkError } from '@anureo/sdk'
import type { CodexJsonlClient } from './jsonl'
import { record, string } from './native-values'

/** One stored native thread as returned to discovery callers; optional subagent fields follow native metadata and carry no connection ownership. */
export type CodexThreadSummary = {
  /** Native thread identity. */
  id: string
  /** Thread status word from the native status object; unknown shapes fall back to notLoaded. */
  status: string
  /** Set only on spawn children; review and guardian threads never carry it. */
  parentThreadId?: string
  /** AgentControl nickname when the native page supplies it. */
  agentNickname?: string
  /** AgentControl role when the native page supplies it. */
  agentRole?: string
  /** Native preview text when supplied. */
  preview?: string
  /** Native display title when supplied. */
  title?: string
}
/** Relation-scoped query accepted by adapter thread discovery; parentThreadId and ancestorThreadId are mutually exclusive and both map to native relation filters. */
export type CodexThreadListParams = {
  /** Direct spawn children of this thread. */
  parentThreadId?: string
  /** Every spawn descendant of this thread at any depth, excluding the ancestor itself. */
  ancestorThreadId?: string
  /** Native source-kind words (subAgent, subAgentReview, ...); omitting them keeps the native default for relation queries. */
  sourceKinds?: string[]
  /** Working directories to scope the page to. */
  cwd?: string | string[]
  /** Opaque native page cursor. */
  cursor?: string
  /** Page size forwarded to the native reader. */
  limit?: number
}
/** One projected page; cursors are absent when the native page omits them. */
export type CodexThreadPage = { data: CodexThreadSummary[]; nextCursor?: string; backwardsCursor?: string }

/** Project one native page entry for the thread reader without mutation or I/O. Reject missing identities; omit invalid optional entries and keep the native status word. */
function decodeThread(entry: unknown): CodexThreadSummary {
  const thread = record(entry)
  const id = string(thread.id)
  if (!id) throw new HarnessSdkError('PROTOCOL_ERROR')
  return {
    id,
    status: string(record(thread.status).type) ?? 'notLoaded',
    ...(string(thread.parentThreadId) ? { parentThreadId: string(thread.parentThreadId) } : {}),
    ...(string(thread.agentNickname) ? { agentNickname: string(thread.agentNickname) } : {}),
    ...(string(thread.agentRole) ? { agentRole: string(thread.agentRole) } : {}),
    ...(string(thread.preview) ? { preview: string(thread.preview) } : {}),
    ...(string(thread.name) ? { title: string(thread.name) } : {}),
  }
}

/** For adapter discovery, read one relation-scoped page on an initialized client and enrich locally observed spawn metadata without overwriting native values. Reject malformed pages or transport errors; never create threads or dispose the caller's client. */
export async function readCodexThreads(client: CodexJsonlClient, params: CodexThreadListParams, enrich: (threadId: string) => { agentNickname?: string; agentRole?: string } | undefined): Promise<CodexThreadPage> {
  const page = record(await client.request('thread/list', {
    ...(params.parentThreadId ? { parentThreadId: params.parentThreadId } : {}),
    ...(params.ancestorThreadId ? { ancestorThreadId: params.ancestorThreadId } : {}),
    ...(params.sourceKinds?.length ? { sourceKinds: params.sourceKinds } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  }))
  if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
  const data = page.data.map(entry => {
    const summary = decodeThread(entry)
    const observed = enrich(summary.id)
    if (!observed) return summary
    return {
      ...summary,
      ...(summary.agentNickname === undefined && observed.agentNickname !== undefined ? { agentNickname: observed.agentNickname } : {}),
      ...(summary.agentRole === undefined && observed.agentRole !== undefined ? { agentRole: observed.agentRole } : {}),
    }
  })
  return {
    data,
    nextCursor: string(page.nextCursor),
    backwardsCursor: string(page.backwardsCursor),
  }
}
