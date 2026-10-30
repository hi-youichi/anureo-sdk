import { codexFileChanges } from './file-changes'
import { fileURLToPath } from 'node:url'
import { publicValue, type InputBlock, type Item, type JsonValue, type Usage, type HarnessError } from '@anureo/protocol'
import { HarnessSdkError } from '@anureo/sdk'
import { record, string, type NativeRecord } from './jsonl'

export function json(value: unknown): JsonValue { return value === undefined ? null : JSON.parse(JSON.stringify(value)) as JsonValue }
export function safe(value: unknown): JsonValue { return publicValue(json(value)) }
export function nativeInput(blocks: readonly InputBlock[]): NativeRecord[] {
  return blocks.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image') return { type: 'image', url: block.url ?? `data:${block.mimeType};base64,${block.data}` }
    if (!block.uri.startsWith('file:')) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Codex file input requires a file URI')
    return { type: 'mention', path: fileURLToPath(block.uri), name: block.name ?? fileURLToPath(block.uri).split(/[\\/]/).at(-1) ?? 'file' }
  })
}
export function itemStatus(value: unknown, completed: boolean): 'running'|'completed'|'failed'|'declined'|'interrupted' {
  switch (value) {
    case 'inProgress': case 'in_progress': case 'running': case 'pending': return 'running'
    case 'failed': case 'errored': return 'failed'
    case 'declined': case 'denied': return 'declined'
    case 'interrupted': case 'cancelled': case 'closed': return 'interrupted'
    case 'completed': return 'completed'
    default: return completed ? 'completed' : 'running'
  }
}
/** Native notifications/history entries carry lifecycle times outside the item. */
export function mapItems(value: unknown, completed: boolean, history = false, timing: { startedAtMs?: unknown } = {}): Item[] {
  const raw = record(value); const id = string(raw.id)
  if (!id) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native item lacks identity')
  const status = itemStatus(raw.status, completed)
  const startedAtMs = timing.startedAtMs ?? raw.startedAtMs
  const date = typeof startedAtMs === 'number' && startedAtMs >= 0 ? new Date(startedAtMs) : undefined
  const startedAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  const common = { id, ...(!history || raw.status !== undefined ? { status } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}) }
  switch (raw.type) {
    case 'userMessage': return [{ ...common, type: 'userMessage', content: (Array.isArray(raw.content) ? raw.content : []).map(value => {
      const block = record(value)
      if (block.type === 'text') return { type: 'text', text: string(block.text) ?? '' }
      if (block.type === 'image' && typeof block.url === 'string') return { type: 'image', url: block.url }
      if (block.type === 'localImage' && typeof block.path === 'string') return { type: 'file', uri: block.path }
      return { type: 'text', text: '[unsupported native input]' }
    }) }]
    case 'agentMessage': return [{ ...common, type: 'agentMessage', text: string(raw.text) ?? '', phase: raw.phase === 'commentary' ? 'commentary' : 'final' }]
    case 'reasoning': return [{ ...common, type: 'reasoning', text: Array.isArray(raw.content) ? raw.content.filter(v => typeof v === 'string').join('\n') : '', summary: Array.isArray(raw.summary) ? raw.summary.filter(v => typeof v === 'string').join('\n') : '' }]
    case 'plan': return [{ ...common, type: 'plan', steps: [{ id: `${id}:text`, text: string(raw.text) ?? '', status: completed ? 'completed' : 'inProgress' }] }]
    case 'collabAgentToolCall': case 'collabToolCall': {
      const ids = Array.isArray(raw.receiverThreadIds) ? raw.receiverThreadIds.filter((v): v is string => typeof v === 'string') : []
      const states = record(raw.agentsStates)
      return (ids.length ? ids : Object.keys(states)).map(subagentId => {
        const state = record(states[subagentId]); const nativeState = string(state.status) ?? string(state.state) ?? status
        const normalized = nativeState === 'completed' ? 'completed' : nativeState === 'errored' || nativeState === 'failed' ? 'failed' : nativeState === 'closed' || nativeState === 'interrupted' ? 'interrupted' : 'running'
        return { ...common, id: `${id}:${subagentId}`, parentItemId: id, type: 'subagent', subagentId, state: normalized, ...(typeof raw.prompt === 'string' ? { task: raw.prompt } : {}) }
      })
    }
    case 'enteredReviewMode': case 'exitedReviewMode': return [{ ...common, type: 'review', state: raw.type === 'enteredReviewMode' ? 'entered' : 'exited', text: string(raw.review) ?? '' }]
    case 'contextCompaction': return [{ ...common, type: 'compaction', summary: string(raw.summary) ?? '' }]
    case 'hook': case 'hookPrompt': return [{ ...common, type: 'hook', name: string(raw.name) ?? 'hook', output: safe(raw.output ?? raw.fragments) }]
    case 'commandExecution': return [{ ...common, type: 'toolCall', kind: 'command', title: string(raw.command) ?? 'Command', input: safe({ command: raw.command, cwd: raw.cwd }), output: safe(raw.aggregatedOutput ?? raw.output) }]
    case 'fileChange': return [{ ...common, type: 'toolCall', kind: 'fileChange', title: 'File changes', fileChanges: codexFileChanges(raw.changes), input: safe(raw.changes), output: safe(raw.output), locations: Array.isArray(raw.changes) ? raw.changes.flatMap(v => typeof record(v).path === 'string' ? [{ path: record(v).path as string }] : []) : [] }]
    case 'mcpToolCall': return [{ ...common, type: 'toolCall', kind: 'mcp', mcp: { server: string(raw.server) ?? 'mcp', tool: string(raw.tool) ?? 'tool' }, title: `${string(raw.server) ?? 'mcp'}/${string(raw.tool) ?? 'tool'}`, input: safe(raw.arguments), output: safe(raw.result ?? raw.error) }]
    case 'dynamicToolCall': return [{ ...common, type: 'toolCall', kind: 'dynamic', ...(string(raw.tool) ? { toolName: string(raw.tool)! } : {}), title: string(raw.tool) ?? 'Dynamic tool', input: safe(raw.arguments), output: safe(raw.contentItems ?? raw.result) }]
    case 'webSearch': return [{ ...common, type: 'toolCall', kind: 'web', title: string(raw.query) ?? 'Web search', input: safe(raw.action), output: safe(raw.results) }]
    case 'imageGeneration': case 'imageView': {
      const generated = raw.type === 'imageGeneration'
      const data = generated && !string(raw.fileId) ? string(raw.result) : undefined
      return [{ ...common, type: 'toolCall', kind: 'image', nativeType: raw.type, title: 'Image', input: safe(raw.prompt),
        image: { kind: generated ? 'generated' : 'view', ...(data ? { data, mimeType: 'image/png' } : {}), ...(string(raw.fileId) ? { fileId: string(raw.fileId)! } : {}), ...(string(raw.savedPath ?? raw.path) ? { path: string(raw.savedPath ?? raw.path)! } : {}), ...(string(raw.revisedPrompt) ? { revisedPrompt: string(raw.revisedPrompt)! } : {}) },
        ...(raw.failure ? { output: safe({ failure: raw.failure }) } : {}),
      }]
    }
    default: return [{ ...common, type: 'toolCall', kind: 'other', title: string(raw.type) ?? 'Unknown native item', nativeType: string(raw.type) ?? 'unknown', raw: safe(raw) }]
  }
}
export function mapUsage(value: unknown, scope: 'turn'|'session' = 'turn'): Usage {
  const raw = record(value)
  const n = (field: string): number | undefined => typeof raw[field] === 'number' && Number.isFinite(raw[field]) && (raw[field] as number) >= 0 ? raw[field] as number : undefined
  const usage: Usage = { provider: 'codex', scope, source: 'native' }
  for (const [source, target] of [['inputTokens','input'],['outputTokens','output'],['cachedInputTokens','cacheRead'],['cacheCreationInputTokens','cacheWrite'],['totalTokens','total']] as const) {
    const value = n(source); if (value !== undefined) usage[target] = value
  }
  return usage
}

/** Only typed provider categories and HTTP status survive the public boundary. */
export function mapTurnError(value: unknown): HarnessError {
  const error = record(value), info = error.codexErrorInfo
  const entries = info && typeof info === 'object' && !Array.isArray(info) ? Object.entries(info) : []
  const httpEntry = entries.find(([key]) => ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(key))
  const nativeCode = typeof info === 'string' ? info : httpEntry?.[0]
  const httpStatusCode = httpEntry ? record(httpEntry[1]).httpStatusCode : undefined
  const status = typeof httpStatusCode === 'number' && Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599 ? httpStatusCode : undefined
  let code = 'NATIVE_TURN_FAILED', message = 'Codex turn failed', retryable = false
  if (nativeCode === 'unauthorized' || status === 401) { code = 'AUTH_REQUIRED'; message = 'Sign in to the independent Codex runtime before sending' }
  else if (status === 403) { code = 'AUTH_FORBIDDEN'; message = 'The selected Codex account cannot access this resource' }
  else if (nativeCode === 'usageLimitExceeded') { code = 'USAGE_LIMIT_EXCEEDED'; message = 'Codex account usage limit reached' }
  else if (nativeCode === 'rateLimitExceeded' || status === 429) { code = 'RATE_LIMITED'; message = 'Codex rate limit reached'; retryable = true }
  else if (nativeCode === 'contextWindowExceeded') { code = 'CONTEXT_WINDOW_EXCEEDED'; message = 'Codex context window exceeded' }
  else if (nativeCode === 'badRequest') { code = 'NATIVE_REQUEST_INVALID'; message = 'Codex rejected the request' }
  else if (nativeCode === 'serverOverloaded' || nativeCode === 'internalServerError' || (status !== undefined && status >= 500)) { code = 'NATIVE_SERVICE_UNAVAILABLE'; message = 'Codex service is unavailable'; retryable = true }
  else if (httpEntry) { code = 'NATIVE_CONNECTION_FAILED'; message = 'Codex connection to the model service failed'; retryable = true }
  return { code, message, retryable, outcomeUnknown: false, ...(status ? { details: { httpStatusCode: status } } : {}) }
}
