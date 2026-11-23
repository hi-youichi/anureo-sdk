import type { Item, JsonObject, SubagentItem } from '@anureo/protocol'

/** Recover only the structured native fallback emitted by older Codex adapters. */
export function nativeSubagentActivity(item: Item): SubagentItem | undefined {
  if (item.type !== 'toolCall' || item.kind !== 'other' || item.nativeType !== 'subAgentActivity') return
  const raw = item.raw
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.type !== 'subAgentActivity'
    || raw.id !== item.id || typeof raw.agentThreadId !== 'string' || !raw.agentThreadId) return
  const name = typeof raw.agentPath === 'string' ? raw.agentPath.split('/').filter(Boolean).at(-1) : undefined
  const evidence: JsonObject = {}
  for (const key of ['kind', 'agentPath', 'model', 'reasoningEffort']) if (typeof raw[key] === 'string') evidence[key] = raw[key]
  return {
    id: item.id, type: 'subagent', subagentId: raw.agentThreadId,
    ...(item.status ? { status: item.status } : {}), ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    state: raw.kind === 'completed' ? 'completed' : raw.kind === 'interrupted' ? 'interrupted' : 'running',
    ...(name ? { name } : {}), extensions: { ...item.extensions, native: evidence },
  }
}
