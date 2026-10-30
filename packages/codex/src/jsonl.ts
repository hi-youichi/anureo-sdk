import { HarnessSdkError } from '@anureo/sdk'
import type { HarnessProcess } from '@anureo/sdk/process'

export type NativeRecord = Record<string, unknown>
export interface NativeRequest { id: number | string; method: string; params: NativeRecord }
export interface JsonlHandlers {
  notification(method: string, params: NativeRecord): Promise<void>;
  request(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void>;
  failure(cause: HarnessSdkError): Promise<void>;
  /** Diagnostic code only. Native stderr bytes and request params never reach this callback. */
  diagnostic?(code: string): void;
}
export interface JsonlOptions { timeoutMs?: number; maxFrameBytes?: number; maxPending?: number; maxServerRequests?: number }
export class CodexRpcError extends HarnessSdkError {
  constructor(readonly rpcCode: number) { super(rpcCode === -32601 ? 'METHOD_NOT_FOUND' : 'NATIVE_RPC_ERROR', 'Native Codex request failed', false, false, { rpcCode }) }
}
export function record(value: unknown): NativeRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as NativeRecord : {} }
export function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

/** Codex omits the JSON-RPC header, unlike the public AHP wire protocol. */
export class CodexJsonlClient {
  private nextId = 1
  private readonly pending = new Map<number | string, { resolve(value: unknown): void; reject(cause: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  private closed = false
  private disposing?: Promise<void>
  private writeTail: Promise<void> = Promise.resolve()
  private serverRequests = 0
  private readonly maxFrameBytes: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  readonly finished: Promise<void>
  constructor(readonly process: HarnessProcess, private readonly handlers: JsonlHandlers, private readonly options: JsonlOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024
    // Read before any request is sent, including initialize.
    this.finished = this.read().catch(cause => this.fail(cause instanceof HarnessSdkError ? cause : new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Codex stream', false, true)))
    void this.drainDiagnostics()
    // stdout must drain before exit is reported; exit can precede buffered final frames.
  }
  private async drainDiagnostics(): Promise<void> {
    try { for await (const chunk of this.process.stderr) if (chunk.byteLength) this.handlers.diagnostic?.('CODEX_STDERR') }
    catch { /* stdout/exit owns lifecycle; stderr is never exposed verbatim */ }
  }
  private write(message: NativeRecord): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED', 'Codex connection is closed', false, true))
    const encoded = JSON.stringify(message) + '\n'
    if (new TextEncoder().encode(encoded).byteLength > this.maxFrameBytes) return Promise.reject(new HarnessSdkError('FRAME_TOO_LARGE'))
    const task = this.writeTail.then(() => this.process.write(encoded))
    this.writeTail = task.catch(() => {})
    return task
  }
  notify(method: string, params?: NativeRecord): Promise<void> { return this.write({ method, ...(params ? { params } : {}) }) }
  request<T = unknown>(method: string, params: NativeRecord = {}): Promise<T> {
    if (this.closed) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED'))
    if (this.pending.size >= (this.options.maxPending ?? 128)) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HarnessSdkError('REQUEST_TIMEOUT', 'Native request outcome is unknown', false, true))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      void this.write({ id, method, params }).catch(() => {
        const waiting = this.pending.get(id)
        if (!waiting) return
        clearTimeout(waiting.timer); this.pending.delete(id)
        reject(new HarnessSdkError('CONNECTION_CLOSED', 'Native request outcome is unknown', false, true))
      })
    })
  }
  private async read(): Promise<void> {
    let buffer = ''
    for await (const chunk of this.process.stdout) {
      buffer += this.decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1)
        if (!line) continue
        if (new TextEncoder().encode(line).byteLength > this.maxFrameBytes) throw new HarnessSdkError('FRAME_TOO_LARGE', 'Codex frame exceeds limit', false, true)
        await this.receive(record(JSON.parse(line)))
      }
      if (new TextEncoder().encode(buffer).byteLength > this.maxFrameBytes) throw new HarnessSdkError('FRAME_TOO_LARGE', 'Codex frame exceeds limit', false, true)
    }
    buffer += this.decoder.decode()
    if (buffer.trim()) throw new HarnessSdkError('PROTOCOL_ERROR', 'Incomplete Codex JSONL frame', false, true)
    if (!this.closed) await this.fail(new HarnessSdkError('CONNECTION_CLOSED', 'Codex stream closed', false, this.pending.size > 0))
  }
  private async receive(message: NativeRecord): Promise<void> {
    const id = message.id
    if (typeof message.method === 'string') {
      if (id === undefined) { await this.handlers.notification(message.method, record(message.params)); return }
      if (typeof id !== 'number' && typeof id !== 'string') throw new HarnessSdkError('PROTOCOL_ERROR')
      if (++this.serverRequests > (this.options.maxServerRequests ?? 32)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Too many native interactions', false, true)
      let answered = false
      const reply = async (result: unknown) => { if (answered) throw new HarnessSdkError('INTERACTION_ALREADY_RESOLVED'); answered = true; await this.write({ id, result }) }
      const reject = async (code: number, text: string) => { if (answered) return; answered = true; await this.write({ id, error: { code, message: text } }) }
      // Do not block stdout on a user answer: responses and interrupt notifications must still drain.
      void this.handlers.request({ id, method: message.method, params: record(message.params) }, reply, reject)
        .catch(() => reject(-32603, 'Interaction unavailable')).catch(() => {}).finally(() => { this.serverRequests-- })
      return
    }
    if (typeof id !== 'number' && typeof id !== 'string') throw new HarnessSdkError('PROTOCOL_ERROR')
    const waiting = this.pending.get(id)
    if (!waiting) return // timed-out/duplicate response is observed and not replayed
    this.pending.delete(id); clearTimeout(waiting.timer)
    if (Object.hasOwn(message, 'error')) waiting.reject(new CodexRpcError(Number(record(message.error).code ?? -32603)))
    else if (Object.hasOwn(message, 'result')) waiting.resolve(message.result)
    else waiting.reject(new HarnessSdkError('PROTOCOL_ERROR'))
  }
  private async fail(cause: HarnessSdkError): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(cause) }
    this.pending.clear()
    await this.handlers.failure(cause)
  }
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closed = true
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new HarnessSdkError('RUNTIME_DISPOSED', 'Codex client disposed', false, true)) }
      this.pending.clear(); await this.process.dispose()
    })()
  }
}
