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

/** Native token counts, including separate cache reads and writes. Pi reports the total separately. */
export interface PiHostUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }

/** Message snapshot for live publication and history mapping. Redact sensitive content before publishing it. */
export interface PiHostMessage {
  role: string
  content: string | PiHostContent[]
  /** On toolResult messages, identifies the earlier tool call whose history item is completed. */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  stopReason?: string
  /** Raw native error text. PiBackendSession publishes a sanitized error instead. */
  errorMessage?: string
  usage?: PiHostUsage
  model?: string
  provider?: string
  /** Native timestamp in milliseconds since the Unix epoch. */
  timestamp?: number
}

/**
 * Ordered, unredacted notifications for PiBackendSession. It treats agent_end as the end of one
 * attempt and uses settled to finish the SDK turn after retries and queued continuations.
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
  /** The native source was lost. PiBackendSession fails observation without emitting a terminal turn. */
  | { type: 'failed'; code: string }

/** One active-branch transcript entry; parentId preserves ancestry for before/through forks. */
export interface PiHostEntry {
  id: string
  /** Previous entry in this branch, or null at its root. */
  parentId: string | null
  kind: 'message' | 'compaction' | 'other'
  message?: PiHostMessage
  summary?: string
  /** Native timestamp in milliseconds since the Unix epoch. */
  timestamp?: number
}

/** Available provider model and picker/config metadata, without credentials. */
export interface PiHostModel {
  /** `provider/id` reference accepted by setModel. */
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
/** Inline image bytes encoded as base64, paired with their MIME type. */
export interface PiHostImage { data: string; mimeType: string }

/**
 * Implement this port to supply PiAdapter with an owned session through PiAdapterOptions.createHost.
 * PiBackendSession observes and disposes each acquired host. Publish raw values for adapter redaction
 * and use events to report execution separately from input acceptance. PiBackendSession maps native
 * request failures to SDK errors.
 */
export interface PiSessionHost {
  /** Native identity used for the SDK binding and persisted session lookup. */
  readonly sessionId: string
  /** `provider/id` of the active model, if any. */
  readonly model?: string
  /** Effective thinking level after applying the active model's constraints. */
  readonly thinkingLevel: string
  /** True while the host has work in progress, including retries and queued continuations. */
  readonly busy: boolean
  /** Observe future events in arrival order. Call the returned function to unsubscribe. Embedded hosts isolate listener exceptions. */
  subscribe(listener: (event: PiHostEvent) => void): () => void
  /**
   * Resolve on acceptance, before background completion. Preflight failures reject. The embedded
   * host emits error for failures after acceptance. Subscribe first to observe synchronous events.
   */
  prompt(text: string, images?: PiHostImage[]): Promise<PiPromptDisposition>
  /** Queue input before the next model call or report extension handling. Resolve on acceptance. */
  steer(text: string, images?: PiHostImage[]): Promise<PiInputDisposition>
  /** Queue input after tool calls and steering drain or report extension handling. Resolve on acceptance. */
  followUp(text: string, images?: PiHostImage[]): Promise<PiInputDisposition>
  /** Abort the current operation and wait for native idle; events independently describe the interrupted run. */
  abort(): Promise<void>
  /** Resolve the models available under the host credentials; listing failures reject. */
  listModels(): Promise<PiHostModel[]>
  /** Select a model by provider/id. The embedded host rejects MODEL_NOT_FOUND for an unknown reference and propagates native selection failures. */
  setModel(ref: string): Promise<void>
  /** Return the active model's supported thinking levels; the embedded host returns a mutable copy. */
  availableThinkingLevels(): string[]
  /** Apply a level and return Pi's effective value, which may be clamped to model capabilities. */
  setThinkingLevel(level: string): string
  /** Change the tools exposed to the model while retaining any configured output tool. Process rights are independent of this allowlist. */
  setActiveTools(names: string[]): void
  /**
   * Configure the optional tool for submitting structured results. OutputSession supplies the
   * definition through PiBackendSession and awaits installation before dispatch. It passes
   * undefined to disable the tool during terminal processing, rejection recovery or teardown.
   * Pi awaits tool.execute. An accepted result requests termination, and the turn completes on
   * settlement. The embedded host rejects installation with STRUCTURED_OUTPUT_BUSY while busy,
   * permits disabling while busy and ignores calls after disposal.
   */
  setOutputTool?(tool?: StructuredOutputToolDefinition): Promise<void>
  /** Entries on the active branch, oldest first. */
  entries(): PiHostEntry[]
  /**
   * Abort current work before compacting. Optional instructions guide the summary.
   * Resolve with the summary if present or reject a native failure.
   */
  compact(instructions?: string): Promise<{ summary?: string }>
  /**
   * Open a separately owned persisted branch through entryId; null starts an empty persisted session.
   * Supply a verified branch boundary and dispose the returned host separately from the source.
   * The embedded host can reject FORK_NEEDS_PERSISTENCE, FORK_FAILED or a native open or branch failure.
   */
  fork(entryId: string | null): Promise<PiSessionHost>
  /** Whether sessions are persisted so resume and fork can work. */
  readonly persistent: boolean
  /** Release observation and native resources once. Embedded disposal requests abort without awaiting idle. */
  dispose(): Promise<void>
}

/** Host acquisition policy supplied by PiBackendSession or a direct host consumer. */
export interface PiHostOpenOptions {
  /** Working directory for resources and session discovery. */
  cwd: string
  mode: 'new' | 'resume'
  /** Required by the embedded host for persisted resume; ignored for new or in-memory sessions. */
  sessionId?: string
  /** Nonempty provider/id. Omission or an empty string lets Pi restore a saved model or select a default. */
  model?: string
  /** Initial thinking preference. Omission or an empty string lets Pi restore a saved level or select a default. */
  thinkingLevel?: string
  /** Initial active Pi tool names. Omission keeps Pi defaults and `[]` supplies an empty allowlist. */
  tools?: string[]
  /** Nonempty text appended to the native system prompt. */
  instructions?: string
  /** Global Pi configuration directory. Omission uses Pi's agent directory. */
  agentDir?: string
  /** Session storage override. Omission uses Pi's cwd-derived session location for discovery and new sessions. */
  sessionDir?: string
  /** False forces a new in-memory manager even in resume mode. True enables session files and forks. */
  persist: boolean
}
/** Open one owned host; callers must dispose successful acquisitions. Rejection returns no host to release. */
export type PiHostFactory = (options: PiHostOpenOptions) => Promise<PiSessionHost>

/**
 * Normalize a native message for toHostEvent and entryToHost. Unsupported metadata is dropped
 * and unknown blocks become empty text. Tool arguments retain their object identity, and message
 * content remains unredacted until adapter mapping.
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
    ...(typeof usage.input === 'number' ? {
      usage: {
        input: usage.input,
        output: Number(usage.output ?? 0),
        cacheRead: Number(usage.cacheRead ?? 0),
        cacheWrite: Number(usage.cacheWrite ?? 0),
        totalTokens: Number(usage.totalTokens ?? 0),
      },
    } : {}),
  }
}

/**
 * Translate a native notification for the embedded host's listener dispatch. Return undefined
 * for events or update phases the host omits. Raw tool payloads retain identity for adapter mapping.
 */
export function toHostEvent(event: AgentSessionEvent): PiHostEvent | undefined {
  switch (event.type) {
    case 'agent_start': return { type: 'agent_start' }
    case 'agent_end': return { type: 'agent_end', willRetry: event.willRetry }
    case 'agent_settled': return { type: 'settled', aborted: event.aborted }
    case 'message_start': return { type: 'message_start', message: toHostMessage(event.message) }
    case 'message_end': return { type: 'message_end', message: toHostMessage(event.message) }
    case 'message_update': return messageUpdateToHost(event)
    case 'tool_execution_start': return { type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args }
    case 'tool_execution_update': return { type: 'tool_update', id: event.toolCallId, name: event.toolName, partial: event.partialResult }
    case 'tool_execution_end': return { type: 'tool_end', id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError }
    case 'compaction_start': return { type: 'compaction_start', reason: event.reason }
    case 'compaction_end': return {
      type: 'compaction_end', reason: event.reason, aborted: event.aborted,
      ...(event.result && typeof record(event.result).summary === 'string' ? { summary: String(record(event.result).summary) } : {}),
      ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    }
    case 'auto_retry_start': return { type: 'retry', phase: 'start', attempt: event.attempt }
    case 'auto_retry_end': return { type: 'retry', phase: 'end', attempt: event.attempt, success: event.success }
    case 'session_info_changed': return { type: 'session_name', ...(event.name ? { name: event.name } : {}) }
    default: return undefined
  }
}

/**
 * Open an embedded Pi session with native resources and credentials. Persisted resume requires a
 * discoverable sessionId or rejects SESSION_NOT_FOUND. An unknown nonempty model reference
 * rejects MODEL_NOT_FOUND. Native loading and setup failures also reject. Await disposal of each
 * returned host. Abort first when native idle completion is required before releasing observation.
 */
export const createPiHost: PiHostFactory = async (open: PiHostOpenOptions) => {
  const pi = await import('@earendil-works/pi-coding-agent')
  const sessionManager = openSessionManager(pi, open)
  return createHostFromManager({ pi, open, sessionManager, persistent: open.persist })
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Preserve branch ancestry even for entries the adapter skips when mapping history. */
function entryToHost(entry: unknown): PiHostEntry {
  const value = record(entry)
  const base = {
    id: String(value.id ?? ''),
    parentId: typeof value.parentId === 'string' ? value.parentId : null,
    ...(typeof value.timestamp === 'string' ? { timestamp: Date.parse(value.timestamp) } : {}),
  }
  if (value.type === 'message') return { ...base, kind: 'message', message: toHostMessage(value.message) }
  if (value.type === 'compaction') return { ...base, kind: 'compaction', ...(typeof value.summary === 'string' ? { summary: value.summary } : {}) }
  return { ...base, kind: 'other' }
}

/** Build block updates for toHostEvent. Pi's other assistant update kinds produce no host event. */
function messageUpdateToHost(event: Extract<AgentSessionEvent, { type: 'message_update' }>): HostMessageUpdate | undefined {
  const inner = event.assistantMessageEvent
  const match = /^(text|thinking|toolcall)_(start|delta|end)$/.exec(inner.type)
  if (!match) return undefined
  const kind = match[1] as HostMessageUpdate['update']['kind']
  const phase = match[2] as HostMessageUpdate['update']['phase']
  const index = 'contentIndex' in inner ? inner.contentIndex : 0
  return {
    type: 'message_update',
    message: toHostMessage(event.message),
    update: { kind, phase, index, ...('delta' in inner ? { delta: inner.delta } : {}) },
  }
}

type HostMessageUpdate = Extract<PiHostEvent, { type: 'message_update' }>

/** Select a native manager before opening resources. Persisted resume throws if the ID cannot be found. */
function openSessionManager(pi: PiSdk, open: PiHostOpenOptions): SessionManager {
  if (!open.persist) return pi.SessionManager.inMemory(open.cwd)
  if (open.mode !== 'resume') return pi.SessionManager.create(open.cwd, open.sessionDir)
  const file = open.sessionId ? pi.SessionManager.findById(open.cwd, open.sessionId, open.sessionDir) : undefined
  if (!file) throw new Error('SESSION_NOT_FOUND')
  return pi.SessionManager.open(file, open.sessionDir)
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
    this.unsubscribe = session.subscribe(event => this.onNativeEvent(event))
  }
  get sessionId(): string { return this.session.sessionId }
  get model(): string | undefined { const model = this.session.model; return model ? `${model.provider}/${model.id}` : undefined }
  get thinkingLevel(): string { return this.session.thinkingLevel }
  get busy(): boolean { return !this.session.isIdle }
  subscribe(listener: (event: PiHostEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /**
   * PiBackendSession.submit awaits the native preflight disposition to return its receipt.
   * A native prompt that resolves without a preflight callback is reported as handled. If Pi
   * rejects after invoking the callback, the error goes to listeners as a run failure.
   */
  prompt(text: string, images?: PiHostImage[]): Promise<PiPromptDisposition> {
    return new Promise<PiPromptDisposition>((resolve, reject) => {
      let reportedPreflight = false
      const run = this.session.prompt(text, {
        ...(images ? { images: hostImages(images) } : {}),
        source: 'rpc',
        preflightResult: disposition => {
          reportedPreflight = true
          resolve(disposition)
        },
      })
      run.then(() => { if (!reportedPreflight) resolve('handled') }, cause => {
        if (!reportedPreflight) reject(cause)
        else this.emit({ type: 'error', message: cause instanceof Error ? cause.message : 'Pi run failed' })
      })
    })
  }
  steer(text: string, images?: PiHostImage[]): Promise<PiInputDisposition> { return this.session.steer(text, images ? hostImages(images) : undefined, { source: 'rpc' }) }
  followUp(text: string, images?: PiHostImage[]): Promise<PiInputDisposition> { return this.session.followUp(text, images ? hostImages(images) : undefined, { source: 'rpc' }) }
  abort(): Promise<void> { return this.session.abort() }
  /**
   * Supply models to createPiCatalogSession and PiBackendSession.setConfig. For reasoning
   * models, an explicit null in Pi's level map removes that level from the supported list.
   */
  async listModels(): Promise<PiHostModel[]> {
    const models = await this.session.modelRuntime.getAvailable()
    return models.map(model => ({
      ref: `${model.provider}/${model.id}`, name: model.name ?? model.id, reasoning: model.reasoning,
      thinkingLevels: model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter(level => (model.thinkingLevelMap as Record<string, unknown> | undefined)?.[level] !== null) : ['off'],
      contextWindow: model.contextWindow,
    }))
  }
  /** Resolve the model before mutating the session. Pi checks credentials during selection. */
  async setModel(ref: string): Promise<void> {
    const model = resolveModel(this.session.modelRuntime, ref)
    if (!model) throw new Error('MODEL_NOT_FOUND')
    await this.session.setModel(model)
  }
  availableThinkingLevels(): string[] { return [...this.session.getAvailableThinkingLevels()] }
  setThinkingLevel(level: string): string {
    this.session.setThinkingLevel(level as Parameters<AgentSession['setThinkingLevel']>[0])
    return this.session.thinkingLevel
  }
  /** Permission changes retain the current output tool so a structured submission can still finish. */
  setActiveTools(names: string[]): void { this.extensions.setActiveTools([...new Set([...names, ...(this.outputTool ? [this.outputTool] : [])])]) }
  /** Replace or disable the submission tool while retaining permission tools; disabling is allowed during terminal cleanup. */
  async setOutputTool(tool?: StructuredOutputToolDefinition): Promise<void> {
    if (this.disposed) return
    if (tool && this.busy) throw new Error('STRUCTURED_OUTPUT_BUSY')
    this.outputCalls.clear()
    const active = this.extensions.getActiveTools().filter(name => name !== this.outputTool)
    if (!tool) {
      this.extensions.setActiveTools(active)
      this.outputTool = undefined
      return
    }
    const definition = createOutputTool(tool, this.outputCalls)
    const name = definition.name
    this.extensions.registerTool(definition)
    this.outputTool = name
    this.extensions.setActiveTools([...new Set([...active, name])])
  }
  entries(): PiHostEntry[] { return this.session.sessionManager.getBranch().map(entryToHost) }
  /** Await native manual compaction and expose only its optional textual summary. */
  async compact(instructions?: string): Promise<{ summary?: string }> {
    const result = await this.session.compact(instructions)
    const summary = record(result).summary
    return typeof summary === 'string' ? { summary } : {}
  }
  /**
   * PiBackendSession.forkHost passes a verified leaf and uses the returned host for the new SDK
   * session. Branch a separately opened manager so the source keeps its identity and active branch.
   */
  async fork(entryId: string | null): Promise<PiSessionHost> {
    if (!this.persistent) throw new Error('FORK_NEEDS_PERSISTENCE')
    const manager = this.session.sessionManager
    let forked
    if (entryId === null) forked = this.pi.SessionManager.create(this.open.cwd, this.open.sessionDir)
    else {
      // Pi assigns a session-file path to persisted managers before flushing their transcript.
      const source = this.pi.SessionManager.open(manager.getSessionFile()!, this.open.sessionDir)
      if (!source.createBranchedSession(entryId)) throw new Error('FORK_FAILED')
      forked = source
    }
    return createHostFromManager({ pi: this.pi, open: { ...this.open, mode: 'resume' }, sessionManager: forked, persistent: true })
  }
  /** Detach observers and clear cached arguments before Pi disposal. Repeated calls skip cleanup. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
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

  /**
   * Handle notifications from the Pi subscription registered by the constructor. Record raw output
   * arguments before Pi coerces them, release them at tool end, and send supported events to listeners.
   */
  private onNativeEvent(event: AgentSessionEvent): void {
    if (event.type === 'tool_execution_start' && event.toolName === this.outputTool) {
      this.outputCalls.set(event.toolCallId, structuredClone(event.args))
    }
    if (event.type === 'tool_execution_end') this.outputCalls.delete(event.toolCallId)
    const mapped = toHostEvent(event)
    if (mapped) this.emit(mapped)
  }

  /** Dispatch synchronously over a snapshot so subscription changes apply to subsequent notifications. */
  private emit(event: PiHostEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* a listener must not break Pi's loop */ }
    }
  }
}

/**
 * Initialize resources for createPiHost and DefaultPiHost.fork, then open the native session.
 * Pi's loader invokes the extension factory during reload to supply the API for tool registration.
 * If capture fails, dispose the native session and reject before returning ownership.
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
    ...(open.thinkingLevel ? { thinkingLevel: open.thinkingLevel as Parameters<AgentSession['setThinkingLevel']>[0] } : {}),
  })
  if (!extensions) {
    session.dispose()
    throw new Error('PI_OUTPUT_TOOLS_UNAVAILABLE')
  }
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
 * Build the tool that DefaultPiHost.setOutputTool registers for an SDK submission. Pi invokes
 * execute after coercive validation. Use the cached raw arguments when available so the SDK's
 * callback validates the original input. An accepted result requests native termination, a
 * declined result becomes tool error content, and callback exceptions propagate to Pi.
 */
function createOutputTool(tool: StructuredOutputToolDefinition, calls: ReadonlyMap<string, unknown>): Parameters<ExtensionAPI['registerTool']>[0] {
  const definition = structuredClone({ name: tool.name, description: tool.description, schema: tool.schema })
  const { parameters, wrapped } = outputToolParameters(definition.schema)
  const execute = tool.execute
  return {
    name: definition.name, label: 'Submit result', description: definition.description,
    parameters: Type.Unsafe<Record<string, unknown>>(parameters),
    async execute(id, args) {
      const original = calls.has(id) ? calls.get(id) : args
      const result = await execute(wrapped ? record(original).value : original)
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result,
        ...(result.accepted ? { terminate: true } : { isError: true }) }
    },
  }
}

/** Use object schemas directly and wrap other roots in Pi's required object-shaped parameters. */
function outputToolParameters(schema: StructuredOutputToolDefinition['schema']) {
  const object = typeof schema === 'object' && schema.type === 'object'
  // A nested resource keeps local references rooted at the original schema for non-object values.
  const valueSchema = typeof schema === 'boolean' ? schema : { ...schema, $id: schema.$id ?? 'urn:anureo:output-result' }
  const parameters = object ? schema : {
    ...(typeof schema === 'object' && schema.$schema ? { $schema: schema.$schema } : {}),
    type: 'object', properties: { value: valueSchema }, required: ['value'], additionalProperties: false,
  }
  return { parameters, wrapped: !object }
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
