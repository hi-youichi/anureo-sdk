/** Projects native item snapshots and exposes the mapping helpers available through the package's mapping subpath. */
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { codexFileChanges } from './file-changes'
import type { InputBlock, Item, JsonObject } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import { record, safe, string, type NativeRecord } from './native-values'
import { toolExtensions } from './tool-metadata'

export { json, safe } from './native-values'
export { nativeInput } from './input'
export { mapUsage } from './usage'
export { mapTurnError } from './turn-error'

/** Normalize a native item status. Use the envelope's completion flag only for missing or unrecognized statuses. */
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
 * Convert one native snapshot to AHP items. Collaboration snapshots expand in receiver order,
 * falling back to state-key order, and may produce no items. Unknown kinds become tool calls
 * with sanitized native payloads. A missing, non-string, or empty id throws PROTOCOL_ERROR.
 * Sanitization can invoke JSON hooks and propagate serialization or redaction errors.
 *
 * Pass completed to supply fallback item status and determine plan-step completion. Set history
 * to true to omit status when the native field is undefined. For live items, the default is false.
 * Supply timing.startedAtMs in epoch milliseconds. Null or undefined uses the native timestamp,
 * and any other invalid override omits the start time.
 *
 * CodexBackendSession.projectItem reconciles start times and publishes these items in order.
 * CodexBackendSession.historyEntryItems wraps them for history reads. A projection failure
 * rejects a history read or reaches JSONL stream failure handling for live notifications.
 * Callers own ordering across snapshots.
 */

/** Project subAgentActivity lifecycle kinds for mapItems without effects; unknown words keep the child observable as running. */
function subAgentActivityState(value: unknown): 'running' | 'completed' | 'interrupted' {
  switch (value) {
    case 'completed': return 'completed'
    case 'interrupted': return 'interrupted'
    default: return 'running'
  }
}

/** Collect sanitized raw evidence for subagent projections without mutation or I/O; absent fields stay absent, and redaction failures propagate from safe(). */
function nativeSubagentEvidence(raw: NativeRecord, state: NativeRecord, nativeState: string | undefined): JsonObject | undefined {
  const evidence: Record<string, unknown> = {}
  for (const key of ['tool', 'model', 'reasoningEffort', 'senderThreadId']) {
    const value = string(raw[key])
    if (value !== undefined) evidence[key] = value
  }
  const kind = string(raw.kind)
  const agentPath = string(raw.agentPath)
  if (kind !== undefined) evidence.kind = kind
  if (agentPath !== undefined) evidence.agentPath = agentPath
  const message = string(state.message)
  if (message !== undefined && nativeState === 'errored') evidence.errorMessage = message
  if (message !== undefined && nativeState === 'completed') evidence.resultMessage = message
  return Object.keys(evidence).length ? safe(evidence) as JsonObject : undefined
}

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
    case 'subAgentActivity': {
      const agentThreadId = string(raw.agentThreadId)
      if (!agentThreadId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native subagent activity lacks agent identity')
      const agentPath = string(raw.agentPath)
      const evidence = nativeSubagentEvidence(raw, {}, undefined)
      return [{
        ...common,
        type: 'subagent',
        subagentId: agentThreadId,
        state: subAgentActivityState(raw.kind),
        ...(agentPath ? { name: agentPath.slice(agentPath.lastIndexOf('/') + 1) || agentPath } : {}),
        ...(evidence ? { extensions: { native: evidence } } : {}),
      }]
    }
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
      ...toolExtensions(raw),
      type: 'toolCall',
      kind: 'command',
      title: string(raw.command) ?? 'Command',
      input: safe({ command: raw.command, cwd: raw.cwd }),
      output: safe(raw.aggregatedOutput ?? raw.output),
    }]
    case 'fileChange': return [fileChangeItem(raw, common)]
    case 'mcpToolCall': return [mcpToolItem(raw, common)]
    case 'dynamicToolCall': return [dynamicToolItem(raw, common)]
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

/** Fields shared by items expanded from the same native snapshot. History items may omit status. */
type ItemMetadata = Pick<Item, 'id' | 'status' | 'startedAt' | 'durationMs'>

/**
 * Build metadata shared by mapItems projections. A non-nullish override selects the start
 * timestamp even if invalid. Nonnegative epoch milliseconds within the Date range produce an ISO string.
 * History omits status only for an undefined native field, and numeric durationMs passes through.
 */
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

/** Keep each user-message block in position, using text placeholders for unsupported blocks and native paths for local images. */
function userContentBlock(value: unknown): InputBlock {
  const block = record(value)
  if (block.type === 'text') return { type: 'text', text: string(block.text) ?? '' }
  if (block.type === 'image' && typeof block.url === 'string') return { type: 'image', url: block.url }
  if (block.type === 'localImage' && typeof block.path === 'string') return { type: 'file', uri: block.path }
  if (block.type === 'mention' && typeof block.path === 'string' && isAbsolute(block.path)) {
    return { type: 'file', uri: pathToFileURL(block.path).href, name: string(block.name) }
  }
  return { type: 'text', text: '[unsupported native input]' }
}

/** Join reasoning fragments in native order with newline separators, skipping non-string values. */
function reasoningText(value: unknown): string {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : ''
}

/**
 * Expand collaboration items in receiver order, preserving duplicate string IDs. When there
 * are no string receivers, use state keys. Scope each item ID to the parent snapshot.
 */
function subagentItems(raw: NativeRecord, context: { common: ItemMetadata; status: ReturnType<typeof itemStatus> }): Item[] {
  const explicitIds = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.filter((v): v is string => typeof v === 'string') : []
  // Documented legacy wire words (singular receiver plus created thread) tolerate older schema shapes.
  const legacyIds = [raw.receiverThreadId, raw.newThreadId].filter((v): v is string => typeof v === 'string').filter((v, index, all) => all.indexOf(v) === index)
  const states = record(raw.agentsStates)
  const legacyStatus = string(raw.agentStatus)
  return (explicitIds.length ? explicitIds : legacyIds.length ? legacyIds : Object.keys(states)).map(
    /** Project one receiver using per-agent status, then legacy state, then singular legacy status, then envelope evidence; no mutation or I/O. */
    subagentId => {
      const state = record(states[subagentId])
      const nativeState = string(state.status) ?? string(state.state) ?? legacyStatus ?? context.status
      const evidence = nativeSubagentEvidence(raw, state, nativeState)
      return {
        ...context.common,
        id: `${context.common.id}:${subagentId}`,
        parentItemId: context.common.id,
        type: 'subagent',
        subagentId,
        state: subagentState(nativeState),
        ...(typeof raw.prompt === 'string' ? { task: raw.prompt } : {}),
        ...(evidence ? { extensions: { native: evidence } } : {}),
      }
    },
  )
}

/** Use the collaboration state vocabulary. Unrecognized states, including declined and cancelled, map to running. */
function subagentState(value: string): 'running' | 'completed' | 'failed' | 'interrupted' {
  switch (value) {
    case 'completed': return 'completed'
    case 'errored': case 'failed': return 'failed'
    case 'closed': case 'interrupted': return 'interrupted'
    default: return 'running'
  }
}

/**
 * Return a file-change tool item with structured patch evidence and source locations.
 * Read the evidence before sanitization invokes JSON hooks and the locations after sanitizing the
 * tool input and output. Serialization and redaction errors propagate to mapItems.
 */
function fileChangeItem(raw: NativeRecord, common: ItemMetadata): Item {
  return {
    ...common,
    ...toolExtensions(raw),
    type: 'toolCall',
    kind: 'fileChange',
    title: 'File changes',
    fileChanges: codexFileChanges(raw.changes),
    input: safe(raw.changes),
    output: safe(raw.output),
    locations: fileChangeLocations(raw.changes),
  }
}

/** Collect locations in native order, including the source path of a rename. */
function fileChangeLocations(changes: unknown): { path: string }[] {
  if (!Array.isArray(changes)) return []
  return changes.flatMap(value => {
    const change = record(value)
    return typeof change.path === 'string' ? [{ path: change.path }] : []
  })
}

/**
 * Return an MCP tool item with a server-qualified title, preserving explicit empty names.
 * Use the native error as output when the result is nullish. JSON projection errors propagate.
 */
function mcpToolItem(raw: NativeRecord, common: ItemMetadata): Item {
  const server = string(raw.server) ?? 'mcp'
  const tool = string(raw.tool) ?? 'tool'
  return {
    ...common,
    ...toolExtensions(raw),
    type: 'toolCall',
    kind: 'mcp',
    mcp: { server, tool },
    title: `${server}/${tool}`,
    input: safe(raw.arguments),
    output: safe(raw.result ?? raw.error),
  }
}

/**
 * Return a dynamic tool item with an optional nonempty toolName and a title that preserves
 * an explicit empty name. Prefer supplied content items to the result. JSON projection errors propagate.
 */
function dynamicToolItem(raw: NativeRecord, common: ItemMetadata): Item {
  const tool = string(raw.tool)
  return {
    ...common,
    ...toolExtensions(raw),
    type: 'toolCall',
    kind: 'dynamic',
    ...(tool ? { toolName: tool } : {}),
    title: tool ?? 'Dynamic tool',
    input: safe(raw.arguments),
    output: safe(raw.contentItems ?? raw.result),
  }
}

/**
 * Return image metadata. Only generation can include inline PNG data, and a nonempty fileId
 * takes precedence. Use a nonempty path from the first non-nullish savedPath or path value.
 * JSON projection errors propagate when sanitizing the prompt or failure.
 */
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
