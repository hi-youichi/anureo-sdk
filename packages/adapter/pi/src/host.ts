/**
 * Owns the adapter's native Pi SDK integration and normalization boundary. Adapter runtime code
 * consumes PiSessionHost; injected hosts can provide the same contract without native SDK objects.
 */
import type { AgentSession, AgentSessionEvent, SessionManager, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { StructuredOutputToolDefinition } from '@anureo/sdk'
import { Type } from 'typebox'
import { join } from 'node:path'

/** Normalized message blocks; tool arguments remain unredacted until adapter mapping. */
export type PiHostContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; data?: string; mimeType?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

/** Native token counts, including separate cache reads/writes; totalTokens is supplied by Pi. */
export interface PiHostUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }

/** Message snapshot consumed by live publication and history mapping; native error text is not safe for publication. */
export interface PiHostMessage {
  role: string
  content: string | PiHostContent[]
  /** On toolResult messages, identifies the earlier tool call whose history item is completed. */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  usage?: PiHostUsage
  model?: string
  provider?: string
  /** Native timestamp in milliseconds since the Unix epoch. */
  timestamp?: number
}

/**
 * Ordered host notifications consumed by PiBackendSession's serialized listener. agent_end ends an
 * attempt; settled marks completion after retries and queued continuations. Payloads are unredacted.
 */
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

/** One active-branch transcript entry; parentId preserves ancestry for before/through forks. */
export interface PiHostEntry {
  id: string
  parentId: string | null
  kind: 'message' | 'compaction' | 'other'
  message?: PiHostMessage
  summary?: string
  /** Native timestamp in milliseconds since the Unix epoch. */
  timestamp?: number
}

/** Available provider model and picker/config metadata, without credentials. */
export interface PiHostModel {
  /** `provider/id` */
  ref: string
  name: string
  reasoning: boolean
  /** Levels accepted by the model picker; non-reasoning models expose only off. */
  thinkingLevels: string[]
  /** Native context capacity in tokens, when available. */
  contextWindow?: number
}

/** Queued input awaits execution; handled input was consumed without starting a model run. */
export type PiInputDisposition = 'queued' | 'handled'
/** Prompt acceptance distinguishes an immediate run from queueing or extension handling. */
export type PiPromptDisposition = PiInputDisposition | 'started'
/** Inline image bytes encoded as base64 with their MIME type; supplied by nativeInput. */
export interface PiHostImage { data: string; mimeType: string }

/**
 * Implement this seam to supply PiAdapter with an owned session. PiBackendSession opens, observes
 * and disposes each host; input acceptance and execution completion are separate. Methods may reject
 * native failures, which the backend maps to SDK errors. Hosts publish raw values for adapter redaction.
 */
export interface PiSessionHost {
  readonly sessionId: string
  /** `provider/id` of the active model, if any. */
  readonly model?: string
  readonly thinkingLevel: string
  /** True while a run, compaction, retry or queued continuation is in progress. */
  readonly busy: boolean
  /** Observe future events in arrival order; call the returned function to unsubscribe. Embedded hosts isolate listener exceptions. */
  subscribe(listener: (event: PiHostEvent) => void): () => void
  /**
   * Resolve on acceptance, before background completion. Preflight failures reject; embedded-host
   * failures after acceptance emit error. Subscribe before calling to observe synchronous events.
   */
  prompt(text: string, images?: PiHostImage[]): Promise<PiPromptDisposition>
  /** Queue input before the next model call, or report extension handling; resolves on acceptance, not execution. */
  steer(text: string, images?: PiHostImage[]): Promise<PiInputDisposition>
  /** Queue input after tool calls and steering drain, or report handling; resolves on acceptance, not execution. */
  followUp(text: string, images?: PiHostImage[]): Promise<PiInputDisposition>
  /** Abort the current operation and wait for native idle; events independently describe the interrupted run. */
  abort(): Promise<void>
  /** Resolve the models available under the host credentials; listing failures reject. */
  listModels(): Promise<PiHostModel[]>
  /** Select provider/id; embedded hosts reject MODEL_NOT_FOUND for unavailable references and propagate native mutation failure. */
  setModel(ref: string): Promise<void>
  /** Return the active model's supported thinking levels; the embedded host returns a mutable copy. */
  availableThinkingLevels(): string[]
  /** Apply a level and return Pi's effective value, which may be clamped to model capabilities. */
  setThinkingLevel(level: string): string
  /** Replace active permission tools, retaining any configured output tool; does not change process rights. */
  setActiveTools(names: string[]): void
  /**
   * Optional direct-output port. OutputSession supplies the definition through PiBackendSession,
   * awaits registration before dispatch, and disables with undefined on terminal/rejection/cleanup.
   * Native calls await tool.execute; acceptance requests termination but completion still needs settled.
   * Embedded hosts reject installation while busy, allow disabling while busy and ignore calls after disposal.
   */
  setOutputTool?(tool?: StructuredOutputToolDefinition): Promise<void>
  /** Entries on the active branch, oldest first. */
  entries(): PiHostEntry[]
  /** Abort current work, then await manual compaction; return its summary if present or reject the native failure. */
  compact(instructions?: string): Promise<{ summary?: string }>
  /**
   * Open a separately owned persisted branch through entryId; null starts an empty persisted session.
   * The caller must supply a verified branch boundary and dispose the returned host. Embedded hosts
   * reject FORK_NEEDS_PERSISTENCE or FORK_FAILED; source ownership remains with the caller.
   */
  fork(entryId: string | null): Promise<PiSessionHost>
  /** Whether sessions are persisted so resume and fork can work. */
  readonly persistent: boolean
  /** Release observation and native resources once; embedded disposal requests abort without waiting for idle. Abort first if idle completion is required. */
  dispose(): Promise<void>
}

/** Host acquisition policy supplied by PiBackendSession or a direct host consumer. */
export interface PiHostOpenOptions {
  /** Working directory for resources and session discovery. */
  cwd: string
  mode: 'new' | 'resume'
  /** Required by the embedded host for persisted resume; ignored for new or in-memory sessions. */
  sessionId?: string
  /** Nonempty provider/id; omission or an empty string lets Pi select its default model. */
  model?: string
  /** Initial thinking preference; omission or an empty string uses native defaults. */
  thinkingLevel?: string
  /** Allowlist of Pi tool names; `undefined` keeps Pi defaults, `[]` disables tools. */
  tools?: string[]
  /** Nonempty text appended to the native system prompt. */
  instructions?: string
  /** Global Pi configuration directory; omission uses Pi's agent directory. */
  agentDir?: string
  /** Session storage override; omission uses Pi's cwd-derived session location. */
  sessionDir?: string
  /** False forces a new in-memory manager even in resume mode. True enables session files and forks. */
  persist: boolean
}
/** Open one owned host; callers must dispose successful acquisitions. Rejection returns no host to release. */
export type PiHostFactory = (options: PiHostOpenOptions) => Promise<PiSessionHost>

/**
 * Normalize a native message for event and history consumers, dropping unsupported metadata and
 * replacing unknown blocks with empty text. The envelope is new; nested tool arguments retain their
 * original object identity. No redaction occurs here.
 */
export function toHostMessage(value: unknown): PiHostMessage {
  const message = record(value)
  const content = message.content
  const usage = record(message.usage)
  return {
    role: typeof message.role === 'string' ? message.role : 'unknown',
    content: typeof content === 'string' ? content : Array.isArray(content) ? content.map(toHostContent) : '',
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

/** Normalize native notifications for the embedded host subscription; unsupported events and update phases return undefined. Raw tool payloads retain identity. */
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

/**
 * Open an embedded Pi session with native resources and credentials. Persisted resume requires a
 * discoverable sessionId or rejects SESSION_NOT_FOUND; a nonempty unavailable model rejects
 * MODEL_NOT_FOUND. Native loading/setup failures also reject. Await disposal of each returned host;
 * abort first when native idle completion is required before releasing observation.
 */
export const createPiHost: PiHostFactory = async (open: PiHostOpenOptions) => {
  const pi = await import('@earendil-works/pi-coding-agent')
  let manager
  if (!open.persist) manager = pi.SessionManager.inMemory(open.cwd)
  else if (open.mode === 'resume') {
    const file = open.sessionId ? pi.SessionManager.findById(open.cwd, open.sessionId, open.sessionDir) : undefined
    if (!file) throw new Error('SESSION_NOT_FOUND')
    manager = pi.SessionManager.open(file, open.sessionDir)
  } else manager = pi.SessionManager.create(open.cwd, open.sessionDir)
  return createHostFromManager({ pi, open, sessionManager: manager, persistent: open.persist })
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Normalize branch entries for entries(); parse native ISO timestamps and retain non-message ancestry. */
function entryToHost(entry: unknown): PiHostEntry {
  const value = record(entry)
  const base = { id: String(value.id ?? ''), parentId: typeof value.parentId === 'string' ? value.parentId : null, ...(typeof value.timestamp === 'string' ? { timestamp: Date.parse(value.timestamp) } : {}) }
  if (value.type === 'message') return { ...base, kind: 'message', message: toHostMessage(value.message) }
  if (value.type === 'compaction') return { ...base, kind: 'compaction', ...(typeof value.summary === 'string' ? { summary: value.summary } : {}) }
  return { ...base, kind: 'other' }
}

/** Embedded implementation owned by the backend or direct factory caller; subscribes before any prompt can run. */
class DefaultPiHost implements PiSessionHost {
  /** Capture native dependencies and register normalization before exposing the host to its owner. */
  constructor({ session, pi, open, persistent, extensions }: {
    session: AgentSession; pi: PiSdk; open: PiHostOpenOptions; persistent: boolean; extensions: ExtensionAPI
  }) {
    this.session = session
    this.pi = pi
    this.open = open
    this.persistent = persistent
    this.extensions = extensions
    this.unsubscribe = session.subscribe(event => {
      // Pi validates with coercion before execute(). Preserve the original arguments for SDK validation.
      if (event.type === 'tool_execution_start' && event.toolName === this.outputTool) this.outputCalls.set(event.toolCallId, structuredClone(event.args))
      if (event.type === 'tool_execution_end') this.outputCalls.delete(event.toolCallId)
      const mapped = toHostEvent(event)
      if (mapped) this.emit(mapped)
    })
  }
  get sessionId(): string { return this.session.sessionId }
  get model(): string | undefined { const model = this.session.model; return model ? `${model.provider}/${model.id}` : undefined }
  get thinkingLevel(): string { return this.session.thinkingLevel }
  get busy(): boolean { return !this.session.isIdle }
  subscribe(listener: (event: PiHostEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Resolve Pi's preflight callback immediately; route later run rejection to error events instead of changing acceptance. */
  prompt(text: string, images?: PiHostImage[]): Promise<PiPromptDisposition> {
    return new Promise<PiPromptDisposition>((resolve, reject) => {
      let settledPreflight = false
      const run = this.session.prompt(text, { ...(images ? { images: hostImages(images) } : {}), source: 'rpc', preflightResult: disposition => { settledPreflight = true; resolve(disposition) } })
      run.then(() => { if (!settledPreflight) resolve('handled') }, cause => {
        if (!settledPreflight) reject(cause)
        else this.emit({ type: 'error', message: cause instanceof Error ? cause.message : 'Pi run failed' })
      })
    })
  }
  steer(text: string, images?: PiHostImage[]): Promise<PiInputDisposition> { return this.session.steer(text, images ? hostImages(images) : undefined, { source: 'rpc' }) }
  followUp(text: string, images?: PiHostImage[]): Promise<PiInputDisposition> { return this.session.followUp(text, images ? hostImages(images) : undefined, { source: 'rpc' }) }
  abort(): Promise<void> { return this.session.abort() }
  /** Build picker metadata from credential-available models; only explicit null mappings remove reasoning levels. */
  async listModels(): Promise<PiHostModel[]> {
    const models = await this.session.modelRuntime.getAvailable()
    return models.map(model => ({
      ref: `${model.provider}/${model.id}`, name: model.name ?? model.id, reasoning: model.reasoning,
      thinkingLevels: model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => (model.thinkingLevelMap as Record<string, unknown> | undefined)?.[level] !== null) : ['off'],
      contextWindow: model.contextWindow,
    }))
  }
  /** Validate the reference before awaiting native selection, so unavailable models cannot change session state. */
  async setModel(ref: string): Promise<void> {
    const model = resolveModel(this.session.modelRuntime, ref)
    if (!model) throw new Error('MODEL_NOT_FOUND')
    await this.session.setModel(model)
  }
  availableThinkingLevels(): string[] { return [...this.session.getAvailableThinkingLevels()] }
  setThinkingLevel(level: string): string { this.session.setThinkingLevel(level as Parameters<AgentSession['setThinkingLevel']>[0]); return this.session.thinkingLevel }
  /** Permission changes retain the current output tool so a structured submission can still finish. */
  setActiveTools(names: string[]): void { this.extensions.setActiveTools([...new Set([...names, ...(this.outputTool ? [this.outputTool] : [])])]) }
  /** Replace or disable the submission tool while retaining permission tools; disabling is allowed during terminal cleanup. */
  async setOutputTool(tool?: StructuredOutputToolDefinition): Promise<void> {
    if (this.disposed) return
    if (tool && this.busy) throw new Error('STRUCTURED_OUTPUT_BUSY')
    this.outputCalls.clear()
    const active = this.extensions.getActiveTools().filter(name => name !== this.outputTool)
    if (tool) {
      const definition = createOutputTool(tool, this.outputCalls)
      const name = definition.name
      this.extensions.registerTool(definition)
      this.outputTool = name
      this.extensions.setActiveTools([...new Set([...active, name])])
    } else {
      this.extensions.setActiveTools(active)
      this.outputTool = undefined
    }
  }
  entries(): PiHostEntry[] { return this.session.sessionManager.getBranch().map(entryToHost) }
  /** Await native manual compaction and expose only its optional textual summary. */
  async compact(instructions?: string): Promise<{ summary?: string }> {
    const result = await this.session.compact(instructions)
    const summary = record(result).summary
    return typeof summary === 'string' ? { summary } : {}
  }
  /** Branch a separately opened manager so the source host keeps its identity and active branch. */
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
    return createHostFromManager({ pi: this.pi, open: { ...this.open, mode: 'resume' }, sessionManager: forked, persistent: true })
  }
  /** Detach observers and raw-call retention before native disposal; repeated calls do not repeat cleanup. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.listeners.clear()
    this.outputCalls.clear()
    this.session.dispose()
  }
  readonly persistent: boolean
  private readonly session: AgentSession
  private readonly pi: PiSdk
  private readonly open: PiHostOpenOptions
  private readonly extensions: ExtensionAPI
  private readonly listeners = new Set<(event: PiHostEvent) => void>()
  private unsubscribe?: () => void
  private disposed = false
  private outputTool?: string
  private readonly outputCalls = new Map<string, unknown>()
  /** Dispatch a snapshot so listener removal/reentrancy cannot change the current notification pass. */
  private emit(event: PiHostEvent): void { for (const listener of [...this.listeners]) { try { listener(event) } catch { /* a listener must not break Pi's loop */ } } }
}

/**
 * Finish new/resumed/forked acquisition after manager selection. Resource loading captures the
 * extension API before session creation; missing tool support disposes the session and rejects.
 */
async function createHostFromManager({ pi, open, sessionManager, persistent }: {
  pi: PiSdk; open: PiHostOpenOptions; sessionManager: SessionManager; persistent: boolean
}): Promise<PiSessionHost> {
  const agentDir = open.agentDir ?? pi.getAgentDir()
  const settingsManager = pi.SettingsManager.create(open.cwd, agentDir)
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') })
  const model = open.model ? resolveModel(modelRuntime, open.model) : undefined
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
  const host = new DefaultPiHost({ session, pi, open, persistent, extensions })
  if (open.tools) host.setActiveTools(open.tools)
  return host
}

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** Resolve provider/id at its first slash for open and setModel; missing separators or model matches return undefined. */
function resolveModel(runtime: AgentSession['modelRuntime'], ref: string) {
  const slash = ref.indexOf('/')
  return slash > 0 ? runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1)) : undefined
}

/** Add native image block tags without changing the base64 payloads. */
function hostImages(images: PiHostImage[]) {
  return images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
}

/**
 * Build the model-facing output tool and its submission-bound callback. Pi invokes execute after
 * coercive validation; prefer arguments captured by the host subscription before that validation.
 * Acceptance requests native termination; rejection returns tool error content for correction.
 */
function createOutputTool(tool: StructuredOutputToolDefinition, calls: ReadonlyMap<string, unknown>): Parameters<ExtensionAPI['registerTool']>[0] {
  // Keep object schemas as actual parameters; other roots need Pi's object-shaped value envelope.
  const definition = structuredClone({ name: tool.name, description: tool.description, schema: tool.schema })
  const object = typeof definition.schema === 'object' && definition.schema.type === 'object'
  // A nested resource keeps local references rooted at the original schema for non-object values.
  const valueSchema = typeof definition.schema === 'boolean' ? definition.schema : { ...definition.schema, $id: definition.schema.$id ?? 'urn:anureo:output-result' }
  const parameters = object ? definition.schema : {
    ...(typeof definition.schema === 'object' && definition.schema.$schema ? { $schema: definition.schema.$schema } : {}),
    type: 'object', properties: { value: valueSchema }, required: ['value'], additionalProperties: false,
  }
  const execute = tool.execute
  return {
    name: definition.name, label: 'Submit result', description: definition.description,
    parameters: Type.Unsafe<Record<string, unknown>>(parameters),
    async execute(id, args) {
      const original = calls.has(id) ? calls.get(id) : args
      const result = await execute(object ? original : record(original).value)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result,
        ...(result.accepted ? { terminate: true } : { isError: true }) }
    },
  }
}

/** Normalize block variants for toHostMessage; preserve tool-argument identity and empty unknown blocks. */
function toHostContent(part: unknown): PiHostContent {
  const block = record(part)
  if (block.type === 'text') return { type: 'text', text: String(block.text ?? '') }
  if (block.type === 'thinking') return { type: 'thinking', thinking: String(block.thinking ?? '') }
  if (block.type === 'toolCall') return { type: 'toolCall', id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: record(block.arguments) }
  if (block.type === 'image') return { type: 'image', ...(typeof block.data === 'string' ? { data: block.data } : {}), ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}) }
  return { type: 'text', text: '' }
}
