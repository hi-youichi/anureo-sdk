/** Read a spawned thread without resuming it or taking ownership of its execution. */
import { HarnessSdkError } from '@anureo/sdk'
import { spawnHarnessProcess } from '@anureo/sdk/process'
import type { HistoryItem, HistoryPage } from '@anureo/protocol'
import { CodexJsonlClient, CodexRpcError } from './jsonl'
import { record, string } from './native-values'
import { mapItems } from './mapping'
import type { CodexAdapterOptions } from './options'

/** Host-authorized direct spawn edge. Neither identity may come from an untrusted display title. */
export type CodexSubagentHistoryParams = {
  parentThreadId: string
  threadId: string
  cursor?: string
  limit?: number
}

/** Read-only history, in chronological order within each page. The next cursor reads older items. */
export type CodexSubagentHistory = {
  history: HistoryPage
  metadata: { name?: string; role?: string; canAcceptDirectInput?: boolean }
}

/**
 * Query a direct child's persisted items on an independent, short-lived connection.
 * Revalidate the spawn edge before reading any content. Uses thread/read and
 * thread/items/list only; it never starts, resumes, interrupts, or answers a thread.
 * Unsupported native readers reject CAPABILITY_UNSUPPORTED. Always release the probe.
 */
export async function readCodexSubagentHistory(options: CodexAdapterOptions & { maxPageBytes?: number }, params: CodexSubagentHistoryParams): Promise<CodexSubagentHistory> {
  const { parentThreadId, threadId } = params
  const limit = params.limit ?? 50
  if (!parentThreadId || !threadId || parentThreadId === threadId || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new HarnessSdkError('INVALID_PARAMS')
  }
  let nativeCursor: string | undefined
  if (params.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'))
      if (cursor.parent !== parentThreadId || cursor.child !== threadId || typeof cursor.cursor !== 'string' || !cursor.cursor) throw new Error()
      nativeCursor = cursor.cursor
    } catch { throw new HarnessSdkError('CURSOR_INVALID') }
  }
  const process = await (options.processFactory ?? spawnHarnessProcess)({
    command: options.command, args: options.args ?? ['app-server'], cwd: options.cwd, env: options.env, owned: true,
  })
  const client = new CodexJsonlClient(process, {
    notification: async () => {},
    request: async (_request, _reply, reject) => { await reject(-32601, 'Subagent history is read-only') },
    failure: async () => {},
    diagnostic: options.diagnostic,
  }, options)
  try {
    await client.request('initialize', { clientInfo: { name: 'anureo-subagent-history', version: '1' }, capabilities: { experimentalApi: true } })
    await client.notify('initialized')
    const thread = record(record(await client.request('thread/read', { threadId, includeTurns: false })).thread)
    if (thread.id !== threadId || thread.parentThreadId !== parentThreadId) throw new HarnessSdkError('SUBAGENT_RELATION_MISMATCH')
    const page = record(await client.request('thread/items/list', {
      threadId, sortDirection: 'desc', limit, ...(nativeCursor ? { cursor: nativeCursor } : {}),
    }))
    if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
    const items: HistoryItem[] = []
    for (const entry of [...page.data].reverse()) {
      const native = record(entry), turnId = string(native.turnId)
      if (!turnId) throw new HarnessSdkError('PROTOCOL_ERROR')
      for (const item of mapItems(native.item, true, false, { startedAtMs: native.startedAtMs })) {
        items.push({ turnId, item, nativeTurnId: turnId, nativeItemId: item.id })
      }
    }
    // Bound the public response independently of the native frame limit.
    if (Buffer.byteLength(JSON.stringify(items)) > (options.maxPageBytes ?? 4 * 1024 * 1024)) throw new HarnessSdkError('HISTORY_LIMIT_EXCEEDED')
    const next = string(page.nextCursor)
    if (next && next === nativeCursor) throw new HarnessSdkError('PROTOCOL_ERROR')
    return {
      history: { items, nextCursor: next ? Buffer.from(JSON.stringify({ parent: parentThreadId, child: threadId, cursor: next })).toString('base64url') : null },
      metadata: {
        ...(string(thread.agentNickname) ? { name: string(thread.agentNickname) } : {}),
        ...(string(thread.agentRole) ? { role: string(thread.agentRole) } : {}),
        ...(typeof thread.canAcceptDirectInput === 'boolean' ? { canAcceptDirectInput: thread.canAcceptDirectInput } : {}),
      },
    }
  } catch (cause) {
    if (cause instanceof CodexRpcError && cause.rpcCode === -32601) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    throw cause
  } finally { await client.dispose() }
}
