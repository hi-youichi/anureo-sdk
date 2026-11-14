/** In-memory Pi host for adapter, workflow and application tests. */
import { randomUUID } from 'node:crypto'
import type {
  PiHostEntry, PiHostEvent, PiHostFactory, PiHostMessage, PiHostModel, PiHostOpenOptions, PiInputDisposition, PiPromptDisposition, PiSessionHost,
} from '../src/host'

/** Fixed token counts used to verify aggregation across scripted assistant messages. */
export const usage = { input: 7, output: 9, cacheRead: 2, cacheWrite: 1, totalTokens: 19 }
/** Model/thinking-level combinations exposed to configuration tests. */
export const MODELS: PiHostModel[] = [
  { ref: 'fake/small', name: 'Small', reasoning: false, thinkingLevels: ['off'] },
  { ref: 'fake/big', name: 'Big', reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high'] },
]
/** Supply the body of a run. FakePiHost invokes it after the user entry and treats rejection as interrupted settlement. */
export type Script = (host: FakePiHost, text: string) => Promise<void>

/** Drive native events through PiBackendSession. Tests can hold or release execution while the SDK owns host disposal. */
export class FakePiHost implements PiSessionHost {
  /** Retain factory options for inspection and child forks; construction does not run a script. */
  constructor(readonly open: PiHostOpenOptions) {}

  /** Notify a listener snapshot synchronously; listener exceptions propagate to the test/script. */
  emit(event: PiHostEvent): void { for (const listener of [...this.listeners]) listener(event) }
  /** Append an entry linked to the previous entry, retaining message identity for scripted history. */
  append(message: PiHostMessage): PiHostEntry {
    const parent = this.entriesList.at(-1)
    const entry: PiHostEntry = { id: `e${++this.seq}`, parentId: parent?.id ?? null, kind: 'message', message }
    this.entriesList.push(entry)
    return entry
  }
  /** Append a user entry between start/end callbacks so the adapter can find it when processing message_end. */
  user(text: string): void {
    const message: PiHostMessage = { role: 'user', content: [{ type: 'text', text }] }
    this.emit({ type: 'message_start', message })
    this.append(message)
    this.emit({ type: 'message_end', message })
  }
  /** Emit one streamed text block followed by its final message. Override stopReason or errorMessage to exercise native outcomes. */
  async assistant(text: string, extra: Partial<PiHostMessage> = {}): Promise<void> {
    const message: PiHostMessage = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage, ...extra }
    this.emit({ type: 'message_start', message: { ...message, content: [] } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'start', index: 0 } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'delta', index: 0, delta: text } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'end', index: 0 } })
    this.append(message)
    this.emit({ type: 'message_end', message })
  }
  /** Emit a tool execution between its assistant call and result messages. isError defaults to false. */
  async toolRound({ id, name, args, output, isError = false }: {
    id: string
    name: string
    args: Record<string, unknown>
    output: string
    isError?: boolean
  }): Promise<void> {
    const call: PiHostMessage = { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', usage }
    this.emit({ type: 'message_start', message: call })
    this.append(call)
    this.emit({ type: 'message_end', message: call })
    this.emit({ type: 'tool_start', id, name, args })
    this.emit({ type: 'tool_end', id, name, result: { content: [{ type: 'text', text: output }] }, isError })
    const result: PiHostMessage = { role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text: output }] }
    this.append(result)
    this.emit({ type: 'message_start', message: result })
    this.emit({ type: 'message_end', message: result })
  }
  /** PiBackendSession.open registers its event queue here and retains the returned unsubscribe for disposal. */
  subscribe(listener: (event: PiHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** Record input and reject promptError before scheduling. A handled receipt starts no run. Other receipts precede the scheduled script. */
  async prompt(text: string): Promise<PiPromptDisposition> {
    this.calls.push({ method: 'prompt', value: text })
    if (this.promptError) throw this.promptError
    if (this.promptDisposition === 'handled') return 'handled'
    this.busy = true
    setImmediate(() => { void this.run(text) })
    return this.promptDisposition
  }
  /** Record native delivery and return the configured disposition without executing another script. */
  async steer(text: string): Promise<PiInputDisposition> {
    this.calls.push({ method: 'steer', value: text })
    this.steered.push(text)
    return this.steerDisposition
  }
  /** Record after-turn input and return the shared delivery disposition. Tests emit any continuation events. */
  async followUp(text: string): Promise<PiInputDisposition> {
    this.calls.push({ method: 'followUp', value: text })
    this.followed.push(text)
    return this.steerDisposition
  }
  /** Request interrupted settlement and release hold; completion events still come from the script runner. */
  async abort(): Promise<void> {
    this.calls.push({ method: 'abort' })
    this.abortRequested = true
    this.release?.()
  }
  /** Hold until the test calls release or abort; an already requested abort resolves immediately. Only one hold is tracked. */
  hold(): Promise<void> {
    if (this.abortRequested) return Promise.resolve()
    return new Promise<void>(resolve => { this.release = resolve })
  }
  /** Return the shared test catalog for config validation and catalog queries. */
  async listModels(): Promise<PiHostModel[]> { return MODELS }
  /** Record the model selected by PiBackendSession after its own catalog validation. */
  async setModel(ref: string): Promise<void> { this.calls.push({ method: 'setModel', value: ref }); this.model = ref }
  /** Use off as the sole level when the selected model is absent from the test catalog. */
  availableThinkingLevels(): string[] { return MODELS.find(model => model.ref === this.model)?.thinkingLevels ?? ['off'] }
  /** Echo the selected level as effective so tests can inspect the applied config. */
  setThinkingLevel(level: string): string { this.calls.push({ method: 'setThinkingLevel', value: level }); this.thinkingLevel = level; return level }
  /** Record the permission-tool selection for assertions. */
  setActiveTools(names: string[]): void { this.calls.push({ method: 'setActiveTools', value: names }) }
  /** Return a detached branch snapshot for the adapter's history reads and turn-boundary lookup. */
  entries(): PiHostEntry[] { return structuredClone(this.entriesList) }
  /** Emit one manual compaction pair synchronously, allowing tests to exercise in-turn items or idle notices. */
  async compact(): Promise<{ summary?: string }> {
    this.calls.push({ method: 'compact' })
    this.emit({ type: 'compaction_start', reason: 'manual' })
    this.emit({ type: 'compaction_end', reason: 'manual', aborted: false, summary: 'compacted' })
    return { summary: 'compacted' }
  }
  /** Copy history through entryId, with null or an unknown ID producing an empty child. The caller owns the new host. */
  async fork(entryId: string | null): Promise<PiSessionHost> {
    this.calls.push({ method: 'fork', value: entryId })
    const child = new FakePiHost({ ...this.open, mode: 'resume' })
    child.script = this.script
    const keep = entryId === null ? -1 : this.entriesList.findIndex(entry => entry.id === entryId)
    child.entriesList.push(...structuredClone(this.entriesList.slice(0, keep + 1)))
    child.seq = this.seq
    child.sibling = this
    return child
  }
  /** Clear listeners and record disposal immediately. PiBackendSession requests abort separately when busy. */
  async dispose(): Promise<void> {
    this.calls.push({ method: 'dispose' })
    this.disposed = true
    this.listeners.clear()
  }

  readonly listeners = new Set<(event: PiHostEvent) => void>()
  readonly calls: Array<{ method: string; value?: unknown }> = []
  readonly steered: string[] = []
  readonly followed: string[] = []
  readonly entriesList: PiHostEntry[] = []
  sessionId = randomUUID()
  model: string | undefined = 'fake/big'
  thinkingLevel = 'medium'
  busy = false
  persistent = true
  disposed = false
  /** Shared receipt for both steer and follow-up. */
  steerDisposition: PiInputDisposition = 'queued'
  promptDisposition: PiPromptDisposition = 'started'
  promptError?: Error
  script: Script = async (host, text) => { await host.assistant(`done: ${text}`) }
  private seq = 0
  abortRequested = false
  /** Resolver installed by the most recent hold that needed to wait. */
  release?: () => void
  /** Source host retained by a forked child for test inspection. */
  sibling?: FakePiHost

  /** Complete the run scheduled by prompt. Clear busy before settled so the adapter can publish an idle session. */
  private async run(text: string): Promise<void> {
    this.emit({ type: 'agent_start' })
    this.user(text)
    let aborted = false
    try {
      await this.script(this, text)
    } catch {
      aborted = true
    }
    this.emit({ type: 'agent_end', willRetry: false })
    this.busy = false
    this.emit({ type: 'settled', aborted: aborted || this.abortRequested })
    this.abortRequested = false
  }
}

/**
 * Inject into PiAdapter or createPiCatalogSession and inspect their acquisition attempts and created
 * hosts. Resume copies history and the script from a stored new host and rejects unknown IDs.
 * The factory calls setup after recording the host so tests can replace scripts or install optional
 * ports. A setup exception rejects acquisition. PiBackendSession and createPiCatalogSession
 * dispose the hosts they acquire. Forked children are created separately by FakePiHost.fork.
 */
export function fakeFactory(setup?: (host: FakePiHost) => void): { factory: PiHostFactory; hosts: FakePiHost[]; opens: PiHostOpenOptions[] } {
  const hosts: FakePiHost[] = []
  const opens: PiHostOpenOptions[] = []
  const store = new Map<string, FakePiHost>()
  const factory: PiHostFactory = async options => {
    opens.push(options)
    const isResume = options.mode === 'resume'
    const host = isResume ? resume(options) : new FakePiHost(options)
    if (!isResume && options.model) host.model = options.model
    hosts.push(host)
    if (!isResume) store.set(host.sessionId, host)
    setup?.(host)
    return host
  }
  return { factory, hosts, opens }

  /** Copy the stored branch while retaining the native ID and script. The factory records the restored host. */
  function resume(options: PiHostOpenOptions): FakePiHost {
    const existing = options.sessionId ? store.get(options.sessionId) : undefined
    if (!existing) throw new Error('SESSION_NOT_FOUND')
    const resumed = new FakePiHost(options)
    resumed.sessionId = existing.sessionId
    resumed.entriesList.push(...structuredClone(existing.entriesList))
    resumed.script = existing.script
    return resumed
  }
}
