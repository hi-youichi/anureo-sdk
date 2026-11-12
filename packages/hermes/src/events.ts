import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk'
import type { AgentMessageItem, Item, Usage } from '@anureo/protocol'
import { identity, integer, json, object, protocolError, stableId, text, type NativeEvent, type NativeObject } from './native'
import type { HermesAdapterOptions } from './options'

type TerminalStatus = 'completed' | 'interrupted' | 'failed'
interface Segment { item: AgentMessageItem; incomplete: boolean }

/** Native snapshots complete items; deltas only describe provisional progress. */
export class HermesTurn {
  readonly id: string
  started = false
  terminal = false
  status?: TerminalStatus
  private readonly items = new Map<string, Item>()
  private readonly completed = new Set<string>()
  private readonly submissions = new Set<string>()
  private segment = 0
  private current?: Segment
  private lastText = ''
  private reasoning = ''
  private bytes = 0
  private gapReported = false
  constructor(readonly admissionId: string, readonly epoch: number, readonly generation: number,
    sessionId: string, private readonly sink: SessionEventSink, private readonly options: HermesAdapterOptions) {
    this.id = `hermes-${stableId(sessionId, admissionId)}`
  }
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.sink.emit({ type: 'turn/started', payload: { turnId: this.id, nativeTurnId: this.admissionId } })
  }
  async bind(submissionId: string, input: string): Promise<void> {
    await this.start()
    if (this.submissions.has(submissionId)) return
    this.submissions.add(submissionId)
    await this.sink.bindSubmission(submissionId, this.id)
    if (this.terminal) return
    // Native admission/claim is the evidence that this input belongs to this execution.
    await this.complete({ id: `${this.id}:user:${stableId(submissionId)}`, type: 'userMessage', content: [{ type: 'text', text: input }], status: 'completed' })
  }
  private async put(item: Item): Promise<void> {
    const previous = this.items.get(item.id)
    const bytes = Buffer.byteLength(JSON.stringify(item))
    const total = this.bytes - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0) + bytes
    if (total > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024) || !previous && this.items.size >= 2048) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.items.set(item.id, structuredClone(item)); this.bytes = total
    if (!previous) await this.sink.emit({ type: 'item/started', payload: { item: { ...item, status: 'running' } } }, { turnId: this.id })
  }
  private async complete(item: Item): Promise<void> {
    if (this.completed.has(item.id)) return
    await this.put(item); this.completed.add(item.id)
    await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: this.id })
  }
  private async commentary(): Promise<void> {
    if (!this.current) return
    this.lastText = this.current.item.text
    await this.complete({ ...this.current.item, phase: 'commentary', status: 'completed' })
    this.current = undefined; this.segment++
  }
  async gap(): Promise<void> {
    if (this.terminal || this.gapReported) return
    this.gapReported = true
    await this.start()
    if (this.current) this.current.incomplete = true
    await this.complete({ id: `${this.id}:gap`, type: 'notice', severity: 'warning', code: 'HERMES_PROGRESS_GAP',
      text: 'Some intermediate Hermes progress was unavailable; the final answer requires native terminal evidence.', status: 'completed' })
  }
  async apply(event: NativeEvent): Promise<void> {
    if (this.terminal) return
    await this.start()
    const payload = event.payload
    switch (event.type) {
      case 'message.delta': {
        if (payload.text === null) { await this.commentary(); return }
        let chunk = text(payload.text)
        if (payload.segment !== undefined) {
          const next = integer(payload.segment)
          if (next < this.segment) return
          if (next > this.segment) { await this.commentary(); this.segment = next }
        }
        if (!this.current) {
          this.current = { item: { id: `${this.id}:message:${this.segment}`, type: 'agentMessage', text: '', phase: 'commentary' }, incomplete: false }
          await this.put(this.current.item)
        }
        const current = this.current
        if (current.incomplete) return
        const offset = payload.offset === undefined ? current.item.text.length : integer(payload.offset)
        if (offset > current.item.text.length) { await this.gap(); return }
        if (offset < current.item.text.length) {
          const overlap = Math.min(chunk.length, current.item.text.length - offset)
          if (current.item.text.slice(offset, offset + overlap) !== chunk.slice(0, overlap)) throw protocolError()
          chunk = chunk.slice(overlap)
        }
        if (!chunk) return
        current.item = { ...current.item, text: current.item.text + chunk }
        await this.put(current.item)
        await this.sink.emit({ type: 'item/delta', payload: { itemId: current.item.id, kind: 'text', text: chunk } }, { turnId: this.id })
        return
      }
      case 'message.interim': {
        const body = text(payload.text)
        if (payload.segment !== undefined && integer(payload.segment) < this.segment) return
        if (!this.current) this.current = { item: { id: `${this.id}:message:${this.segment}`, type: 'agentMessage', text: body, phase: 'commentary' }, incomplete: false }
        else this.current.item = { ...this.current.item, text: body }
        await this.commentary(); return
      }
      case 'reasoning.delta': {
        const chunk = text(payload.text); this.reasoning += chunk
        const item: Item = { id: `${this.id}:reasoning`, type: 'reasoning', summary: this.reasoning }
        if (!this.items.has(item.id)) await this.put({ ...item, summary: '' })
        await this.put(item)
        await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'reasoningSummary', text: chunk } }, { turnId: this.id })
        return
      }
      case 'tool.start': {
        const id = `${this.id}:tool:${identity(payload.tool_id)}`
        if (this.items.has(id)) return
        const name = identity(payload.name)
        await this.put({ id, type: 'toolCall', kind: 'other', title: name, toolName: name, nativeType: name,
          ...(payload.args !== undefined ? { input: json(payload.args) } : {}) }); return
      }
      case 'tool.complete': {
        const id = `${this.id}:tool:${identity(payload.tool_id)}`, name = identity(payload.name)
        const prior = this.items.get(id)
        await this.complete({ ...(prior?.type === 'toolCall' ? prior : {}), id, type: 'toolCall', kind: 'other', title: name,
          toolName: name, nativeType: name, status: 'completed',
          ...(payload.args !== undefined ? { input: json(payload.args) } : {}),
          ...(payload.result !== undefined ? { output: json(payload.result) } : typeof payload.result_text === 'string' ? { output: payload.result_text } : {}),
          ...(typeof payload.duration_s === 'number' && payload.duration_s >= 0 ? { durationMs: payload.duration_s * 1000 } : {}),
        }); return
      }
      case 'message.complete': {
        const status = payload.status === 'complete' ? 'completed' : payload.status === 'interrupted' ? 'interrupted' : payload.status === 'error' ? 'failed' : undefined
        if (!status) throw protocolError()
        const value = payload.text ?? payload.content
        if (value != null && typeof value !== 'string') throw protocolError()
        await this.finish(status, value == null ? this.current?.item.text ?? this.lastText : value, payload)
      }
    }
  }
  async fromReceipt(result: NativeObject, outcome: string | null): Promise<void> {
    if (this.terminal) return
    const status = outcome === 'completed' ? 'completed' : outcome === 'interrupted' || outcome === 'cancelled' ? 'interrupted' : outcome === 'failed' ? 'failed' : undefined
    if (!status || result.final_response !== undefined && typeof result.final_response !== 'string') throw protocolError()
    await this.gap()
    await this.finish(status, typeof result.final_response === 'string' ? result.final_response : '', result)
  }
  private async finish(status: TerminalStatus, body: string, payload: NativeObject): Promise<void> {
    await this.start()
    const id = this.current?.item.id ?? `${this.id}:final`
    await this.complete({ id, type: 'agentMessage', text: body, phase: 'final', status: status === 'completed' ? 'completed' : status })
    if (typeof payload.reasoning === 'string') this.reasoning = payload.reasoning
    if (this.reasoning) await this.complete({ id: `${this.id}:reasoning`, type: 'reasoning', summary: this.reasoning, status: 'completed' })
    for (const item of this.items.values()) if (!this.completed.has(item.id)) {
      await this.gap()
      await this.complete({ ...item, extensions: { ...item.extensions, nativeResultUnavailable: true } })
    }
    if (payload.usage != null) await sessionUsage(this.sink, object(payload.usage))
    this.terminal = true; this.status = status
    await this.sink.emit({ type: 'turn/completed', payload: { turnId: this.id, status,
      ...(status === 'failed' ? { error: { code: 'HERMES_TURN_FAILED', message: 'Hermes turn failed', retryable: false, outcomeUnknown: false } } : {}) } })
    // Core retains completed results; the mapper retains only identity and control evidence.
    this.items.clear(); this.completed.clear(); this.current = undefined; this.reasoning = ''; this.lastText = ''; this.bytes = 0
  }
}

export async function sessionUsage(sink: SessionEventSink, payload: NativeObject): Promise<void> {
  const usage: Usage = { provider: 'hermes', source: 'native', scope: 'session' }
  const fields = { input: 'input', output: 'output', total: 'total', context_max: 'contextWindow', context_used: 'contextUsed' } as const
  for (const [native, target] of Object.entries(fields)) {
    const value = payload[native]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[target] = value
  }
  await sink.emit({ type: 'usage/updated', payload: usage })
}
