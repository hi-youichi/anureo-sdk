/** Projects native item snapshots and exposes the mapping helpers available through the package's mapping subpath. */
import { codexFileChanges } from './file-changes'
import type { InputBlock, Item } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import { safe, record, string, type NativeRecord } from './native-values'
export { json, safe } from './native-values'
export { nativeInput } from './input'
export { mapUsage } from './usage'
export { mapTurnError } from './turn-error'

/** Normalize a native item status; completed is envelope evidence used only when the status is unrecognized. Explicit native statuses take precedence. */
export function itemStatus(value: unknown, completed: boolean): 'running' | 'completed' | 'failed' | 'declined' | 'interrupted' {
  switch (value) {
    case 'inProgress': case 'in_progress': case 'running': case 'pending': return 'running'
    case 'failed': case 'errored': return 'failed'
    case 'declined': case 'denied': return 'declined'
    case 'interrupted': case 'cancelled': case 'closed': return 'interrupted'
    case 'completed': return 'completed'
    default: return completed ? 'completed' : 'running'
  }
}

/**
 * Convert one native snapshot to AHP items without I/O or retained state. Collaboration snapshots
 * expand in receiver order (or state-key order) and may produce no items; unknown kinds become
 * sanitized tool calls. A nonempty string id is required, otherwise this throws PROTOCOL_ERROR.
 * JSON hooks run during sanitization, and serialization/redaction failures propagate.
 *
 * completed supplies fallback item status and determines plan-step completion. history defaults to
 * false; when true, an undefined native status stays absent despite completed envelope evidence.
 * timing.startedAtMs is in epoch milliseconds: null/undefined fall back to native time, while an
 * invalid non-nullish override suppresses it. This does not reconcile timestamps across snapshots.
 *
 * CodexBackendSession.projectItem publishes these items as live events; historyEntryItems wraps
 * them in history envelopes. Both propagate projection failures. Callers own event ordering,
 * snapshot retention and timing reconciliation.
 */
export function mapItems(value: unknown, completed: boolean, history = false, timing: { startedAtMs?: unknown } = {}): Item[] {
  const raw = record(value)
  const id = string(raw.id)
  if (!id) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native item lacks identity')
  const status = itemStatus(raw.status, completed)
  const common = itemMetadata(raw, { id, status, history, timing })
  switch (raw.type) {
    case 'userMessage': return [{
      ...common,
      type: 'userMessage',
      content: (Array.isArray(raw.content) ? raw.content : []).map(userContentBlock),
    }]
    case 'agentMessage': return [{
      ...common,
      type: 'agentMessage',
      text: string(raw.text) ?? '',
      phase: raw.phase === 'commentary' ? 'commentary' : 'final',
    }]
    case 'reasoning': return [{
      ...common,
      type: 'reasoning',
      text: reasoningText(raw.content),
      summary: reasoningText(raw.summary),
    }]
    case 'plan': return [{
      ...common,
      type: 'plan',
      steps: [{ id: `${id}:text`, text: string(raw.text) ?? '', status: completed ? 'completed' : 'inProgress' }],
    }]
    case 'collabAgentToolCall': case 'collabToolCall': return subagentItems(raw, { common, status })
    case 'enteredReviewMode': case 'exitedReviewMode': return [{
      ...common,
      type: 'review',
      state: raw.type === 'enteredReviewMode' ? 'entered' : 'exited',
      text: string(raw.review) ?? '',
    }]
    case 'contextCompaction': return [{ ...common, type: 'compaction', summary: string(raw.summary) ?? '' }]
    case 'hook': case 'hookPrompt': return [{
      ...common,
      type: 'hook',
      name: string(raw.name) ?? 'hook',
      output: safe(raw.output ?? raw.fragments),
    }]
    case 'commandExecution': return [{
      ...common,
      type: 'toolCall',
      kind: 'command',
      title: string(raw.command) ?? 'Command',
      input: safe({ command: raw.command, cwd: raw.cwd }),
      output: safe(raw.aggregatedOutput ?? raw.output),
    }]
    case 'fileChange': return [{
      ...common,
      type: 'toolCall',
      kind: 'fileChange',
      title: 'File changes',
      fileChanges: codexFileChanges(raw.changes),
      input: safe(raw.changes),
      output: safe(raw.output),
      locations: fileChangeLocations(raw.changes),
    }]
    case 'mcpToolCall': {
      const server = string(raw.server) ?? 'mcp'
      const tool = string(raw.tool) ?? 'tool'
      return [{
        ...common,
        type: 'toolCall',
        kind: 'mcp',
        mcp: { server, tool },
        title: `${server}/${tool}`,
        input: safe(raw.arguments),
        output: safe(raw.result ?? raw.error),
      }]
    }
    case 'dynamicToolCall': {
      const tool = string(raw.tool)
      return [{
        ...common,
        type: 'toolCall',
        kind: 'dynamic',
        ...(tool ? { toolName: tool } : {}),
        title: tool ?? 'Dynamic tool',
        input: safe(raw.arguments),
        output: safe(raw.contentItems ?? raw.result),
      }]
    }
    case 'webSearch': return [{
      ...common,
      type: 'toolCall',
      kind: 'web',
      title: string(raw.query) ?? 'Web search',
      input: safe(raw.action),
      output: safe(raw.results),
    }]
    case 'imageGeneration': case 'imageView': return [imageItem(raw, common, raw.type)]
    default: return [{
      ...common,
      type: 'toolCall',
      kind: 'other',
      title: string(raw.type) ?? 'Unknown native item',
      nativeType: string(raw.type) ?? 'unknown',
      raw: safe(raw),
    }]
  }
}

/** Project state for subagentItems without effects; this vocabulary deliberately leaves declined and cancelled running, unlike itemStatus. */
function subagentState(value: string): 'running' | 'completed' | 'failed' | 'interrupted' {
  switch (value) {
    case 'completed': return 'completed'
    case 'errored': case 'failed': return 'failed'
    case 'closed': case 'interrupted': return 'interrupted'
    default: return 'running'
  }
}

/** Shared fields for every item emitted from one native snapshot; history may lack status. */
type ItemMetadata = Pick<Item, 'id' | 'status' | 'startedAt' | 'durationMs'>

/** Build mapItems metadata without mutation. A non-nullish timing override wins even when invalid; only valid nonnegative epoch milliseconds become an ISO start time. History omits status only when the native field is undefined; numeric durationMs passes through unchanged. */
function itemMetadata(raw: NativeRecord, options: {
  id: string
  status: ReturnType<typeof itemStatus>
  history: boolean
  timing: { startedAtMs?: unknown }
}): ItemMetadata {
  const startedAtMs = options.timing.startedAtMs ?? raw.startedAtMs
  const date = typeof startedAtMs === 'number' && startedAtMs >= 0 ? new Date(startedAtMs) : undefined
  const startedAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  return {
    id: options.id,
    ...(!options.history || raw.status !== undefined ? { status: options.status } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
  }
}

/** Project a user-message block for mapItems without effects; unsupported blocks retain their position using a visible text placeholder. Local paths remain native paths. */
function userContentBlock(value: unknown): InputBlock {
  const block = record(value)
  if (block.type === 'text') return { type: 'text', text: string(block.text) ?? '' }
  if (block.type === 'image' && typeof block.url === 'string') return { type: 'image', url: block.url }
  if (block.type === 'localImage' && typeof block.path === 'string') return { type: 'file', uri: block.path }
  return { type: 'text', text: '[unsupported native input]' }
}

/** Read reasoning text or summary for mapItems without coercion or effects; non-string fragments are omitted while native string order and line breaks survive. */
function reasoningText(value: unknown): string {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : ''
}

/** Expand mapItems collaboration snapshots without mutation. A nonempty list of string receivers wins over state keys and preserves order and duplicates; receiver IDs are scoped to the parent item. */
function subagentItems(raw: NativeRecord, context: { common: ItemMetadata; status: ReturnType<typeof itemStatus> }): Item[] {
  const ids = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.filter((v): v is string => typeof v === 'string') : []
  const states = record(raw.agentsStates)
  return (ids.length ? ids : Object.keys(states)).map(
    /** Project one receiver using status, then legacy state, then the normalized parent status; no mutation or I/O. */
    subagentId => {
      const state = record(states[subagentId])
      const nativeState = string(state.status) ?? string(state.state) ?? context.status
      return {
        ...context.common,
        id: `${context.common.id}:${subagentId}`,
        parentItemId: context.common.id,
        type: 'subagent',
        subagentId,
        state: subagentState(nativeState),
        ...(typeof raw.prompt === 'string' ? { task: raw.prompt } : {}),
      }
    },
  )
}

/** Project an image branch for mapItems; a nonempty fileId suppresses inline generated data and viewed images never acquire it. The first non-nullish savedPath/path is used only if it is a nonempty string. JSON hook and serialization errors propagate during sanitization; no I/O. */
function imageItem(raw: NativeRecord, common: ItemMetadata, nativeType: 'imageGeneration' | 'imageView'): Item {
  const generated = nativeType === 'imageGeneration'
  const fileId = string(raw.fileId)
  const imagePath = string(raw.savedPath ?? raw.path)
  const revisedPrompt = string(raw.revisedPrompt)
  const data = generated && !fileId ? string(raw.result) : undefined
  return {
    ...common,
    type: 'toolCall',
    kind: 'image',
    nativeType,
    title: 'Image',
    input: safe(raw.prompt),
    image: {
      kind: generated ? 'generated' : 'view',
      ...(data ? { data, mimeType: 'image/png' } : {}),
      ...(fileId ? { fileId } : {}),
      ...(imagePath ? { path: imagePath } : {}),
      ...(revisedPrompt ? { revisedPrompt } : {}),
    },
    ...(raw.failure ? { output: safe({ failure: raw.failure }) } : {}),
  }
}

/** Collect native source locations for mapItems without effects; renamed destinations belong to fileChanges, while locations retain each supplied source path in order. */
function fileChangeLocations(changes: unknown): { path: string }[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap(
    /** Ignore malformed locations without inventing a path or consulting the filesystem. */
    value => {
      const change = record(value)
      return typeof change.path === 'string' ? [{ path: change.path }] : []
    },
  )
}
