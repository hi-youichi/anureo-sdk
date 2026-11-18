/** Owns process-stream framing, RPC correlation and transport cleanup. */
import { HarnessSdkError } from '@anureo/sdk'
import type { HarnessProcess } from '@anureo/sdk/process'

import { record, string, type NativeRecord } from './native-values'
/** Keep value helpers available through the public JSONL entry point while their interpretation remains owned by native-values. */
export { record, string, type NativeRecord } from './native-values'

/** Server interaction received by a low-level client's request handler. Answer through the supplied callbacks. */
export interface NativeRequest {
  /** Native correlation identity echoed unchanged in replies. */
  id: number | string;
  /** Native method name used to select a handler. */
  method: string;
  /** Unvalidated method-specific fields; session handlers own interpretation. */
  params: NativeRecord
}
/**
 * Supply callbacks before constructing a client. CodexNativeAdapter.openSession registers
 * CodexBackendSession callbacks to publish events and route interactions through the session sink.
 * Adapter probes and the catalog supply non-interactive handlers. The client owner handles disposal.
 */
export interface JsonlHandlers {
  /** Consume a notification before the next frame is dispatched; throwing or rejecting fails the reader. Waiting for work that needs later stdout frames would block its own completion. */
  notification(method: string, params: NativeRecord): Promise<void>;
  /**
   * Handle an interaction while stdout continues to drain. Await the reply or reject write and
   * supply payloads safe to send verbatim. Capacity is held until the handler and any fallback
   * settle. Both callbacks claim the response before I/O. A duplicate reply rejects with
   * INTERACTION_ALREADY_RESOLVED, and a duplicate reject resolves without writing. If the handler
   * promise rejects before a response is claimed, the client attempts a fallback error reply.
   * A synchronous throw fails the reader. Resolving without answering sends no response.
   */
  request(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void>;
  /**
   * Observe the same reader failure or EOF cause delivered to pending requests after admission
   * closes. Explicit disposal skips this callback. Callback rejection reaches finished for reader
   * errors and is absorbed at EOF. The owner still needs to dispose the client.
   */
  failure(cause: HarnessSdkError): Promise<void>;
  /** Receive CODEX_STDERR for each nonempty stderr chunk. Throwing stops diagnostics without failing stdout. */
  diagnostic?(code: string): void;
}
/** Bounds configured by transport owners to limit pending RPCs, frame bytes and concurrent interactions; exceeding a bound fails admission or reading. */
export interface JsonlOptions {
  /** Per-request response deadline in milliseconds from admission, including queued write time. Defaults to 30,000. Timeout reports an unknown outcome without cancelling native work. */
  timeoutMs?: number;
  /** Maximum UTF-8 bytes per frame, default 64MiB; native paged history responses legitimately exceed the previous 8MiB default, and a local stdio pipe has no external frame ceiling. Outgoing includes the newline, incoming excludes the CRLF/LF delimiter. */
  maxFrameBytes?: number;
  /** Maximum unresolved client requests and, separately, maximum unfinished RPC writes. Defaults to 128. */
  maxPending?: number;
  /** Maximum concurrent server handlers until their full completion, default 32. */
  maxServerRequests?: number
}
/** Fixed native denial text for parent-owned Multi-Agent V2 subagent threads; classified without retaining native message bytes. */
const SUBAGENT_DIRECT_INPUT_DENIAL = 'direct app-server input is not allowed for multi-agent v2 sub-agents'
/** Definite native rejection returned to RPC callers; retain only the numeric code plus a sanitized denial flag so native error messages cannot disclose payloads. */
export class CodexRpcError extends HarnessSdkError {
  /** For response decoding, map a numeric native code and a -32600 denial prefix to a safe SDK error without I/O; method-not-found and the multi-agent direct-input denial stay distinguishable from other definite failures. */
  constructor(readonly rpcCode: number, readonly subagentDirectInputDenied = false) {
    super(
      rpcCode === -32601 ? 'METHOD_NOT_FOUND' : rpcCode === -32600 && subagentDirectInputDenied ? 'SUBAGENT_DIRECT_INPUT_REJECTED' : 'NATIVE_RPC_ERROR',
      rpcCode === -32600 && subagentDirectInputDenied ? 'Native Codex rejected direct input for a parent-owned subagent thread' : 'Native Codex request failed',
      false, false, { rpcCode },
    )
  }
}
/**
 * Exchange native Codex frames over a supplied process. Writes are serialized and replies
 * correlated. Frames use the Codex app-server format, which omits the JSON-RPC version field.
 * The owner must dispose the client even after reader failure or EOF.
 */
export class CodexJsonlClient {
  /**
   * Wait for stdout reading and any failure callback. Stream-error reporting propagates callback
   * rejection, while EOF absorbs it. The catalog observes completion to detach and dispose its
   * connection. Stderr, concurrent interaction handlers and process disposal complete separately.
   */
  readonly finished: Promise<void>

  /** Start draining the supplied process with the owner's handlers. Call dispose on this client to release the process. */
  constructor(readonly process: HarnessProcess, private readonly handlers: JsonlHandlers, private readonly options: JsonlOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 64 * 1024 * 1024
    // Start before the handshake and drain to stdout EOF so buffered replies can settle.
    this.finished = this.read().catch(cause => this.fail(cause instanceof HarnessSdkError ? cause : new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Codex stream', false, true)))
    void this.drainDiagnostics()
  }
  /**
   * Write a notification in outbound order, omitting params when absent. Resolves when
   * process.write completes. CodexNativeAdapter.initializeClient and the catalog await this
   * write before sending domain requests. Serialization can throw synchronously. Closed
   * transport, oversized frames and failed writes reject.
   */
  notify(method: string, params?: NativeRecord): Promise<void> { return this.write({ method, ...(params ? { params } : {}) }) }
  /**
   * Send an RPC with empty params by default and await its correlated result. Callers must
   * validate native fields before use. T lets callers specify the expected result type.
   * Admission and frame preparation failures are definite, as are CodexRpcError replies. Timeout,
   * failed process writes, malformed responses and disposal report unknown outcomes without replay
   * or native cancellation. A timeout does not release write capacity until the write settles.
   */
  request<T = unknown>(method: string, params: NativeRecord = {}): Promise<T> {
    if (this.closed) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED'))
    const maxPending = this.options.maxPending ?? 128
    if (this.pending.size >= maxPending || this.queuedRequests >= maxPending) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'))
    const id = this.nextId++
    let encoded: string | HarnessSdkError
    try {
      encoded = this.encodeFrame({ id, method, params })
    } catch (cause) {
      return Promise.reject(cause)
    }
    if (typeof encoded !== 'string') return Promise.reject(encoded)
    // Serialization can invoke caller code before this request has reserved a slot.
    if (this.closed) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED'))
    if (this.pending.size >= maxPending || this.queuedRequests >= maxPending) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'))
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HarnessSdkError('REQUEST_TIMEOUT', 'Native request outcome is unknown', false, true))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.queuedRequests++
      void this.enqueueWrite(encoded).finally(() => { this.queuedRequests-- }).catch(() => {
        const waiting = this.takePendingRequest(id)
        if (!waiting) return
        waiting.reject(new HarnessSdkError('CONNECTION_CLOSED', 'Native request outcome is unknown', false, true))
      })
    })
  }
  /**
   * Close admission and reject waiters before disposing the process. Repeated calls share the
   * process cleanup promise and its outcome. Queued writes retain their order and may fail during
   * process teardown. Reader and interaction completion are independent of disposal.
   */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closeTransport(() => new HarnessSdkError('RUNTIME_DISPOSED', 'Codex client disposed', false, true))
      await this.process.dispose()
    })()
  }

  private nextId = 1
  private readonly pending = new Map<number | string, PendingRequest>()
  // Rejects new requests and writes; already queued writes are not cancelled.
  private closed = false
  // Shares the explicit process-disposal task across dispose() calls.
  private disposing?: Promise<void>
  private writeTail: Promise<void> = Promise.resolve()
  private queuedRequests = 0
  private activeServerRequestHandlers = 0
  private readonly maxFrameBytes: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  /** Constructor-owned stderr reader: publish codes without native bytes and absorb read/callback failures so diagnostics cannot take over stdout's connection lifecycle. */
  private async drainDiagnostics(): Promise<void> {
    try {
      for await (const chunk of this.process.stderr) {
        if (chunk.byteLength) this.handlers.diagnostic?.('CODEX_STDERR')
      }
    } catch { /* stdout owns failure; stderr is never exposed verbatim */ }
  }
  /** Prepare and queue a reply or notification. Serialization can throw synchronously. */
  private write(message: NativeRecord): Promise<void> {
    if (this.closed) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED', 'Codex connection is closed', false, true))
    const encoded = this.encodeFrame(message)
    return typeof encoded === 'string' ? this.enqueueWrite(encoded) : Promise.reject(encoded)
  }
  private encodeFrame(message: NativeRecord): string | HarnessSdkError {
    const encoded = JSON.stringify(message) + '\n'
    if (new TextEncoder().encode(encoded).byteLength > this.maxFrameBytes) return new HarnessSdkError('FRAME_TOO_LARGE')
    return encoded
  }
  private enqueueWrite(encoded: string): Promise<void> {
    const writeTask = this.writeTail.then(() => this.process.write(encoded))
    // Recover the queue for later writes; the returned writeTask still propagates this write's failure.
    this.writeTail = writeTask.catch(() => {})
    return writeTask
  }
  /** Drain stdout in wire order before reporting EOF. Keep partial UTF-8 and lines across chunks. Invalid, oversized or nonblank unterminated frames reject into the constructor's failure handler. */
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
      this.assertIncomingFrameSize(buffer.replace(/\r$/, ''))
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
  /** Route a decoded frame. Await notification delivery to preserve event order. Start server requests concurrently so later frames can arrive during user interaction. Invalid IDs and handler failures can reject the reader. */
  private async receive(message: NativeRecord): Promise<void> {
    const id = message.id
    const method = message.method
    if (typeof method === 'string' && id === undefined) {
      await this.handlers.notification(method, record(message.params))
      return
    }
    if (typeof id !== 'number' && typeof id !== 'string') throw new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Codex message ID', false, true)
    if (typeof method === 'string') {
      this.startServerRequest({ id, method, params: record(message.params) })
      return
    }
    this.settleResponse(id, message)
  }
  /** Reserve a slot before invoking the handler. The reader observes overflow and synchronous throws. For returned promises, release the slot after the handler and any fallback settle, even if the reply was written earlier. */
  private startServerRequest(request: NativeRequest): void {
    if (++this.activeServerRequestHandlers > (this.options.maxServerRequests ?? 32)) {
      throw new HarnessSdkError('BACKPRESSURE_EXCEEDED', 'Too many native interactions', false, true)
    }
    const { reply, reject } = this.createServerResponder(request.id)
    void this.handlers.request(request, reply, reject)
      .catch(() => reject(-32603, 'Interaction unavailable'))
      .catch(() => {})
      .finally(() => { this.activeServerRequestHandlers-- })
  }

  /** Supply the callbacks for one native ID. The first callback claims the response before writing, so an ambiguous write failure cannot trigger a duplicate response. */
  private createServerResponder(id: NativeRequest['id']) {
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
    return { reply, reject }
  }
  /** Settle receive's validated response ID after removing its waiter and deadline. Ignore late/duplicate replies; reject native errors safely, prefer error over result and reject missing payloads as protocol errors. */
  private settleResponse(id: number | string, message: NativeRecord): void {
    const waiting = this.takePendingRequest(id)
    if (!waiting) return // A late or duplicate response has no waiter to settle.
    if (Object.hasOwn(message, 'error')) {
      const error = record(message.error)
      const code = error.code
      if (typeof code === 'number' && Number.isInteger(code)) {
        waiting.reject(new CodexRpcError(code, code === -32600 && string(error.message)?.startsWith(SUBAGENT_DIRECT_INPUT_DENIAL) === true))
        return
      }
    } else if (Object.hasOwn(message, 'result')) {
      waiting.resolve(message.result)
      return
    }
    waiting.reject(new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Codex response', false, true))
  }
  /** Release a response/write-failure waiter's capacity and deadline before settling it. Unknown or already-settled IDs return undefined, leaving other requests untouched. */
  private takePendingRequest(id: number | string): PendingRequest | undefined {
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    clearTimeout(waiting.timer)
    return waiting
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
}

/** One admitted RPC's completion callbacks and deadline; removing it must also retire its timer. */
interface PendingRequest {
  resolve(value: unknown): void
  reject(cause: unknown): void
  timer: ReturnType<typeof setTimeout>
}