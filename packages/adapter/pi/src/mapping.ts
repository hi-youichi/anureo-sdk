import type { FileChange, HarnessError, HistoryItem, InputBlock, Item, JsonValue, Usage } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import type { PiHostContent, PiHostEntry, PiHostImage, PiHostMessage } from './host'

type ToolCallItem = Extract<Item, { type: 'toolCall' }>
type ItemStatus = NonNullable<Item['status']>

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** Replace configured secret values in any string reachable from a JSON-like value. */
export function createRedactor(secrets: readonly string[] = []): { text(value: string): string; json(value: unknown): JsonValue } {
  const values = [...new Set(secrets.filter(secret => secret.length > 0))].sort((a, b) => b.length - a.length)
  const text = (value: string) => values.reduce((out, secret) => out.split(secret).join('[REDACTED]'), value)
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
export type Redactor = ReturnType<typeof createRedactor>

export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const
export const FULL_ACCESS_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const
export const PERMISSION_MODES = ['read-only', 'agent-full-access'] as const
export type PiPermissionMode = typeof PERMISSION_MODES[number]
export function permissionTools(mode: unknown): string[] | undefined {
  if (mode === undefined) return undefined
  if (mode === 'read-only') return [...READ_ONLY_TOOLS]
  if (mode === 'agent-full-access') return [...FULL_ACCESS_TOOLS]
  throw new HarnessSdkError('INVALID_PARAMS', 'Unsupported Pi permission mode')
}

export function toolKind(name: string): ToolCallItem['kind'] {
  if (name === 'bash' || name === 'powershell') return 'command'
  if (name === 'edit' || name === 'write') return 'fileChange'
  if (name.startsWith('mcp__')) return 'mcp'
  return 'other'
}

/** Tool arguments prove fragments only; whole-file claims are limited to `write`. */
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

export function toolItem(redact: Redactor, id: string, name: string, args: unknown, status: ItemStatus): ToolCallItem {
  const fileChanges = piFileChanges(name, args)
  return { id, type: 'toolCall', kind: toolKind(name), title: name, toolName: name, nativeType: name, input: redact.json(args), status, ...(fileChanges ? { fileChanges: redact.json(fileChanges) as unknown as FileChange[] } : {}) }
}

/** Pi tool results are `{ content: [{type:'text',text}], details }`; keep text output, never details. */
export function toolOutputText(result: unknown): string {
  const content = record(result).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(record).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('')
}

export function completeTool(redact: Redactor, previous: ToolCallItem, result: unknown, isError: boolean, stopped?: ItemStatus): ToolCallItem {
  return { ...previous, status: stopped ?? (isError ? 'failed' : 'completed'), output: redact.text(toolOutputText(result)) }
}

export function contentText(content: string | PiHostContent[]): string {
  if (typeof content === 'string') return content
  return content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

/** Text goes to Pi as the prompt; images pass through as base64. Other input shapes are rejected, not approximated. */
export function nativeInput(input: InputBlock[]): { text: string; images: PiHostImage[] } {
  const text: string[] = [], images: PiHostImage[] = []
  for (const block of input) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'image' && block.data && block.mimeType) images.push({ data: block.data, mimeType: block.mimeType })
    else throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Input cannot be represented by the Pi SDK')
  }
  return { text: text.join('\n\n'), images }
}

export function usageOf(messages: readonly PiHostMessage[], scope: Usage['scope'] = 'turn'): Usage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const message of messages) if (message.usage) {
    total.input += message.usage.input; total.output += message.usage.output
    total.cacheRead += message.usage.cacheRead; total.cacheWrite += message.usage.cacheWrite; total.total += message.usage.totalTokens
  }
  return { provider: 'pi', scope, source: 'native', input: total.input, output: total.output, cacheRead: total.cacheRead, cacheWrite: total.cacheWrite, total: total.total }
}

/** Native categories only: free-form Pi error text is never forwarded or used for classification beyond HTTP status digits. */
export function piTurnError(message: PiHostMessage | undefined): HarnessError | undefined {
  if (!message || message.stopReason !== 'error') return undefined
  const status = /\b(401|403|429|5\d\d)\b/.exec(message.errorMessage ?? '')?.[1]
  const code = status === '401' ? 'AUTH_REQUIRED' : status === '403' ? 'AUTH_FORBIDDEN' : status === '429' ? 'RATE_LIMITED' : status ? 'NATIVE_SERVICE_UNAVAILABLE' : 'PI_TURN_FAILED'
  return { code, message: 'Pi model request failed', retryable: code === 'RATE_LIMITED' || code === 'NATIVE_SERVICE_UNAVAILABLE', outcomeUnknown: false }
}

/** Entry ids that start a turn: the first message and any user message after a finished (non tool-use) assistant message. */
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

/** History items for the active branch. `turns` maps a user entry id to the AHP turn id used live. */
export function historyItems(redact: Redactor, entries: readonly PiHostEntry[], turns: ReadonlyMap<string, string>): HistoryItem[] {
  const starts = turnStarts(entries, turns)
  const items: HistoryItem[] = []
  let turnId = 'native:session', nativeTurnId: string | undefined
  const tools = new Map<string, HistoryItem>()
  for (const entry of entries) {
    if (starts.has(entry.id)) { nativeTurnId = entry.id; turnId = turns.get(entry.id) ?? `native:${entry.id}` }
    const base = { turnId, ...(nativeTurnId ? { nativeTurnId } : {}), nativeItemId: entry.id }
    if (entry.kind === 'compaction') { items.push({ ...base, item: { id: entry.id, type: 'compaction', status: 'completed', ...(entry.summary ? { summary: redact.text(entry.summary) } : {}) } }); continue }
    const message = entry.message
    if (entry.kind !== 'message' || !message) continue
    if (message.role === 'user') {
      const text = contentText(message.content)
      items.push({ ...base, item: { id: entry.id, type: 'userMessage', status: 'completed', content: [{ type: 'text', text: redact.text(text) }] } })
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      const hasTools = message.content.some(part => part.type === 'toolCall')
      message.content.forEach((part, index) => {
        const id = `${entry.id}:${index}`
        if (part.type === 'text') items.push({ ...base, item: { id, type: 'agentMessage', status: 'completed', text: redact.text(part.text), phase: !hasTools && message.stopReason === 'stop' ? 'final' : 'commentary' } })
        else if (part.type === 'thinking') items.push({ ...base, item: { id, type: 'reasoning', status: 'completed', text: redact.text(part.thinking) } })
        else if (part.type === 'toolCall') {
          const entryItem: HistoryItem = { ...base, item: toolItem(redact, part.id, part.name, part.arguments, 'running') }
          delete entryItem.item.status
          tools.set(part.id, entryItem); items.push(entryItem)
        }
      })
    } else if (message.role === 'toolResult' && message.toolCallId) {
      const previous = tools.get(message.toolCallId)
      if (previous?.item.type === 'toolCall') previous.item = completeTool(redact, previous.item, { content: contentText(message.content) }, message.isError === true)
    }
  }
  return items
}
