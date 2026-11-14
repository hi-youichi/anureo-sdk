import type { FileChange, HarnessError, HistoryItem, InputBlock, Item, JsonValue, Usage } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import type { PiHostContent, PiHostEntry, PiHostImage, PiHostMessage } from './host'

/**
 * Create the adapter's content redactor from a captured list of literal secrets, longest first.
 * Empty secrets are ignored. JSON conversion redacts string values, leaves keys intact, omits
 * undefined object properties and replaces unsupported values or containers beyond depth 24 with null.
 */
export function createRedactor(secrets: readonly string[] = []): { text(value: string): string; json(value: unknown): JsonValue } {
  const values = [...new Set(secrets.filter(secret => secret.length > 0))].sort((a, b) => b.length - a.length)
  const text = (value: string) => values.reduce((out, secret) => out.split(secret).join('[REDACTED]'), value)
  /** Bound container traversal so cyclic or excessively nested input cannot recurse indefinitely. */
  const walk = (value: unknown, depth: number): JsonValue => {
    if (typeof value === 'string') return text(value)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (depth > 24) return null
    if (Array.isArray(value)) return value.map(entry => walk(entry, depth + 1))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, walk(entry, depth + 1)]))
    return null
  }
  return { text, json: value => walk(value, 0) }
}
/** Text and JSON conversion shared by live item publication and history reconstruction. */
export type Redactor = ReturnType<typeof createRedactor>

/** Built-in tool allowlist for read-only sessions; this does not isolate the host process. */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const
/** Built-in tool allowlist for agent-full-access sessions. */
export const FULL_ACCESS_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const
/** Permission values advertised by the adapter's configuration schema. */
export const PERMISSION_MODES = ['read-only', 'agent-full-access'] as const
/** Supported tool-allowlist policy, with no approval interaction. */
export type PiPermissionMode = typeof PERMISSION_MODES[number]
/** Return a fresh allowlist, or undefined to retain native defaults; unsupported values throw INVALID_PARAMS. */
export function permissionTools(mode: unknown): string[] | undefined {
  if (mode === undefined) return undefined
  if (mode === 'read-only') return [...READ_ONLY_TOOLS]
  if (mode === 'agent-full-access') return [...FULL_ACCESS_TOOLS]
  throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Pi permission mode')
}

/** Classify Pi tool names for live and historical AHP items; unrecognized names remain other. */
export function toolKind(name: string): ToolCallItem['kind'] {
  if (name === 'bash' || name === 'powershell') return 'command'
  if (name === 'edit' || name === 'write') return 'fileChange'
  if (name.startsWith('mcp__')) return 'mcp'
  return 'other'
}

/**
 * Describe file-change evidence from arguments, without reading disk or claiming execution succeeded.
 * Non-file tools return undefined; missing paths return an empty list. Only write supplies whole-file
 * text, with unknown operation; edit completeness describes supplied fragments, not the entire file.
 */
export function piFileChanges(name: string, args: unknown): FileChange[] | undefined {
  if (name !== 'edit' && name !== 'write') return undefined
  const input = record(args)
  const path = str(input.path)
  if (path === undefined) return []
  if (name === 'write') {
    return typeof input.content === 'string'
      ? [{ path, operation: 'unknown', materials: [{ format: 'text', scope: 'file', oldText: null, newText: input.content }], completeness: 'partial' }]
      : [{ path, operation: 'unknown', materials: [{ format: 'unavailable', reason: 'notProvided' }], completeness: 'partial' }]
  }
  const edits = Array.isArray(input.edits) ? input.edits.map(record) : []
  const materials: FileChange['materials'] = edits.flatMap(edit => typeof edit.oldText === 'string' && typeof edit.newText === 'string'
    ? [{ format: 'text' as const, scope: 'fragment' as const, oldText: edit.oldText, newText: edit.newText }] : [])
  return [{ path, operation: 'modify', materials: materials.length ? materials : [{ format: 'unavailable', reason: 'notProvided' }], completeness: materials.length && materials.length === edits.length ? 'complete' : 'partial' }]
}

/** Build a redacted tool-call item for PiBackendSession.startTool or history replay; status is supplied by the caller. */
export function toolItem(redact: Redactor, id: string, name: string, args: unknown, status: ItemStatus): ToolCallItem {
  const fileChanges = piFileChanges(name, args)
  return { id, type: 'toolCall', kind: toolKind(name), title: name, toolName: name, nativeType: name, input: redact.json(args), status, ...(fileChanges ? { fileChanges: redact.json(fileChanges) as unknown as FileChange[] } : {}) }
}

/** Extract and join text from a Pi result's content, never details; missing/unsupported content returns an empty string. */
export function toolOutputText(result: unknown): string {
  const content = record(result).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(record).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('')
}

/** Copy a tool item with redacted text output; an explicit stopped status overrides the native error flag. */
export function completeTool(redact: Redactor, previous: ToolCallItem, result: unknown, isError: boolean, stopped?: ItemStatus): ToolCallItem {
  return { ...previous, status: stopped ?? (isError ? 'failed' : 'completed'), output: redact.text(toolOutputText(result)) }
}

/** Join text blocks without separators, dropping thinking, images and tool calls; strings pass through. */
export function contentText(content: string | PiHostContent[]): string {
  if (typeof content === 'string') return content
  return content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

/**
 * Convert submission input to Pi text and base64 images, joining text blocks with blank lines.
 * Unsupported blocks or images without nonempty data and MIME type throw CAPABILITY_UNSUPPORTED;
 * this conversion does not validate the base64 encoding.
 */
export function nativeInput(input: InputBlock[]): { text: string; images: PiHostImage[] } {
  const text: string[] = [], images: PiHostImage[] = []
  for (const block of input) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'image' && block.data && block.mimeType) images.push({ data: block.data, mimeType: block.mimeType })
    else throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Input cannot be represented by the Pi SDK')
  }
  return { text: text.join('\n\n'), images }
}

/** Sum native usage on all supplied messages, without role filtering; finishTurn supplies assistant messages. Scope defaults to turn. */
export function usageOf(messages: readonly PiHostMessage[], scope: Usage['scope'] = 'turn'): Usage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const message of messages) if (message.usage) {
    total.input += message.usage.input; total.output += message.usage.output
    total.cacheRead += message.usage.cacheRead; total.cacheWrite += message.usage.cacheWrite; total.total += message.usage.totalTokens
  }
  return { provider: 'pi', scope, source: 'native', input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, total: total.total }
}

/**
 * Return a safe failure only for stopReason error, for PiBackendSession.messageEnd to retain until
 * settlement. Only HTTP status digits classify failures; raw error text is discarded. Rate limits
 * and service failures are retryable; all other mapped failures are not.
 */
export function piTurnError(message: PiHostMessage | undefined): HarnessError | undefined {
  if (!message || message.stopReason !== 'error') return undefined
  const status = /\b(401|403|429|5\d\d)\b/.exec(message.errorMessage ?? '')?.[1]
  const code = status === '401' ? 'AUTH_REQUIRED' : status === '403' ? 'AUTH_FORBIDDEN' : status === '429' ? 'RATE_LIMITED' : status ? 'NATIVE_SERVICE_UNAVAILABLE' : 'PI_TURN_FAILED'
  return { code, message: 'Pi model request failed', retryable: code === 'RATE_LIMITED' || code === 'NATIVE_SERVICE_UNAVAILABLE', outcomeUnknown: false }
}

/**
 * Identify user entry ids that begin turns in oldest-first branch history. Known live turn bindings
 * take precedence; otherwise require no prior message or an assistant message ending without toolUse.
 * PiBackendSession.forkHost uses these boundaries to reject unverified fork targets.
 */
export function turnStarts(entries: readonly PiHostEntry[], known: ReadonlyMap<string, string>): Set<string> {
  const starts = new Set<string>()
  let previous: PiHostMessage | undefined
  for (const entry of entries) {
    if (entry.kind !== 'message' || !entry.message) continue
    if (entry.message.role === 'user') {
      if (known.has(entry.id) || !previous || (previous.role === 'assistant' && previous.stopReason !== 'toolUse')) starts.add(entry.id)
    }
    previous = entry.message
  }
  return starts
}

/**
 * Reconstruct redacted items from oldest-first active-branch entries for PiBackendSession.readHistory.
 * `turns` maps user entry ids to live AHP turn ids; unbound turns use native-prefixed ids. Tool results
 * update earlier calls in place, including across turn boundaries; unmatched calls have no status.
 * Input entries are not mutated, and native tool details and non-text user content are omitted.
 */
export function historyItems(redact: Redactor, entries: readonly PiHostEntry[], turns: ReadonlyMap<string, string>): HistoryItem[] {
  const starts = turnStarts(entries, turns)
  const items: HistoryItem[] = []
  let turnId = 'native:session', nativeTurnId: string | undefined
  const tools = new Map<string, HistoryItem>()
  for (const entry of entries) {
    if (starts.has(entry.id)) { nativeTurnId = entry.id; turnId = turns.get(entry.id) ?? `native:${entry.id}` }
    const base = { turnId, ...(nativeTurnId ? { nativeTurnId } : {}), nativeItemId: entry.id }
    const mapped = historyEntryItems({ redact, entry, base })
    for (const item of mapped) {
      if (item.item.type === 'toolCall') tools.set(item.item.id, item)
      items.push(item)
    }
    const message = entry.message
    if (entry.kind === 'message' && message?.role === 'toolResult' && message.toolCallId) {
      const previous = tools.get(message.toolCallId)
      if (previous?.item.type === 'toolCall') previous.item = completeTool(redact, previous.item, { content: contentText(message.content) }, message.isError === true)
    }
  }
  return items
}

type ToolCallItem = Extract<Item, { type: 'toolCall' }>
type ItemStatus = NonNullable<Item['status']>
type HistoryBase = Omit<HistoryItem, 'item'>

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** Map one entry's visible content; historyItems separately owns turn assignment and result pairing. */
function historyEntryItems({ redact, entry, base }: { redact: Redactor; entry: PiHostEntry; base: HistoryBase }): HistoryItem[] {
  if (entry.kind === 'compaction') return [{ ...base, item: { id: entry.id, type: 'compaction', status: 'completed', ...(entry.summary ? { summary: redact.text(entry.summary) } : {}) } }]
  const message = entry.message
  if (entry.kind !== 'message' || !message) return []
  if (message.role === 'user') return [{ ...base, item: { id: entry.id, type: 'userMessage', status: 'completed', content: [{ type: 'text', text: redact.text(contentText(message.content)) }] } }]
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return assistantHistoryItems({ redact, entryId: entry.id, message, content: message.content, base })
}

/** Keep native block indexes in item ids; only a stopped assistant without tool calls supplies final text. */
function assistantHistoryItems({ redact, entryId, message, content, base }: {
  redact: Redactor; entryId: string; message: PiHostMessage; content: PiHostContent[]; base: HistoryBase
}): HistoryItem[] {
  const hasTools = content.some(part => part.type === 'toolCall')
  return content.flatMap((part, index): HistoryItem[] => {
    const id = `${entryId}:${index}`
    if (part.type === 'text') return [{ ...base, item: { id, type: 'agentMessage', status: 'completed', text: redact.text(part.text), phase: !hasTools && message.stopReason === 'stop' ? 'final' : 'commentary' } }]
    if (part.type === 'thinking') return [{ ...base, item: { id, type: 'reasoning', status: 'completed', text: redact.text(part.thinking) } }]
    if (part.type === 'toolCall') {
      const item = toolItem(redact, part.id, part.name, part.arguments, 'running')
      // A transcript call is not evidence that execution started or completed.
      delete item.status
      return [{ ...base, item }]
    }
    return []
  })
}
