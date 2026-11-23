import { randomUUID } from 'node:crypto'
import type { HistoryPage, Item, NativeRef } from '@anureo/protocol'
import type { HxSubagent } from './legacy-protocol'
import type { HarnessStore, SessionRecord } from './store'
import { HostError } from './errors'

export type StoredInlineSubagent = {
  summary: HxSubagent
  subagentId: string
  bindingGeneration: number
  assignments: Array<{ turnId: string; itemId: string }>
}

export type StoredSubagent = {
  summary: HxSubagent
  nativeRef: NativeRef
  parentNativeRef: NativeRef
  bindingGeneration: number
  runtimeConfigId: string
}

/** A reader must verify the direct native spawn edge and must not resume the thread. */
export type SubagentHistoryPort = (context: {
  parentNativeRef: NativeRef; nativeRef: NativeRef; cwd: string; cursor?: string; limit?: number
}) => Promise<HistoryPage>

export type SubagentDiscoveryPort = (context: { parentNativeRef: NativeRef; cwd: string }) => Promise<Array<{
  id: string; parentThreadId?: string; name?: string; task?: string
}>>

export function publicSubagents(record: SessionRecord, canRead: (runtimeConfigId: string) => boolean): HxSubagent[] {
  return [...(record.nativeSubagents ?? []).map(child => ({ ...child.summary, canOpen: canRead(child.runtimeConfigId) })), ...(record.inlineSubagents ?? []).map(child => ({ ...child.summary, canOpen: true }))]
}

/** Register a sanitized structured identity, scoped to the parent's binding generation. */
export function registerSubagent(store: HarnessStore, record: SessionRecord, item: Extract<Item, { type: 'subagent' }>, canOpen: boolean, parentTurnId?: string, preserveLifecycle = false): { item: Item; summary?: HxSubagent; changed: boolean } {
  const { coworkSubagent: _untrusted, ...extensions } = item.extensions ?? {}
  const parentNativeRef = record.binding.nativeRef
  if (!parentNativeRef && record.capabilities?.subagents?.events === 'nested' && !item.parentItemId && parentTurnId) {
    const children = record.inlineSubagents ?? []
    const generation = record.bindingGeneration ?? 1
    const previous = children.find(child => child.subagentId === item.subagentId && child.bindingGeneration === generation)
    const now = Date.now()
    const summary: HxSubagent = {
      ...(previous?.summary ?? { sessionId: randomUUID(), parentSessionId: record.id, createdAt: now }),
      parentTurnId,
      name: item.name || previous?.summary.name || '', task: item.task ?? previous?.summary.task,
      status: preserveLifecycle && previous ? previous.summary.status : item.state === 'pending' ? 'running' : item.state,
      canOpen: true, updatedAt: previous?.summary.updatedAt ?? now,
    }
    const assignments = previous?.assignments ?? []
    const known = assignments.some(assignment => assignment.turnId === parentTurnId && assignment.itemId === item.id)
    const changed = !previous || !known || JSON.stringify(summary) !== JSON.stringify(previous.summary)
    if (changed) {
      summary.updatedAt = now
      const child: StoredInlineSubagent = { summary, subagentId: item.subagentId, bindingGeneration: generation, assignments: known ? assignments : [...assignments, { turnId: parentTurnId, itemId: item.id }] }
      record.inlineSubagents = [...children.filter(candidate => candidate !== previous), child]
      store.saveSession(record)
    }
    return { item: { ...item, extensions: { ...extensions, coworkSubagent: { ...summary } } }, summary, changed }
  }
  if (!parentNativeRef || item.subagentId === parentNativeRef.value) return { item: { ...item, extensions }, changed: false }
  const children = record.nativeSubagents ?? []
  const bindingGeneration = record.bindingGeneration ?? 1
  const existing = children.find(child => child.bindingGeneration === bindingGeneration && child.runtimeConfigId === record.runtimeConfigId && child.nativeRef.provider === parentNativeRef.provider && child.nativeRef.value === item.subagentId)
  const now = Date.now()
  const summary: HxSubagent = {
    ...(existing?.summary ?? { sessionId: randomUUID(), parentSessionId: record.id, createdAt: now }),
    name: item.name || existing?.summary.name || '',
    ...(parentTurnId && !existing?.summary.parentTurnId ? { parentTurnId } : {}),
    ...(item.task !== undefined ? { task: item.task } : {}),
    // Historical spawn records and repeated discovery cannot rewind a later live state.
    status: preserveLifecycle && existing ? existing.summary.status : item.state === 'pending' ? 'running' : item.state,
    canOpen, updatedAt: existing?.summary.updatedAt ?? now,
  }
  const changed = !existing || JSON.stringify(summary) !== JSON.stringify(existing.summary)
  if (changed) {
    summary.updatedAt = now
    const child: StoredSubagent = { summary, nativeRef: { provider: parentNativeRef.provider, value: item.subagentId }, parentNativeRef, bindingGeneration, runtimeConfigId: record.runtimeConfigId }
    record.nativeSubagents = [...children.filter(candidate => candidate !== existing), child]
    store.saveSession(record)
  }
  return { item: { ...item, extensions: { ...extensions, coworkSubagent: { ...summary } } }, summary, changed }
}

/** Read member evidence from the parent's durable nested items, without opening a native thread. */
export interface SubagentTurn {
  id: string
  items: readonly { item: Item }[]
}

export function inlineSubagentHistory(turns: readonly SubagentTurn[], child: StoredInlineSubagent, cursor?: string, limit = 50): HistoryPage {
  const items: HistoryPage['items'] = []
  for (const turn of turns) {
    const roots = new Set(child.assignments.filter(assignment => assignment.turnId === turn.id).map(assignment => assignment.itemId))
    if (!roots.size) continue
    const owned = new Set(roots)
    let changed = true
    while (changed) {
      changed = false
      for (const { item } of turn.items) if (item.parentItemId && owned.has(item.parentItemId) && !owned.has(item.id)) { owned.add(item.id); changed = true }
    }
    for (const { item } of turn.items) {
      if (!owned.has(item.id) || roots.has(item.id)) continue
      const copy = { ...item }
      if (copy.parentItemId && roots.has(copy.parentItemId)) delete copy.parentItemId
      items.push({ turnId: turn.id, item: copy })
    }
  }
  if (cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(cursor)) throw new HostError('CURSOR_INVALID')
  const end = cursor === undefined ? items.length : Number(cursor)
  if (!Number.isSafeInteger(end) || end < 0 || end > items.length) throw new HostError('CURSOR_INVALID')
  const start = Math.max(0, end - limit)
  return { items: items.slice(start, end), nextCursor: start > 0 ? String(start) : null }
}
