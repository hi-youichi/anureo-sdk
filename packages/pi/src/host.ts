/**
 * The only module that imports the Pi SDK. Everything else talks to `PiSessionHost`, a small
 * Pi-independent surface, so tests inject a scripted host and a subprocess host can replace this one.
 */
import type { AgentSession, AgentSessionEvent, SessionManager, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { StructuredOutputToolDefinition } from '@anureo/sdk'
import { Type } from 'typebox'
import { join } from 'node:path'

export type PiHostContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; data?: string; mimeType?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export interface PiHostUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }

export interface PiHostMessage {
  role: string
  content: string | PiHostContent[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  usage?: PiHostUsage
  model?: string
  provider?: string
  timestamp?: number
}

export type PiHostEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; willRetry: boolean }
  | { type: 'settled'; aborted: boolean }
  | { type: 'message_start'; message: PiHostMessage }
  | { type: 'message_update'; message: PiHostMessage; update: { kind: 'text' | 'thinking' | 'toolcall'; phase: 'start' | 'delta' | 'end'; index: number; delta?: string } }
  | { type: 'message_end'; message: PiHostMessage }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_update'; id: string; name: string; partial: unknown }
  | { type: 'tool_end'; id: string; name: string; result: unknown; isError: boolean }
  | { type: 'compaction_start'; reason: string }
  | { type: 'compaction_end'; reason: string; aborted: boolean; summary?: string; errorMessage?: string }
  | { type: 'retry'; phase: 'start' | 'end'; attempt: number; success?: boolean }
  | { type: 'session_name'; name?: string }
  | { type: 'error'; message: string }
  /** The host lost its native source (a subprocess host's connection, for example): observation must fail. */
  | { type: 'failed'; code: string }

export interface PiHostEntry {
  id: string
  parentId: string | null
  kind: 'message' | 'compaction' | 'other'
  message?: PiHostMessage
  summary?: string
  timestamp?: number
}

export interface PiHostModel {
  /** `provider/id` */
  ref: string
  name: string
  reasoning: boolean
  thinkingLevels: string[]
  contextWindow?: number
}

export type PiInputDisposition = 'queued' | 'handled'
export type PiPromptDisposition = PiInputDisposition | 'started'
export interface PiHostImage { data: string; mimeType: string }

export interface PiSessionHost {
  readonly sessionId: string
  /** `provider/id` of the active model, if any. */
  readonly model?: string
  readonly thinkingLevel: string
  /** True while a run, compaction, retry or queued continuation is in progress. */
  readonly busy: boolean
  subscribe(listener: (event: PiHostEvent) => void): () => void
  /** Resolves once the prompt was accepted (started, queued or handled); the run continues in the background. */
  prompt(text: string, images?: PiHostImage[]): Promise<PiPromptDisposition>
  steer(text: string, images?: PiHostImage[]): Promise<PiInputDisposition>
  followUp(text: string, images?: PiHostImage[]): Promise<PiInputDisposition>
  abort(): Promise<void>
  listModels(): Promise<PiHostModel[]>
  setModel(ref: string): Promise<void>
  availableThinkingLevels(): string[]
  setThinkingLevel(level: string): string
  setActiveTools(names: string[]): void
  /** Dynamic output tool support; absent on hosts which cannot replace tools safely. */
  setOutputTool?(tool?: StructuredOutputToolDefinition): Promise<void>
  /** Entries on the active branch, oldest first. */
  entries(): PiHostEntry[]
  compact(instructions?: string): Promise<{ summary?: string }>
  /** New host whose history is the active branch up to and including `entryId` (`null` = empty). Needs persistence. */
  fork(entryId: string | null): Promise<PiSessionHost>
  /** Whether sessions are persisted so resume and fork can work. */
  readonly persistent: boolean
  dispose(): Promise<void>
}

export interface PiHostOpenOptions {
  cwd: string
  mode: 'new' | 'resume'
  /** Pi session id to resume. */
  sessionId?: string
  model?: string
  thinkingLevel?: string
  /** Allowlist of Pi tool names; `undefined` keeps Pi defaults, `[]` disables tools. */
  tools?: string[]
  instructions?: string
  agentDir?: string
  sessionDir?: string
  persist: boolean
}
export type PiHostFactory = (options: PiHostOpenOptions) => Promise<PiSessionHost>

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Convert a Pi message into the host shape without retaining native object identity. */
export function toHostMessage(value: unknown): PiHostMessage {
  const message = record(value)
  const content = message.content
  const usage = record(message.usage)
  return {
    role: typeof message.role === 'string' ? message.role : 'unknown',
    content: typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => {
      const block = record(part)
      if (block.type === 'text') return { type: 'text' as const, text: String(block.text ?? '') }
      if (block.type === 'thinking') return { type: 'thinking' as const, thinking: String(block.thinking ?? '') }
      if (block.type === 'toolCall') return { type: 'toolCall' as const, id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: record(block.arguments) }
      if (block.type === 'image') return { type: 'image' as const, ...(typeof block.data === 'string' ? { data: block.data } : {}), ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}) }
      return { type: 'text' as const, text: '' }
    }) : '',
    ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {}),
    ...(typeof message.stopReason === 'string' ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === 'string' ? { errorMessage: message.errorMessage } : {}),
    ...(typeof message.model === 'string' ? { model: message.model } : {}),
    ...(typeof message.provider === 'string' ? { provider: message.provider } : {}),
    ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}),
    ...(typeof usage.input === 'number' ? { usage: { input: usage.input, output: Number(usage.output ?? 0), cacheRead: Number(usage.cacheRead ?? 0), cacheWrite: Number(usage.cacheWrite ?? 0), totalTokens: Number(usage.totalTokens ?? 0) } } : {}),
  }
}

/** Normalize one native session event; unknown kinds return undefined. */
export function toHostEvent(event: AgentSessionEvent): PiHostEvent | undefined {
  switch (event.type) {
    case 'agent_start': return { type: 'agent_start' }
    case 'agent_end': return { type: 'agent_end', willRetry: event.willRetry }
    case 'agent_settled': return { type: 'settled', aborted: event.aborted }
    case 'message_start': return { type: 'message_start', message: toHostMessage(event.message) }
    case 'message_end': return { type: 'message_end', message: toHostMessage(event.message) }
    case 'message_update': {
      const inner = event.assistantMessageEvent
      const match = /^(text|thinking|toolcall)_(start|delta|end)$/.exec(inner.type)
      if (!match) return undefined
      const index = 'contentIndex' in inner ? inner.contentIndex : 0
      return { type: 'message_update', message: toHostMessage(event.message), update: { kind: match[1] as 'text', phase: match[2] as 'start', index, ...('delta' in inner ? { delta: inner.delta } : {}) } }
    }
    case 'tool_execution_start': return { type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args }
    case 'tool_execution_update': return { type: 'tool_update', id: event.toolCallId, name: event.toolName, partial: event.partialResult }
    case 'tool_execution_end': return { type: 'tool_end', id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError }
    case 'compaction_start': return { type: 'compaction_start', reason: event.reason }
    case 'compaction_end': return { type: 'compaction_end', reason: event.reason, aborted: event.aborted, ...(event.result && typeof record(event.result).summary === 'string' ? { summary: String(record(event.result).summary) } : {}), ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}) }
    case 'auto_retry_start': return { type: 'retry', phase: 'start', attempt: event.attempt }
    case 'auto_retry_end': return { type: 'retry', phase: 'end', attempt: event.attempt, success: event.success }
    case 'session_info_changed': return { type: 'session_name', ...(event.name ? { name: event.name } : {}) }
    default: return undefined
  }
}

function entryToHost(entry: unknown): PiHostEntry {
  const value = record(entry)
  const base = { id: String(value.id ?? ''), parentId: typeof value.parentId === 'string' ? value.parentId : null, ...(typeof value.timestamp === 'string' ? { timestamp: Date.parse(value.timestamp) } : {}) }
  if (value.type === 'message') return { ...base, kind: 'message', message: toHostMessage(value.message) }
  if (value.type === 'compaction') return { ...base, kind: 'compaction', ...(typeof value.summary === 'string' ? { summary: value.summary } : {}) }
  return { ...base, kind: 'other' }
}

const thinkingLevelsOf = (levels: readonly string[]): string[] => [...levels]

class DefaultPiHost implements PiSessionHost {
  private readonly listeners = new Set<(event: PiHostEvent) => void>()
  private unsubscribe?: () => void
  private disposed = false
  private outputTool?: string
  private readonly outputCalls = new Map<string, unknown>()
  constructor(
    private readonly session: AgentSession,
    private readonly pi: typeof import('@earendil-works/pi-coding-agent'),
    private readonly open: PiHostOpenOptions,
    readonly persistent: boolean,
    private readonly extensions: ExtensionAPI,
  ) {
    this.unsubscribe = session.subscribe(event => {
      // Pi validates with coercion before execute(). Preserve the original arguments for SDK validation.
      if (event.type === 'tool_execution_start' && event.toolName === this.outputTool) this.outputCalls.set(event.toolCallId, structuredClone(event.args))
      if (event.type === 'tool_execution_end') this.outputCalls.delete(event.toolCallId)
      const mapped = toHostEvent(event)
      if (mapped) this.emit(mapped)
    })
  }
  private emit(event: PiHostEvent): void { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* a listener must not break Pi's loop */ } } }
  get sessionId(): string { return this.session.sessionId }
  get model(): string | undefined { const model = this.session.model; return model ? `${model.provider}/${model.id}` : undefined }
  get thinkingLevel(): string { return this.session.thinkingLevel }
  get busy(): boolean { return !this.session.isIdle }
  subscribe(listener: (event: PiHostEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private images(images?: PiHostImage[]) { return images?.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })) }
  prompt(text: string, images?: PiHostImage[]): Promise<PiPromptDisposition> {
    return new Promise<PiPromptDisposition>((resolve, reject) => {
      let settledPreflight = false
      const run = this.session.prompt(text, { ...(images ? { images: this.images(images)! } : {}), source: 'rpc', preflightResult: disposition => { settledPreflight = true; resolve(disposition) } })
      run.then(() => { if (!settledPreflight) resolve('handled') }, cause => {
        if (!settledPreflight) reject(cause)
        else this.emit({ type: 'error', message: cause instanceof Error ? cause.message : 'Pi run failed' })
      })
    })
  }
  steer(text: string, images?: PiHostImage[]): Promise<PiInputDisposition> { return this.session.steer(text, this.images(images), { source: 'rpc' }) }
  followUp(text: string, images?: PiHostImage[]): Promise<PiInputDisposition> { return this.session.followUp(text, this.images(images), { source: 'rpc' }) }
  abort(): Promise<void> { return this.session.abort() }
  async listModels(): Promise<PiHostModel[]> {
    const models = await this.session.modelRuntime.getAvailable()
    return models.map(model => ({
      ref: `${model.provider}/${model.id}`, name: model.name ?? model.id, reasoning: model.reasoning,
      thinkingLevels: model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => (model.thinkingLevelMap as Record<string, unknown> | undefined)?.[level] !== null) : ['off'],
      contextWindow: model.contextWindow,
    }))
  }
  async setModel(ref: string): Promise<void> {
    const slash = ref.indexOf('/')
    const model = slash > 0 ? this.session.modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : undefined
    if (!model) throw new Error('MODEL_NOT_FOUND')
    await this.session.setModel(model)
  }
  availableThinkingLevels(): string[] { return thinkingLevelsOf(this.session.getAvailableThinkingLevels()) }
  setThinkingLevel(level: string): string { this.session.setThinkingLevel(level as Parameters<AgentSession['setThinkingLevel']>[0]); return this.session.thinkingLevel }
  setActiveTools(names: string[]): void { this.extensions.setActiveTools([...new Set([...names, ...(this.outputTool ? [this.outputTool] : [])])]) }
  async setOutputTool(tool?: StructuredOutputToolDefinition): Promise<void> {
    if (this.disposed) return
    if (tool && this.busy) throw new Error('STRUCTURED_OUTPUT_BUSY')
    this.outputCalls.clear()
    const active = this.extensions.getActiveTools().filter(name => name !== this.outputTool)
    if (tool) {
      // Keep object schemas as the actual model-facing parameters. Other JSON roots use a value envelope.
      const definition = structuredClone({ name: tool.name, description: tool.description, schema: tool.schema })
      const object = typeof definition.schema === 'object' && definition.schema.type === 'object'
      // A nested resource keeps local references rooted at the original schema for non-object values.
      const valueSchema = typeof definition.schema === 'boolean' ? definition.schema : { ...definition.schema, $id: definition.schema.$id ?? 'urn:anureo:output-result' }
      const parameters = object ? definition.schema : {
        ...(typeof definition.schema === 'object' && definition.schema.$schema ? { $schema: definition.schema.$schema } : {}),
        type: 'object', properties: { value: valueSchema }, required: ['value'], additionalProperties: false,
      }
      const execute = tool.execute
      const calls = this.outputCalls
      this.extensions.registerTool({
        name: definition.name, label: 'Submit result', description: definition.description,
        parameters: Type.Unsafe<Record<string, unknown>>(parameters),
        async execute(id, args) {
          const original = calls.has(id) ? calls.get(id) : args
          const result = await execute(object ? original : record(original).value)
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result,
            ...(result.accepted ? { terminate: true } : { isError: true }) }
        },
      })
      this.outputTool = definition.name
      this.extensions.setActiveTools([...new Set([...active, definition.name])])
    } else {
      this.extensions.setActiveTools(active)
      this.outputTool = undefined
    }
  }
  entries(): PiHostEntry[] { return this.session.sessionManager.getBranch().map(entryToHost) }
  async compact(instructions?: string): Promise<{ summary?: string }> {
    const result = await this.session.compact(instructions)
    const summary = record(result).summary
    return typeof summary === 'string' ? { summary } : {}
  }
  async fork(entryId: string | null): Promise<PiSessionHost> {
    if (!this.persistent) throw new Error('FORK_NEEDS_PERSISTENCE')
    const manager = this.session.sessionManager
    let forked
    if (entryId === null) forked = this.pi.SessionManager.create(this.open.cwd, this.open.sessionDir)
    else {
      const source = this.pi.SessionManager.open(manager.getSessionFile()!, this.open.sessionDir)
      if (!source.createBranchedSession(entryId)) throw new Error('FORK_FAILED')
      forked = source
    }
    return createHostFromManager(this.pi, { ...this.open, mode: 'resume' }, forked, true)
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.listeners.clear()
    this.outputCalls.clear()
    this.session.dispose()
  }
}

async function createHostFromManager(pi: typeof import('@earendil-works/pi-coding-agent'), open: PiHostOpenOptions, sessionManager: SessionManager, persistent: boolean): Promise<PiSessionHost> {
  const agentDir = open.agentDir ?? pi.getAgentDir()
  const settingsManager = pi.SettingsManager.create(open.cwd, agentDir)
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') })
  const model = open.model ? (() => { const slash = open.model!.indexOf('/'); return slash > 0 ? modelRuntime.getModel(open.model!.slice(0, slash), open.model!.slice(slash + 1)) : undefined })() : undefined
  if (open.model && !model) throw new Error('MODEL_NOT_FOUND')
  let extensions: ExtensionAPI | undefined
  const loader = new pi.DefaultResourceLoader({
    cwd: open.cwd, agentDir, settingsManager,
    disabledBuiltinExtensions: ['mcp'],
    extensionFactories: [api => { extensions = api }],
    ...(open.instructions ? { appendSystemPrompt: [open.instructions] } : {}),
  })
  await loader.reload()
  const { session } = await pi.createAgentSession({
    cwd: open.cwd, agentDir, sessionManager, settingsManager, modelRuntime, resourceLoader: loader,
    ...(model ? { model } : {}),
    ...(open.thinkingLevel ? { thinkingLevel: open.thinkingLevel as never } : {}),
  })
  if (!extensions) { session.dispose(); throw new Error('PI_OUTPUT_TOOLS_UNAVAILABLE') }
  const host = new DefaultPiHost(session, pi, open, persistent, extensions)
  if (open.tools) host.setActiveTools(open.tools)
  return host
}

/** Default factory: embeds Pi in-process through `createAgentSession`. */
export const createPiHost: PiHostFactory = async (open: PiHostOpenOptions) => {
  const pi = await import('@earendil-works/pi-coding-agent')
  let manager
  if (!open.persist) manager = pi.SessionManager.inMemory(open.cwd)
  else if (open.mode === 'resume') {
    const file = open.sessionId ? pi.SessionManager.findById(open.cwd, open.sessionId, open.sessionDir) : undefined
    if (!file) throw new Error('SESSION_NOT_FOUND')
    manager = pi.SessionManager.open(file, open.sessionDir)
  } else manager = pi.SessionManager.create(open.cwd, open.sessionDir)
  return createHostFromManager(pi, open, manager, open.persist)
}
