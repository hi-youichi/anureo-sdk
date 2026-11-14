import type { FileChange, HarnessError, HistoryItem, InputBlock, Item, JsonValue, Usage } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import type { PiHostContent, PiHostEntry, PiHostImage, PiHostMessage } from './host'

/** Text and JSON projection shared by live item publication and history reconstruction. */
export type Redactor = ReturnType<typeof createRedactor>

/**
 * Replace literal secrets in mapped content with `[REDACTED]`. The list is captured at creation,
 * sorted longest first, and defaults to empty. Empty entries are ignored.
 *
 * JSON projection preserves keys, omits undefined object properties, and replaces unsupported
 * values and containers beyond depth 24 with null. Property access errors propagate to the caller.
 * PiAdapter captures this redactor at construction and shares it with its backends.
 */
export function createRedactor(secrets: readonly string[] = []): { text(value: string): string; json(value: unknown): JsonValue } {
  const values = [...new Set(secrets.filter(secret => secret.length > 0))].sort((a, b) => b.length - a.length)
  const text = (value: string) => values.reduce((out, secret) => out.split(secret).join('[REDACTED]'), value)

  /** Bound container traversal so cyclic or excessively nested input cannot recurse indefinitely. */
  const project = (value: unknown, depth: number): JsonValue => {
    if (typeof value === 'string') return text(value)
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (depth > 24) return null
    if (Array.isArray(value)) return value.map(entry => project(entry, depth + 1))
    if (value && typeof value === 'object') {
      const defined = Object.entries(value).filter(([, entry]) => entry !== undefined)
      return Object.fromEntries(defined.map(([key, entry]) => [key, project(entry, depth + 1)]))
    }
    return null
  }
  return { text, json: value => project(value, 0) }
}

/** Built-in tools selected for read-only sessions. The host retains its process rights. */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const
/** Built-in tool allowlist for agent-full-access sessions. */
export const FULL_ACCESS_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const
/** Permission values advertised by the adapter's configuration schema. */
export const PERMISSION_MODES = ['read-only', 'agent-full-access'] as const
/** Supported tool-allowlist policy, with no approval interaction. */
export type PiPermissionMode = typeof PERMISSION_MODES[number]
/**
 * Return a fresh Pi tool allowlist for a permission mode. Omission returns undefined so
 * PiBackendSession.hostOptions can retain host defaults and setConfig can skip changing tools.
 * Unsupported values throw INVALID_PARAMS before the allowlist is applied.
 */
export function permissionTools(mode: unknown): string[] | undefined {
  if (mode === undefined) return undefined
  if (mode === 'read-only') return [...READ_ONLY_TOOLS]
  if (mode === 'agent-full-access') return [...FULL_ACCESS_TOOLS]
  throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Pi permission mode')
}

/** Classify a Pi tool by its native name for AHP tool items. Unrecognized names map to `other`. */
export function toolKind(name: string): ToolCallItem['kind'] {
  if (name === 'bash' || name === 'powershell') return 'command'
  if (name === 'edit' || name === 'write') return 'fileChange'
  if (name.startsWith('mcp__')) return 'mcp'
  return 'other'
}

/**
 * Derive file-change evidence from tool arguments alone. Other tools return undefined and file
 * tools without a string path return an empty list. A write has an unknown operation because
 * arguments cannot tell whether the target already exists. Write evidence is always partial.
 * An edit is complete when all supplied fragments have both texts and at least one fragment exists.
 */
export function piFileChanges(name: string, args: unknown): FileChange[] | undefined {
  if (name !== 'edit' && name !== 'write') return undefined
  const input = record(args)
  const path = input.path
  if (typeof path !== 'string') return []
  return [name === 'write' ? writeFileChange(path, input) : editFileChange(path, input)]
}

/**
 * Build a tool-call item with redacted arguments and file evidence. PiBackendSession.startTool
 * supplies running as the status, then stores and publishes the item on a tool-start event.
 */
export function toolItem(redact: Redactor, id: string, name: string, args: unknown, status: ItemStatus): ToolCallItem {
  return buildToolItem({ redact, id, name, args, status })
}

/**
 * Extract a string content field or concatenate text blocks from a Pi result. Text block values
 * are coerced to strings, with nullish text treated as empty. Missing or unsupported content
 * returns an empty string. Structured details are omitted.
 */
export function toolOutputText(result: unknown): string {
  const content = record(result).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(record).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('')
}

/**
 * Copy a tool item with redacted result text and a status of failed or completed according to
 * the native error flag. A supplied stopped status takes precedence. PiBackendSession.endTool
 * stores and publishes the copy for a matching live call.
 */
export function completeTool(redact: Redactor, previous: ToolCallItem, result: unknown, isError: boolean, stopped?: ItemStatus): ToolCallItem {
  return { ...previous, status: stopped ?? (isError ? 'failed' : 'completed'), output: redact.text(toolOutputText(result)) }
}

/** Pass through string content or join only the text blocks without separators. */
export function contentText(content: string | PiHostContent[]): string {
  if (typeof content === 'string') return content
  return content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

/**
 * Convert submission input to Pi text and inline images, joining text blocks with blank lines.
 * Unsupported blocks or images without nonempty data and MIME type throw CAPABILITY_UNSUPPORTED.
 * Image data is passed through without checking base64 encoding. PiBackendSession.submit forwards
 * the text and any images to the host after conversion succeeds.
 */
export function nativeInput(input: InputBlock[]): { text: string; images: PiHostImage[] } {
  const text: string[] = []
  const images: PiHostImage[] = []
  for (const block of input) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'image' && block.data && block.mimeType) images.push({ data: block.data, mimeType: block.mimeType })
    else throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Input cannot be represented by the Pi SDK')
  }
  return { text: text.join('\n\n'), images }
}

/**
 * Sum reported native token counts across the supplied messages, with zero totals when none
 * report usage. Scope defaults to turn. PiBackendSession.finishTurn supplies assistant messages
 * and publishes the result in the usage update and turn completion.
 */
export function usageOf(messages: readonly PiHostMessage[], scope: Usage['scope'] = 'turn'): Usage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const message of messages) {
    if (!message.usage) continue
    total.input += message.usage.input
    total.output += message.usage.output
    total.cacheRead += message.usage.cacheRead
    total.cacheWrite += message.usage.cacheWrite
    total.total += message.usage.totalTokens
  }
  return { provider: 'pi', scope, source: 'native', ...total }
}

/**
 * Return a sanitized failure for stopReason error, or undefined otherwise. The first recognized
 * HTTP status number in the native message determines the code. Only rate limits and service
 * failures are marked retryable. PiBackendSession.messageEnd saves the failure for finishTurn
 * and clears it on a later stop or toolUse. An interruption takes precedence at completion.
 */
export function piTurnError(message: PiHostMessage | undefined): HarnessError | undefined {
  if (!message || message.stopReason !== 'error') return undefined
  const code = turnErrorCode(message.errorMessage ?? '')
  return { code, message: 'Pi model request failed', retryable: code === 'RATE_LIMITED' || code === 'NATIVE_SERVICE_UNAVAILABLE', outcomeUnknown: false }
}

/**
 * Identify turn-start user entry ids in oldest-first branch history. Known live turn bindings
 * take precedence. Otherwise, only a first message or a user message after an assistant message
 * whose stop reason differs from toolUse starts a turn. PiBackendSession.forkHost rejects targets
 * outside this set.
 */
export function turnStarts(entries: readonly PiHostEntry[], known: ReadonlyMap<string, string>): Set<string> {
  const starts = new Set<string>()
  let previous: PiHostMessage | undefined
  for (const entry of entries) {
    if (entry.kind !== 'message' || !entry.message) continue
    if (entry.message.role === 'user' && (known.has(entry.id) || canStartTurnAfter(previous))) {
      starts.add(entry.id)
    }
    previous = entry.message
  }
  return starts
}

/**
 * Reconstruct redacted items in transcript order from oldest-first active-branch entries.
 * `turns` maps user entry ids to live AHP turn ids. Unbound turns use native-prefixed ids.
 * Items before the first recognized turn use `native:session`.
 * A result updates the most recent preceding call with its id, even across a turn boundary.
 * Calls without a result omit status. User items retain only text. Input entries are left intact.
 *
 * PiBackendSession.readHistory reconstructs the branch before capping and paging the snapshot,
 * so a returned call can include its result even when the result came from a later turn.
 */
export function historyItems(redact: Redactor, entries: readonly PiHostEntry[], turns: ReadonlyMap<string, string>): HistoryItem[] {
  const starts = turnStarts(entries, turns)
  const items: HistoryItem[] = []
  let turnId = 'native:session'
  let nativeTurnId: string | undefined
  const toolCalls = new Map<string, HistoryItem>()
  for (const entry of entries) {
    if (starts.has(entry.id)) {
      nativeTurnId = entry.id
      turnId = turns.get(entry.id) ?? `native:${entry.id}`
    }
    const base = { turnId, ...(nativeTurnId ? { nativeTurnId } : {}), nativeItemId: entry.id }
    for (const mapped of historyEntryItems({ redact, entry, base })) {
      if (mapped.item.type === 'toolCall') toolCalls.set(mapped.item.id, mapped)
      items.push(mapped)
    }
    applyHistoryToolResult(redact, entry, toolCalls)
  }
  return items
}

type ToolCallItem = Extract<Item, { type: 'toolCall' }>
type ItemStatus = NonNullable<Item['status']>
type HistoryBase = Omit<HistoryItem, 'item'> & { nativeItemId: string }
type ToolItemInput = { redact: Redactor; id: string; name: string; args: unknown; status?: ItemStatus }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Use the supplied whole-file text as evidence. The arguments establish neither existence nor prior contents. */
function writeFileChange(path: string, input: Record<string, unknown>): FileChange {
  const materials: FileChange['materials'] = typeof input.content === 'string'
    ? [{ format: 'text', scope: 'file', oldText: null, newText: input.content }]
    : [{ format: 'unavailable', reason: 'notProvided' }]
  return { path, operation: 'unknown', materials, completeness: 'partial' }
}

/** Retain usable edit fragments even when other supplied fragments are incomplete. */
function editFileChange(path: string, input: Record<string, unknown>): FileChange {
  const edits = Array.isArray(input.edits) ? input.edits.map(record) : []
  const fragments = edits.flatMap((edit): FileChange['materials'] => {
    if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') return []
    return [{ format: 'text', scope: 'fragment', oldText: edit.oldText, newText: edit.newText }]
  })
  const complete = fragments.length > 0 && fragments.length === edits.length
  return {
    path,
    operation: 'modify',
    materials: fragments.length ? fragments : [{ format: 'unavailable', reason: 'notProvided' }],
    completeness: complete ? 'complete' : 'partial',
  }
}

/** Apply the same content projection to live and historical calls. A transcript call alone leaves status unset. */
function buildToolItem(call: ToolItemInput): ToolCallItem {
  const { redact, id, name, args } = call
  const fileChanges = piFileChanges(name, args)
  return {
    id,
    type: 'toolCall',
    kind: toolKind(name),
    title: name,
    toolName: name,
    nativeType: name,
    input: redact.json(args),
    ...(Object.hasOwn(call, 'status') ? { status: call.status } : {}),
    ...(fileChanges ? { fileChanges: redact.json(fileChanges) as unknown as FileChange[] } : {}),
  }
}

/** Classify the first recognized status number without exposing the provider's error text. */
function turnErrorCode(errorMessage: string): HarnessError['code'] {
  const status = /\b(401|403|429|5\d\d)\b/.exec(errorMessage)?.[1]
  switch (status) {
    case '401': return 'AUTH_REQUIRED'
    case '403': return 'AUTH_FORBIDDEN'
    case '429': return 'RATE_LIMITED'
    case undefined: return 'PI_TURN_FAILED'
    default: return 'NATIVE_SERVICE_UNAVAILABLE'
  }
}

/** Infer a boundary from the prior message when a user entry has no known live binding. */
function canStartTurnAfter(previous: PiHostMessage | undefined): boolean {
  return !previous || (previous.role === 'assistant' && previous.stopReason !== 'toolUse')
}

/** Complete the matched call at its original position in history. Unmatched results are discarded. */
function applyHistoryToolResult(redact: Redactor, entry: PiHostEntry, toolCalls: ReadonlyMap<string, HistoryItem>): void {
  const message = entry.message
  if (entry.kind !== 'message' || message?.role !== 'toolResult' || !message.toolCallId) return
  const previous = toolCalls.get(message.toolCallId)
  if (previous?.item.type !== 'toolCall') return
  const result = { content: contentText(message.content) }
  previous.item = completeTool(redact, previous.item, result, message.isError === true)
}

/** Project one entry using the turn metadata supplied by historyItems. Results update earlier items. */
function historyEntryItems({ redact, entry, base }: { redact: Redactor; entry: PiHostEntry; base: HistoryBase }): HistoryItem[] {
  if (entry.kind === 'compaction') {
    return [{
      ...base,
      item: {
        id: entry.id,
        type: 'compaction',
        status: 'completed',
        ...(entry.summary ? { summary: redact.text(entry.summary) } : {}),
      },
    }]
  }
  const message = entry.message
  if (entry.kind !== 'message' || !message) return []
  if (message.role === 'user') {
    return [{
      ...base,
      item: {
        id: entry.id,
        type: 'userMessage',
        status: 'completed',
        content: [{ type: 'text', text: redact.text(contentText(message.content)) }],
      },
    }]
  }
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return assistantHistoryItems({ redact, message, content: message.content, base })
}

/** Keep native block indexes in text and reasoning ids. Text is final only on stop with no tool calls. */
function assistantHistoryItems({ redact, message, content, base }: {
  redact: Redactor
  message: PiHostMessage
  content: PiHostContent[]
  base: HistoryBase
}): HistoryItem[] {
  const hasTools = content.some(part => part.type === 'toolCall')
  return content.flatMap((part, index): HistoryItem[] => {
    const id = `${base.nativeItemId}:${index}`
    if (part.type === 'text') {
      const text = redact.text(part.text)
      const phase = !hasTools && message.stopReason === 'stop' ? 'final' : 'commentary'
      return [{ ...base, item: { id, type: 'agentMessage', status: 'completed', text, phase } }]
    }
    if (part.type === 'thinking') return [{ ...base, item: { id, type: 'reasoning', status: 'completed', text: redact.text(part.thinking) } }]
    if (part.type === 'toolCall') {
      const item = buildToolItem({ redact, id: part.id, name: part.name, args: part.arguments })
      return [{ ...base, item }]
    }
    return []
  })
}
