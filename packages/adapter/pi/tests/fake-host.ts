import { randomUUID } from 'node:crypto'
import type {
  PiHostEntry, PiHostEvent, PiHostFactory, PiHostMessage, PiHostModel, PiHostOpenOptions, PiInputDisposition, PiPromptDisposition, PiSessionHost,
} from '../src/host'

export const usage = { input: 7, output: 9, cacheRead: 2, cacheWrite: 1, totalTokens: 19 }
export const MODELS: PiHostModel[] = [
  { ref: 'fake/small', name: 'Small', reasoning: false, thinkingLevels: ['off'] },
  { ref: 'fake/big', name: 'Big', reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high'] },
]
export type Script = (host: FakePiHost, text: string) => Promise<void>

/** Scripted stand-in for Pi: it emits the same event order the real session produces for a run. */
export class FakePiHost implements PiSessionHost {
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
  constructor(readonly open: PiHostOpenOptions) {}

  emit(event: PiHostEvent): void { for (const listener of [...this.listeners]) listener(event) }
  append(message: PiHostMessage): PiHostEntry {
    const parent = this.entriesList.at(-1)
    const entry: PiHostEntry = { id: `e${++this.seq}`, parentId: parent?.id ?? null, kind: 'message', message }
    this.entriesList.push(entry)
    return entry
  }
  user(text: string): void {
    const message: PiHostMessage = { role: 'user', content: [{ type: 'text', text }] }
    this.emit({ type: 'message_start', message })
    this.append(message)
    this.emit({ type: 'message_end', message })
  }
  /** One streamed assistant message with a single text block. */
  async assistant(text: string, extra: Partial<PiHostMessage> = {}): Promise<void> {
    const message: PiHostMessage = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage, ...extra }
    this.emit({ type: 'message_start', message: { ...message, content: [] } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'start', index: 0 } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'delta', index: 0, delta: text } })
    this.emit({ type: 'message_update', message, update: { kind: 'text', phase: 'end', index: 0 } })
    this.append(message)
    this.emit({ type: 'message_end', message })
  }
  /** Assistant message that calls a tool, then the tool result. */
  async toolRound(id: string, name: string, args: Record<string, unknown>, output: string, isError = false): Promise<void> {
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
  abortRequested = false
  subscribe(listener: (event: PiHostEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async prompt(text: string): Promise<PiPromptDisposition> {
    this.calls.push({ method: 'prompt', value: text })
    if (this.promptError) throw this.promptError
    if (this.promptDisposition === 'handled') return 'handled'
    this.busy = true
    setImmediate(() => { void this.run(text) })
    return this.promptDisposition
  }
  async steer(text: string): Promise<PiInputDisposition> { this.calls.push({ method: 'steer', value: text }); this.steered.push(text); return this.steerDisposition }
  async followUp(text: string): Promise<PiInputDisposition> { this.calls.push({ method: 'followUp', value: text }); this.followed.push(text); return this.steerDisposition }
  async abort(): Promise<void> { this.calls.push({ method: 'abort' }); this.abortRequested = true; this.release?.() }
  release?: () => void
  /** Hold the run open until released or aborted. */
  hold(): Promise<void> { return this.abortRequested ? Promise.resolve() : new Promise<void>(resolve => { this.release = resolve }) }
  async listModels(): Promise<PiHostModel[]> { return MODELS }
  async setModel(ref: string): Promise<void> { this.calls.push({ method: 'setModel', value: ref }); this.model = ref }
  availableThinkingLevels(): string[] { return MODELS.find(model => model.ref === this.model)?.thinkingLevels ?? ['off'] }
  setThinkingLevel(level: string): string { this.calls.push({ method: 'setThinkingLevel', value: level }); this.thinkingLevel = level; return level }
  setActiveTools(names: string[]): void { this.calls.push({ method: 'setActiveTools', value: names }) }
  entries(): PiHostEntry[] { return structuredClone(this.entriesList) }
  async compact(): Promise<{ summary?: string }> {
    this.calls.push({ method: 'compact' })
    this.emit({ type: 'compaction_start', reason: 'manual' })
    this.emit({ type: 'compaction_end', reason: 'manual', aborted: false, summary: 'compacted' })
    return { summary: 'compacted' }
  }
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
  sibling?: FakePiHost
  async dispose(): Promise<void> { this.calls.push({ method: 'dispose' }); this.disposed = true; this.listeners.clear() }
}

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
