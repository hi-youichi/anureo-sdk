/** Owns process-stream framing, RPC correlation and transport cleanup; it must not interpret session policy or native payloads. */
import { HarnessSdkError } from '@anureo/sdk'
import type { HarnessProcess } from '@anureo/sdk/process'

import { record, type NativeRecord } from './native-values'
/** Keep value helpers available through the public JSONL entry point while their interpretation remains owned by native-values. */
export { record, string, type NativeRecord } from './native-values'
/** Envelope passed by the transport to an owner's interaction handler; params are unvalidated and response ownership is claimed before writing. */
export interface NativeRequest {
  /** Native correlation identity echoed unchanged in replies. */
  id: number | string;
  method: string;
  /** Unvalidated method-specific fields; session handlers own interpretation. */
  params: NativeRecord
}
/** Owner callbacks installed before reading starts; notifications run in wire order, interactions run concurrently and process disposal remains the owner's responsibility. */
export interface JsonlHandlers {
  /** Consume a notification before stdout advances; rejection fails the stream, so waiting for an interaction answer here would block its delivery. */
  notification(method: string, params: NativeRecord): Promise<void>;
  /** Handle an interaction concurrently; reply rejects duplicate calls, reject ignores them, and both claim before I/O. Async handler failure sends a fallback only if unclaimed; synchronous throws fail the stream. */
  request(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void>;
  /** Observe closure after pending requests reject; callback rejection reaches finished on stream errors, but is absorbed at EOF by the already-closed guard. Always dispose afterward. */
  failure(cause: HarnessSdkError): Promise<void>;
  /** Diagnostic code only. Native stderr bytes and request params never reach this callback. */
  diagnostic?(code: string): void;
}
/** Bounds configured by transport owners to limit pending RPCs, frame bytes and concurrent interactions; exceeding a bound fails admission or reading. */
export interface JsonlOptions {
  /** Per-request response deadline, default 30,000ms; timeout preserves an unknown native outcome. */
  timeoutMs?: number;
  /** Maximum UTF-8 bytes per frame, default 8MiB; outgoing includes the newline, incoming excludes the CRLF/LF delimiter. */
  maxFrameBytes?: number;
  /** Maximum unresolved client requests, default 128. */
  maxPending?: number;
  /** Maximum concurrent server handlers until their full completion, default 32. */
  maxServerRequests?: number
}
/** Definite native rejection returned to RPC callers; retain only the numeric code so native error messages cannot disclose payloads. */
export class CodexRpcError extends HarnessSdkError {
  /** For response decoding, map a numeric native code to a safe SDK error without I/O; method-not-found stays distinguishable from other definite failures. */
  constructor(readonly rpcCode: number) { super(rpcCode === -32601 ? 'METHOD_NOT_FOUND' : 'NATIVE_RPC_ERROR', 'Native Codex request failed', false, false, { rpcCode }) }
}
/** Process-backed transport for adapter, catalog and session owners. Construction starts readers; writes are serialized and replies correlated until explicit disposal. Native frames omit the public AHP JSON-RPC header. */
export class CodexJsonlClient {
  private nextId = 1
  private readonly pending = new Map<number | string, { resolve(value: unknown): void; reject(cause: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  // Rejects new requests and writes; already queued writes are not cancelled.
  private closed = false
  // Shares the explicit process-disposal task across dispose() calls.
  private disposing?: Promise<void>
  private writeTail: Promise<void> = Promise.resolve()
  private activeServerRequestHandlers = 0
  private readonly maxFrameBytes: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  /** Reader/failure completion for owners observing stdout; excludes stderr, asynchronous interactions and process disposal. EOF absorbs failure-callback rejection; stream-error reporting propagates it. */
  readonly finished: Promise<void>
  /** Start draining a supplied process with the owner's handlers before requests can be sent; no process is spawned here. The owner must dispose even if finished resolves or rejects. */
  constructor(readonly process: HarnessProcess, private readonly handlers: JsonlHandlers, private readonly options: JsonlOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024
    // Read before initialize; stdout EOF, rather than process exit, preserves buffered final frames.
    this.finished = this.read().catch(cause => this.fail(cause instanceof HarnessSdkError ? cause : new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Codex stream', false, true)))
    void this.drainDiagnostics()
  }
  /** Constructor-owned stderr reader: publish codes without native bytes and absorb read/callback failures so diagnostics cannot take over stdout's connection lifecycle. */
  private async drainDiagnostics(): Promise<void> {
    try {
      for await (const chunk of this.process.stderr) {
        if (chunk.byteLength) this.handlers.diagnostic?.('CODEX_STDERR')
      }
    } catch { /* stdout owns failure; stderr is never exposed verbatim */ }
  }
  /** Queue one frame for request/reply/notification callers. Serialization can throw synchronously; closed/oversized frames and process write failures reject. Recover the queue without masking the caller's failure. */
  private write(message: NativeRecord): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED', 'Codex connection is closed', false, true))
    const encoded = JSON.stringify(message) + '\n'
    if (new TextEncoder().encode(encoded).byteLength > this.maxFrameBytes) return Promise.reject(new HarnessSdkError('FRAME_TOO_LARGE'))
    const writeTask = this.writeTail.then(() => this.process.write(encoded))
    // Recover the queue for later writes; the returned writeTask still propagates this write's failure.
    this.writeTail = writeTask.catch(() => {})
    return writeTask
  }
  /** For transport owners, queue a notification in outbound order without awaiting a response. Serialization can throw synchronously; frame bounds and write failures reject. */
  notify(method: string, params?: NativeRecord): Promise<void> { return this.write({ method, ...(params ? { params } : {}) }) }
  /** For transport owners, register a deadline before queueing an RPC and resolve its correlated result. Reject admission, serialization, native, deadline, write or cleanup failures; uncertain outcomes are never replayed. */
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
        clearTimeout(waiting.timer)
        this.pending.delete(id)
        reject(new HarnessSdkError('CONNECTION_CLOSED', 'Native request outcome is unknown', false, true))
      })
    })
  }
  /** Constructor-owned stdout reader: decode across chunk boundaries and await frames in wire order before EOF handling. Invalid/oversized/incomplete frames reject into failure reporting; process disposal stays explicit. */
  private async read(): Promise<void> {
    let buffer = ''
    for await (const chunk of this.process.stdout) {
      buffer += this.decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (!line) continue
        this.assertIncomingFrameSize(line)
        await this.receive(record(JSON.parse(line)))
      }
      this.assertIncomingFrameSize(buffer)
    }
    buffer += this.decoder.decode()
    if (buffer.trim()) throw new HarnessSdkError('PROTOCOL_ERROR', 'Incomplete Codex JSONL frame', false, true)
    if (!this.closed) await this.fail(new HarnessSdkError('CONNECTION_CLOSED', 'Codex stream closed', false, this.pending.size > 0))
  }
  /** Enforce read's byte bound on complete lines and unfinished buffers; throw a safe uncertain-outcome error without retaining native content. Outbound frames have a separate error contract. */
  private assertIncomingFrameSize(frame: string): void {
    if (new TextEncoder().encode(frame).byteLength > this.maxFrameBytes) {
      throw new HarnessSdkError('FRAME_TOO_LARGE', 'Codex frame exceeds limit', false, true)
    }
  }
  /** Route read's decoded frame: await notifications, start concurrent interactions or settle a reply. Invalid IDs and interaction overflow reject; user answers must never block subsequent stdout frames. */
  private async receive(message: NativeRecord): Promise<void> {
    const id = message.id
    const method = message.method
    if (typeof method === 'string' && id === undefined) {
      await this.handlers.notification(method, record(message.params))
      return
    }
    if (typeof id !== 'number' && typeof id !== 'string') throw new HarnessSdkError('PROTOCOL_ERROR')
    if (typeof method === 'string') {
      this.startServerRequest({ id, method, params: record(message.params) })
      return
    }
    this.settleResponse(id, message)
  }
  /** Called by receive to reserve a handler slot and launch an interaction without blocking stdout. Throws on overflow or synchronous handler failure; asynchronous failure gets one fallback reply. The slot lasts through fallback completion. */
  private startServerRequest(request: NativeRequest): void {
    if (++this.activeServerRequestHandlers > (this.options.maxServerRequests ?? 32)) {
      throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Too many native interactions', false, true)
    }
    const { id } = request
    // Claim response ownership before writing, even if the write later fails.
    let responseClaimed = false
    /** Claim this interaction once before queueing its result; duplicate replies reject INTERACTION_ALREADY_RESOLVED and write failures propagate without releasing response ownership. */
    const reply = async (result: unknown) => {
      if (responseClaimed) throw new HarnessSdkError('INTERACTION_ALREADY_RESOLVED')
      responseClaimed = true
      await this.write({ id, result })
    }
    /** Claim an unresponded interaction before queueing a safe error; repeated rejection is a no-op so handler fallback cannot send a second response. Write errors propagate. */
    const reject = async (code: number, message: string) => {
      if (responseClaimed) return
      responseClaimed = true
      await this.write({ id, error: { code, message } })
    }
    // Do not block stdout on a user answer: responses and interrupt notifications must still drain.
    void this.handlers.request(request, reply, reject)
      .catch(() => reject(-32603, 'Interaction unavailable'))
      .catch(() => {})
      .finally(() => {
        // Release the slot after the handler and any fallback rejection settle, not on reply.
        this.activeServerRequestHandlers--
      })
  }
  /** Settle receive's validated response ID after removing its waiter and deadline. Ignore late/duplicate replies; reject native errors safely, prefer error over result and reject missing payloads as protocol errors. */
  private settleResponse(id: number | string, message: NativeRecord): void {
    const waiting = this.pending.get(id)
    if (!waiting) return // timed-out/duplicate response is observed and not replayed
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    if (Object.hasOwn(message, 'error')) waiting.reject(new CodexRpcError(Number(record(message.error).code ?? -32603)))
    else if (Object.hasOwn(message, 'result')) waiting.resolve(message.result)
    else waiting.reject(new HarnessSdkError('PROTOCOL_ERROR'))
  }
  /** Used by failure/disposal to forbid new work, clear deadlines and reject every waiter before external callbacks run. The factory preserves shared failure causes and a distinct disposal error per waiter; it must not throw. Leaves process cleanup explicit. */
  private closeTransport(createCause: () => HarnessSdkError): void {
    this.closed = true
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(createCause())
    }
    this.pending.clear()
  }
  /** Reader failure entry: close admission and reject waiters before awaiting the owner's callback. Repeated closure is ignored; this call propagates callback rejection and leaves process disposal to the owner. */
  private async fail(cause: HarnessSdkError): Promise<void> {
    if (this.closed) return
    this.closeTransport(() => cause)
    await this.handlers.failure(cause)
  }
  /** Owner cleanup: close admission and reject waiters before disposing the process. Repeated calls share success or rejection; queued writes keep their order, and neither finished nor interaction handlers are awaited. */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closeTransport(() => new HarnessSdkError('RUNTIME_DISPOSED', 'Codex client disposed', false, true))
      await this.process.dispose()
    })()
  }
}
