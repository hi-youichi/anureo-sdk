/** Owns process-stream framing, RPC correlation and transport cleanup; it must not interpret session policy or native payloads. */
import { HarnessSdkError } from '@anureo/sdk'
import type { HarnessProcess } from '@anureo/sdk/process'

import { record, type NativeRecord } from './native-values'
/** Keep value helpers available through the public JSONL entry point while their interpretation remains owned by native-values. */
export { record, string, type NativeRecord } from './native-values'
/** Server interaction delivered to JsonlHandlers.request; the handler interprets params and answers through the supplied reply/reject callbacks. */
export interface NativeRequest {
  /** Native correlation identity echoed unchanged in replies. */
  id: number | string;
  method: string;
  /** Unvalidated method-specific fields; session handlers own interpretation. */
  params: NativeRecord
}
/** Callbacks supplied at construction. CodexNativeAdapter.openSession forwards them to CodexBackendSession; probe/catalog owners supply non-interactive handlers. The client invokes them while reading, and its owner must dispose the client after closure. */
export interface JsonlHandlers {
  /** Consume a notification before the next frame is dispatched; throwing or rejecting fails the reader. Waiting for work that needs later stdout frames would block its own completion. */
  notification(method: string, params: NativeRecord): Promise<void>;
  /** Handle an interaction concurrently and await its reply/reject write; capacity is held until this promise and any fallback settle. Both callbacks claim before I/O: duplicate reply rejects, duplicate reject is a no-op. Supply safe result/error payloads; no redaction occurs here. Async handler rejection sends a fallback only if unclaimed; synchronous throws fail the stream. Resolving without answering sends nothing. */
  request(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void>;
  /** Observe reader failure or EOF after pending requests reject; explicit disposal does not call this. Rejection reaches finished on stream errors, but is absorbed at EOF by the already-closed guard. Always dispose afterward. */
  failure(cause: HarnessSdkError): Promise<void>;
  /** Diagnostic code only. Native stderr bytes and request params never reach this callback. */
  diagnostic?(code: string): void;
}
/** Bounds configured by transport owners to limit pending RPCs, frame bytes and concurrent interactions; exceeding a bound fails admission or reading. */
export interface JsonlOptions {
  /** Per-request response deadline from admission, including queued write time; defaults to 30,000ms. Timeout reports an unknown outcome without cancelling native work. */
  timeoutMs?: number;
  /** Maximum UTF-8 bytes per frame, default 8MiB; outgoing includes the newline, incoming excludes the CRLF/LF delimiter. */
  maxFrameBytes?: number;
  /** Maximum unresolved client requests, default 128. */
  maxPending?: number;
  /** Maximum concurrent server handlers until their full completion, default 32. */
  maxServerRequests?: number
}
/** Definite native rejection returned to RPC callers without the native message or payload. rpcCode -32601 lets session optional-method dispatch revoke capabilities and account reads return unknown; other codes remain NATIVE_RPC_ERROR. */
export class CodexRpcError extends HarnessSdkError {
  /** For response decoding, map a numeric native code to a safe SDK error without I/O; method-not-found stays distinguishable from other definite failures. */
  constructor(readonly rpcCode: number) { super(rpcCode === -32601 ? 'METHOD_NOT_FOUND' : 'NATIVE_RPC_ERROR', 'Native Codex request failed', false, false, { rpcCode }) }
}
/** Exchange native Codex frames over a supplied process. Construction starts readers, writes are serialized and replies correlated; the owner must dispose even after reader failure or EOF. Native frames omit the public AHP JSON-RPC header. */
export class CodexJsonlClient {
  /** Reader/failure completion for owners observing stdout; excludes stderr, asynchronous interactions and process disposal. EOF absorbs failure-callback rejection; stream-error reporting propagates it. */
  readonly finished: Promise<void>
  /** Start draining a supplied process with the owner's handlers before requests can be sent; no process is spawned here. The owner must dispose even if finished resolves or rejects. */
  constructor(readonly process: HarnessProcess, private readonly handlers: JsonlHandlers, private readonly options: JsonlOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024
    // Read before initialize; stdout EOF, rather than process exit, preserves buffered final frames.
    this.finished = this.read().catch(cause => this.fail(cause instanceof HarnessSdkError ? cause : new HarnessSdkError('PROTOCOL_ERROR', 'Invalid Codex stream', false, true)))
    void this.drainDiagnostics()
  }
  /** Write a notification in outbound order, omitting params when not supplied. Completion means process.write completed, not native acceptance. Serialization can throw synchronously; closed/oversized frames and write failures reject. */
  notify(method: string, params?: NativeRecord): Promise<void> { return this.write({ method, ...(params ? { params } : {}) }) }
  /**
   * Send an RPC (with empty params by default) and await its correlated result; T is a caller
   * assertion, not payload validation.
   * Closed/capacity admission failures are definite, as are CodexRpcError replies. Timeout, failed
   * writes (including frame-bound rejection) and disposal report unknown outcomes without replay or
   * native cancellation. Serialization exceptions reject unchanged but leave the pending slot until
   * its deadline, a response or closure; reader failures keep their own classification. Callers
   * interpret the result and decide recovery; they still own client disposal.
   */
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
        const waiting = this.takePendingRequest(id)
        if (!waiting) return
        reject(new HarnessSdkError('CONNECTION_CLOSED', 'Native request outcome is unknown', false, true))
      })
    })
  }
  /** Close admission and reject waiters before disposing the process. Repeated calls share success or rejection; queued writes keep their order, and neither finished nor interaction handlers are awaited. */
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
  /** Called by receive to reserve a handler slot and launch an interaction without blocking stdout. Throws on overflow or synchronous handler failure; asynchronous failure attempts a fallback only while unclaimed. The slot lasts through fallback completion. */
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
    const waiting = this.takePendingRequest(id)
    if (!waiting) return // timed-out/duplicate response is observed and not replayed
    if (Object.hasOwn(message, 'error')) waiting.reject(new CodexRpcError(Number(record(message.error).code ?? -32603)))
    else if (Object.hasOwn(message, 'result')) waiting.resolve(message.result)
    else waiting.reject(new HarnessSdkError('PROTOCOL_ERROR'))
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
