import { HarnessSdkError, type SessionEventSink } from '@anureo/sdk'
import type { AgentMessageItem, Item, Usage } from '@anureo/protocol'
import { identity, integer, json, object, protocolError, stableId, text, type NativeEvent, type NativeObject } from './native'
import type { HermesAdapterOptions } from './options'

/**
 * Publish cumulative session usage for HermesSession.apply and terminal turn projection.
 * Omit nonfinite or negative counters and await sink publication.
 */
export async function sessionUsage(sink: SessionEventSink, payload: NativeObject): Promise<void> {
  const usage: Usage = { provider: 'hermes', source: 'native', scope: 'session' }
  const fields = { input: 'input', output: 'output', total: 'total', context_max: 'contextWindow', context_used: 'contextUsed' } as const
  for (const [native, target] of Object.entries(fields)) {
    const value = payload[native]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[target] = value
  }
  await sink.emit({ type: 'usage/updated', payload: usage })
}

/**
 * Internal execution projection created by HermesSession.turn. Publish ordered SDK items through
 * its sink, retaining bounded provisional state until native terminal evidence arrives. Native
 * snapshots complete items; deltas only describe provisional progress. Sink failures reject to the
 * session's receipt or event path; the session owns recovery and channel disposal.
 */
export class HermesTurn {
  /** SDK identity shared by submission bindings, events and interrupt targeting. */
  readonly id: string
  /** Durable native admission used to reconcile this execution after reconnect. */
  readonly admissionId: string
  /** Native authority paired with generation; HermesSession checks both when reusing this execution. */
  readonly epoch: number
  /** Native execution generation within this authority, used to fence interrupt requests. */
  readonly generation: number
  /** Set before publishing turn/started to suppress duplicate starts during association and event delivery. */
  started = false
  /** Set before turn/completed publication. HermesSession uses it to stop treating this turn as active. */
  terminal = false
  /** Set with terminal evidence before turn/completed publication, and retained after item content is released. */
  status?: TerminalStatus
  /** Accept validated native execution identity and derive a local turn id stable across replay. */
  constructor({ admissionId, epoch, generation, sessionId, sink, options }: {
    admissionId: string
    epoch: number
    generation: number
    sessionId: string
    sink: SessionEventSink
    options: HermesAdapterOptions
  }) {
    this.admissionId = admissionId
    this.epoch = epoch
    this.generation = generation
    this.sink = sink
    this.options = options
    this.id = `hermes-${stableId(sessionId, admissionId)}`
  }
  /** Publish turn/started at most once, before any binding or item publication. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.sink.emit({ type: 'turn/started', payload: { turnId: this.id, nativeTurnId: this.admissionId } })
  }
  /** HermesSession.associate binds native-claimed input once; late binding of a terminal turn adds no user item. */
  async bind(submissionId: string, input: string): Promise<void> {
    await this.start()
    if (this.submissions.has(submissionId)) return
    this.submissions.add(submissionId)
    await this.sink.bindSubmission(submissionId, this.id)
    if (this.terminal) return
    // Native admission/claim is the evidence that this input belongs to this execution.
    await this.complete({ id: `${this.id}:user:${stableId(submissionId)}`, type: 'userMessage', content: [{ type: 'text', text: input }], status: 'completed' })
  }
  /** Report incomplete progress once and stop appending to the current partial segment; native snapshots can still replace its text. */
  async gap(): Promise<void> {
    if (this.terminal || this.gapReported) return
    this.gapReported = true
    await this.start()
    if (this.current) this.current.incomplete = true
    await this.complete({ id: `${this.id}:gap`, type: 'notice', severity: 'warning', code: 'HERMES_PROGRESS_GAP',
      text: 'Some intermediate Hermes progress was unavailable; the final answer requires native terminal evidence.', status: 'completed' })
  }
  /** Project the event supplied by HermesSession.applyTurnEvent. Ignore terminal replays and reject malformed payloads or sink failures. */
  async apply(event: NativeEvent): Promise<void> {
    if (this.terminal) return
    await this.start()
    switch (event.type) {
      case 'message.delta': await this.messageDelta(event.payload); return
      case 'message.interim': await this.messageInterim(event.payload); return
      case 'reasoning.delta': await this.reasoningDelta(event.payload); return
      case 'tool.start':
      case 'tool.complete': await this.toolEvent(event.type, event.payload); return
      case 'message.complete': await this.messageComplete(event.payload)
    }
  }
  /**
   * HermesSession.associate supplies receipt-only terminal evidence after reconnect or submit.
   * Mark unavailable intermediate progress, then publish the final response; unsupported outcomes or
   * non-string final_response reject as protocol errors. Missing final_response means empty text.
   */
  async fromReceipt(result: NativeObject, outcome: string | null): Promise<void> {
    if (this.terminal) return
    const status = outcome === 'completed' ? 'completed' : outcome === 'interrupted' || outcome === 'cancelled' ? 'interrupted' : outcome === 'failed' ? 'failed' : undefined
    if (!status || result.final_response !== undefined && typeof result.final_response !== 'string') throw protocolError()
    await this.gap()
    await this.finish(status, typeof result.final_response === 'string' ? result.final_response : '', result)
  }
  private readonly items = new Map<string, Item>()
  private readonly completed = new Set<string>()
  private readonly submissions = new Set<string>()
  private segment = 0
  private current?: Segment
  private lastText = ''
  private reasoning = ''
  private bytes = 0
  private gapReported = false

  /** Replace streamed commentary with the native snapshot and seal the segment unless it is stale. */
  private async messageInterim(payload: NativeObject): Promise<void> {
    const body = text(payload.text)
    if (payload.segment !== undefined && integer(payload.segment) < this.segment) return
    if (!this.current) this.current = { item: { id: `${this.id}:message:${this.segment}`, type: 'agentMessage', text: body, phase: 'commentary' }, incomplete: false }
    else this.current.item = { ...this.current.item, text: body }
    await this.commentary()
  }
  /** Retain the accumulated reasoning summary while publishing only the new chunk as a delta. */
  private async reasoningDelta(payload: NativeObject): Promise<void> {
    const chunk = text(payload.text)
    this.reasoning += chunk
    const item: Item = { id: `${this.id}:reasoning`, type: 'reasoning', summary: this.reasoning }
    if (!this.items.has(item.id)) await this.put({ ...item, summary: '' })
    await this.put(item)
    await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'reasoningSummary', text: chunk } }, { turnId: this.id })
  }
  /**
   * Project both tool phases under one native identity. Ignore duplicate starts, retain prior input
   * when completion omits it, and convert native duration seconds to SDK milliseconds.
   */
  private async toolEvent(type: 'tool.start' | 'tool.complete', payload: NativeObject): Promise<void> {
    const id = `${this.id}:tool:${identity(payload.tool_id)}`
    if (type === 'tool.start' && this.items.has(id)) return
    const name = identity(payload.name)
    const prior = this.items.get(id)
    const item: Item = { ...(prior?.type === 'toolCall' ? prior : {}), id, type: 'toolCall', kind: 'other',
      title: name, toolName: name, nativeType: name,
      ...(payload.args !== undefined ? { input: json(payload.args) } : {}) }
    if (type === 'tool.start') {
      await this.put(item)
      return
    }
    await this.complete({ ...item, status: 'completed',
      ...(payload.result !== undefined ? { output: json(payload.result) } : typeof payload.result_text === 'string' ? { output: payload.result_text } : {}),
      ...(typeof payload.duration_s === 'number' && payload.duration_s >= 0 ? { durationMs: payload.duration_s * 1000 } : {}),
    })
  }
  /** Require a recognized terminal status. Use retained text only when both native text fields are absent or null. */
  private async messageComplete(payload: NativeObject): Promise<void> {
    const status = payload.status === 'complete' ? 'completed' : payload.status === 'interrupted' ? 'interrupted' : payload.status === 'error' ? 'failed' : undefined
    if (!status) throw protocolError()
    const value = payload.text ?? payload.content
    if (value != null && typeof value !== 'string') throw protocolError()
    await this.finish(status, value == null ? this.current?.item.text ?? this.lastText : value, payload)
  }
  /** Retain a detached item within count/byte budgets and publish item/started only on first appearance. */
  private async put(item: Item): Promise<void> {
    const previous = this.items.get(item.id)
    const bytes = Buffer.byteLength(JSON.stringify(item))
    const total = this.bytes - (previous ? Buffer.byteLength(JSON.stringify(previous)) : 0) + bytes
    if (total > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024) || !previous && this.items.size >= 2048) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.items.set(item.id, structuredClone(item)); this.bytes = total
    if (!previous) await this.sink.emit({ type: 'item/started', payload: { item: { ...item, status: 'running' } } }, { turnId: this.id })
  }
  /** Publish item completion at most once per id, starting an unseen item first. */
  private async complete(item: Item): Promise<void> {
    if (this.completed.has(item.id)) return
    await this.put(item); this.completed.add(item.id)
    await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: this.id })
  }
  /** Seal the current commentary segment and retain its text as the fallback when a terminal frame omits text. */
  private async commentary(): Promise<void> {
    if (!this.current) return
    this.lastText = this.current.item.text
    await this.complete({ ...this.current.item, phase: 'commentary', status: 'completed' })
    this.current = undefined; this.segment++
  }
  /** Reconcile UTF-16 text offsets within a commentary segment; conflicting overlap rejects and a missing prefix marks a gap. */
  private async messageDelta(payload: NativeObject): Promise<void> {
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
  }
  /** Complete final/reasoning items before terminal publication, flag unfinished native items and release retained content after success. */
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

  private readonly sink: SessionEventSink
  private readonly options: HermesAdapterOptions
}

type TerminalStatus = 'completed' | 'interrupted' | 'failed'
interface Segment { item: AgentMessageItem; incomplete: boolean }
