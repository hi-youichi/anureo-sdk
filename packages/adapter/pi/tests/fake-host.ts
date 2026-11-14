/** Shared scripted Pi host for adapter and workflow tests; no provider calls or disk persistence. */
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
/** prompt schedules this callback; its rejection marks the scripted execution aborted at settlement. */
export type Script = (host: FakePiHost, text: string) => Promise<void>

/** Script Pi event order for adapter/workflow tests. Tests control completion through script/hold and own disposal. */
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
  /** Emit one streamed text block and append its final message; extra fields can simulate native stop/error outcomes. */
  async assistant(text: string, extra: Partial<PiHostMessage> = {}): Promise<void> {
    const message: PiHostMessage = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage, ...extra }
    this.emit({ type: 'message_start', message: { ...message, content: [] } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'start', index: 0 } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'delta', index: 0, delta: text } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'end', index: 0 } })
    this.append(message)
    this.emit({ type: 'message_end', message })
  }
  /** Append/emit an assistant tool call, execution pair and tool-result message; isError defaults false. */
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
    this.emit({ type: 'message_start', message: result }); this.emit({ type: 'message_end', message: result })
  }
  /** Register adapter event delivery; the returned callback removes this listener. */
  subscribe(listener: (event: PiHostEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** Record input and schedule the script after acceptance; configured errors reject before scheduling, and handled prompts start no run. */
  async prompt(text: string): Promise<PiPromptDisposition> {
    this.calls.push({ method: 'prompt', value: text })
    if (this.promptError) throw this.promptError
    if (this.promptDisposition === 'handled') return 'handled'
    this.busy = true
    setImmediate(() => { void this.run(text) })
    return this.promptDisposition
  }
  /** Record native delivery and return the configured disposition without executing another script. */
  async steer(text: string): Promise<PiInputDisposition> { this.calls.push({ method: 'steer', value: text }); this.steered.push(text); return this.steerDisposition }
  /** Record after-turn delivery without scheduling a continuation; tests supply any continuation events explicitly. */
  async followUp(text: string): Promise<PiInputDisposition> { this.calls.push({ method: 'followUp', value: text }); this.followed.push(text); return this.steerDisposition }
  /** Request interrupted settlement and release hold; completion events still come from the script runner. */
  async abort(): Promise<void> { this.calls.push({ method: 'abort' }); this.abortRequested = true; this.release?.() }
  /** Hold until the test calls release or abort; an already requested abort resolves immediately. Only one hold is tracked. */
  hold(): Promise<void> { return this.abortRequested ? Promise.resolve() : new Promise<void>(resolve => { this.release = resolve }) }
  async listModels(): Promise<PiHostModel[]> { return MODELS }
  async setModel(ref: string): Promise<void> { this.calls.push({ method: 'setModel', value: ref }); this.model = ref }
  availableThinkingLevels(): string[] { return MODELS.find(model => model.ref === this.model)?.thinkingLevels ?? ['off'] }
  setThinkingLevel(level: string): string { this.calls.push({ method: 'setThinkingLevel', value: level }); this.thinkingLevel = level; return level }
  setActiveTools(names: string[]): void { this.calls.push({ method: 'setActiveTools', value: names }) }
  entries(): PiHostEntry[] { return structuredClone(this.entriesList) }
  /** Emit one manual compaction pair synchronously, allowing tests to exercise in-turn items or idle notices. */
  async compact(): Promise<{ summary?: string }> {
    this.calls.push({ method: 'compact' })
    this.emit({ type: 'compaction_start', reason: 'manual' })
    this.emit({ type: 'compaction_end', reason: 'manual', aborted: false, summary: 'compacted' })
    return { summary: 'compacted' }
  }
  /** Copy history through entryId (null means empty), share the script and leave the source unchanged; no disk is involved. */
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
  /** Mark disposed and clear listeners; an active script is not awaited or released here. */
  async dispose(): Promise<void> { this.calls.push({ method: 'dispose' }); this.disposed = true; this.listeners.clear() }

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
  steerDisposition: PiInputDisposition = 'queued'
  promptDisposition: PiPromptDisposition = 'started'
  promptError?: Error
  script: Script = async (host, text) => { await host.assistant(`done: ${text}`) }
  private seq = 0
  abortRequested = false
  release?: () => void
  sibling?: FakePiHost

  /** Emit the native run envelope around a script; script rejection or abort sets settled.aborted instead of escaping. */
  private async run(text: string): Promise<void> {
    this.emit({ type: 'agent_start' })
    this.user(text)
    let aborted = false
    try { await this.script(this, text) } catch { aborted = true }
    this.emit({ type: 'agent_end', willRetry: false })
    this.busy = false
    this.emit({ type: 'settled', aborted: aborted || this.abortRequested })
    this.abortRequested = false
  }
}

/**
 * Supply an injectable host factory and inspect every open/host. New hosts are retained in an
 * in-memory resume store; resume clones their history/script and rejects unknown ids. setup runs
 * after recording each host, so tests can install scripts or optional direct-output support.
 * Forked children are returned by the host itself and are not added to this factory's host list.
 */
export function fakeFactory(setup?: (host: FakePiHost) => void): { factory: PiHostFactory; hosts: FakePiHost[]; opens: PiHostOpenOptions[] } {
  const hosts: FakePiHost[] = [], opens: PiHostOpenOptions[] = []
  const store = new Map<string, FakePiHost>()
  const factory: PiHostFactory = async options => {
    opens.push(options)
    if (options.mode === 'resume') {
      const existing = options.sessionId ? store.get(options.sessionId) : undefined
      if (!existing) throw new Error('SESSION_NOT_FOUND')
      const resumed = new FakePiHost(options)
      resumed.sessionId = existing.sessionId
      resumed.entriesList.push(...structuredClone(existing.entriesList))
      resumed.script = existing.script
      hosts.push(resumed); setup?.(resumed)
      return resumed
    }
    const host = new FakePiHost(options)
    if (options.model) host.model = options.model
    hosts.push(host); store.set(host.sessionId, host); setup?.(host)
    return host
  }
  return { factory, hosts, opens }
}
