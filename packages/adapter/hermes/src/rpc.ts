import { BoundedEventQueue, HarnessSdkError } from '@anureo/sdk'
import type { GatewayGrant } from './attach'
import type { HermesAdapterOptions } from './options'
import { event, HermesRpcError, object, protocolError, type NativeEvent, type NativeObject } from './native'

/** Internal gateway-to-client request; probe handlers and HermesInteractions reply or reject using the same id. */
export interface ServerRequest { id: string | number; method: string; params: NativeObject }

/**
 * Internal, bounded JSON-RPC channel for adapter probes and sessions. Responses settle requests
 * immediately; events and server requests run serially so a handler can await an RPC acknowledgement.
 * HermesAdapter.initialize disposes its probe; HermesSession disposes each channel on recovery/close.
 */
export class HermesRpc {
  /** Install transport listeners and start serial delivery before connect waits for the opening handshake. */
  private constructor(private readonly socket: WebSocket, private readonly handlers: Handlers, private readonly options: HermesAdapterOptions) {
    this.queue = new BoundedEventQueue({ maxFrameBytes: options.maxFrameBytes, maxBytes: options.maxBufferedBytes, maxEvents: options.maxEvents })
    this.finished = this.read().catch(cause => {
      const error = cause instanceof HarnessSdkError ? cause : protocolError()
      this.stop(error)
      if (!this.disposed) this.handlers.failure(error)
    })
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('message', message => {
      if (this.closed) return
      try { this.receive(message.data) } catch (cause) { this.stop(cause instanceof HarnessSdkError ? cause : protocolError()) }
    })
    socket.addEventListener('close', () => this.stop(new HarnessSdkError('CONNECTION_CLOSED', 'Hermes connection closed', false, true)))
    socket.addEventListener('error', () => this.stop(new HarnessSdkError('CONNECTION_CLOSED', 'Hermes connection failed', false, true)))
  }
  /**
   * Open a fresh grant and require hermes-gateway-v1 negotiation. Reject factory/open failures,
   * timeout, protocol mismatch or abort; after channel construction, failure disposes its socket.
   * The signal only cancels opening. On success the caller must dispose the channel separately.
   */
  static async connect(grant: GatewayGrant, handlers: Handlers, options: HermesAdapterOptions, signal?: AbortSignal): Promise<HermesRpc> {
    if (signal?.aborted) throw new HarnessSdkError('RUNTIME_DISPOSED')
    let socket: WebSocket
    try {
      socket = options.webSocketFactory ? options.webSocketFactory(grant.url, [...grant.protocols]) : new WebSocket(grant.url, grant.protocols)
    } catch { throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'Cannot connect to Hermes gateway', true) }
    const client = new HermesRpc(socket, handlers, options)
    try {
      await waitForOpen(socket, options.timeoutMs ?? 30_000, signal)
      return client
    } catch (cause) { client.dispose(); throw cause }
  }
  /** Whether the local channel still permits writes; this does not establish remote liveness. */
  get connected(): boolean { return !this.closed && this.socket.readyState === 1 }
  /**
   * Resolve with the correlated native result, without waiting for event delivery or execution
   * completion. Reject native RPC errors, admission/write failures, timeout or channel closure.
   * mutation marks timeout/lost-delivery outcomes unknown; it never retries or cancels remote work.
   * HermesSession and HermesInteractions supply it for operations that can change native state.
   */
  request(method: string, params: NativeObject = {}, mutation = false): Promise<unknown> {
    if (!this.connected) return Promise.reject(new HarnessSdkError('CONNECTION_CLOSED'))
    if (this.pending.size >= (this.options.maxPending ?? 128)) return Promise.reject(new HarnessSdkError('BACKPRESSURE_EXCEEDED'))
    const id = `anureo-${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HarnessSdkError('RPC_TIMEOUT', 'Hermes request timed out', false, mutation))
      }, this.options.timeoutMs ?? 30_000)
      this.pending.set(id, { resolve, reject, timer, mutation })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (cause) {
        clearTimeout(timer); this.pending.delete(id)
        reject(cause instanceof HarnessSdkError ? cause : new HarnessSdkError('CONNECTION_CLOSED', 'Hermes write failed', false, mutation))
      }
    })
  }
  /**
   * Send HermesInteractions' answer to a gateway request. Resolve after local socket.send, without
   * remote acknowledgement; any write failure rejects RESULT_UNKNOWN with an unknown outcome.
   */
  reply(id: string | number, result: unknown): Promise<void> {
    return this.respond({ jsonrpc: '2.0', id, result })
  }
  /** Reject an unsupported gateway request; delivery and failure semantics match reply. */
  reject(id: string | number): Promise<void> {
    return this.respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client interaction' } })
  }
  /**
   * Idempotently close local observation and reject pending RPCs without stopping native execution.
   * Suppress failure callbacks; callers needing handler completion must also await finished.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop(new HarnessSdkError('CONNECTION_CLOSED', 'Hermes observation closed', false, true))
  }

  private readonly queue: BoundedEventQueue<Incoming>
  private readonly pending = new Map<string | number, Waiting>()
  private nextId = 0
  private closed = false
  private disposed = false
  /**
   * Settle after queued handling ends and failure is reported. Disposal skips buffered entries but
   * does not cancel an active handler; HermesSession.recover awaits this before replaying a new channel.
   * Transport/handler failures are handled here rather than rejected, unless failure itself throws.
   */
  readonly finished: Promise<void>

  /**
   * Deliver queued events/requests in order. The constructor's catch closes the channel on handler
   * failure and reports it; disposed channels skip buffered entries while an active handler finishes.
   */
  private async read(): Promise<void> {
    for await (const entry of this.queue) {
      if (this.disposed) continue
      if (entry.kind === 'event') await this.handlers.event(entry.value)
      else await this.handlers.request(entry.value)
    }
  }
  /** The message listener validates/routes each frame; throwing closes the channel through that listener. */
  private receive(raw: unknown): void {
    const frame = decodeFrame(raw, this.options.maxFrameBytes ?? 8 * 1024 * 1024)
    const id = frame.id
    if (typeof frame.method === 'string') {
      if (id === undefined) {
        if (frame.method === 'event') this.queue.push({ kind: 'event', value: event(frame.params) })
      } else {
        if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id))) throw protocolError()
        this.queue.push({ kind: 'request', value: { id, method: frame.method, params: object(frame.params ?? {}) } })
      }
      return
    }
    this.receiveResponse(frame)
  }
  /** Settle a matching request without entering the handler queue; late or unknown response ids are ignored. */
  private receiveResponse(frame: NativeObject): void {
    const id = frame.id
    if (typeof id !== 'string' && typeof id !== 'number' || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) throw protocolError()
    const waiting = this.pending.get(id)
    if (!waiting) return
    const nativeError = Object.hasOwn(frame, 'error') ? new HermesRpcError(object(frame.error)) : undefined
    this.pending.delete(id); clearTimeout(waiting.timer)
    if (nativeError) waiting.reject(nativeError)
    else waiting.resolve(frame.result)
  }
  /** Enforce per-frame and socket backlog limits before a synchronous write; callers decide how to report failures. */
  private send(frame: NativeObject): void {
    if (!this.connected) throw new HarnessSdkError('CONNECTION_CLOSED', 'Hermes connection is closed')
    const value = JSON.stringify(frame)
    const bytes = Buffer.byteLength(value)
    if (bytes > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('FRAME_TOO_LARGE')
    if (this.socket.bufferedAmount + bytes > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.socket.send(value)
  }
  /** Share response delivery/error mapping so answers and unsupported-request replies cannot drift. */
  private respond(frame: NativeObject): Promise<void> {
    try { this.send(frame); return Promise.resolve() }
    catch { return Promise.reject(new HarnessSdkError('RESULT_UNKNOWN', 'Hermes response could not be delivered', false, true)) }
  }
  /** End observation once; reject pending work with its mutation uncertainty before ending queued delivery and closing the socket. */
  private stop(cause: HarnessSdkError): void {
    if (this.closed) return
    this.closed = true
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new HarnessSdkError(cause.code, cause.message, false, waiting.mutation))
    }
    this.pending.clear(); this.queue.end(cause); this.socket.close()
  }
}

/**
 * Supplied by HermesAdapter.initialize for probes and HermesSession.connect for session delivery.
 * read awaits event/request callbacks serially; failure is invoked when read fails, unless disposed.
 * Callbacks must not wait for a user answer: response RPCs bypass this queue, but later events do not.
 */
interface Handlers {
  event(value: NativeEvent): Promise<void>
  request(value: ServerRequest): Promise<void>
  failure(cause: HarnessSdkError): void
}
interface Waiting {
  resolve(value: unknown): void
  reject(cause: unknown): void
  timer: ReturnType<typeof setTimeout>
  mutation: boolean
}
type Incoming = { kind: 'event'; value: NativeEvent } | { kind: 'request'; value: ServerRequest }

/** Require bounded UTF-8 JSON-RPC input; decoding/parsing errors are normalized by the message listener. */
function decodeFrame(raw: unknown, maxFrameBytes: number): NativeObject {
  let value: string
  if (typeof raw === 'string') value = raw
  else if (raw instanceof ArrayBuffer) value = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  else throw protocolError()
  if (Buffer.byteLength(value) > maxFrameBytes) throw new HarnessSdkError('FRAME_TOO_LARGE')
  const frame = object(JSON.parse(value))
  if (frame.jsonrpc !== '2.0') throw protocolError()
  return frame
}

/** Own opening listeners/deadline only; connect disposes the channel if negotiation, cancellation or transport fails. */
function waitForOpen(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', opened)
      socket.removeEventListener('close', failed)
      socket.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
    }
    const opened = () => {
      cleanup()
      socket.protocol === 'hermes-gateway-v1' ? resolve() : reject(new HarnessSdkError('HERMES_GATEWAY_UNSUPPORTED', 'Hermes WebSocket protocol mismatch'))
    }
    const failed = () => { cleanup(); reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes connection failed', true)) }
    const aborted = () => { cleanup(); reject(new HarnessSdkError('RUNTIME_DISPOSED')) }
    const timer = setTimeout(failed, timeoutMs)
    socket.addEventListener('open', opened, { once: true })
    socket.addEventListener('close', failed, { once: true })
    socket.addEventListener('error', failed, { once: true })
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) { aborted(); return }
    if (socket.readyState === 1) opened()
    else if (socket.readyState > 1) failed()
  })
}
