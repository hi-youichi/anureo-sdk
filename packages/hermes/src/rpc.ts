import { BoundedEventQueue, HarnessSdkError } from '@anureo/sdk'
import type { GatewayGrant } from './attach'
import type { HermesAdapterOptions } from './options'
import { event, HermesRpcError, object, protocolError, type NativeEvent, type NativeObject } from './native'

export interface ServerRequest { id: string | number; method: string; params: NativeObject }
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

/** Responses never wait for event handlers or a user answer on the other half of the channel. */
export class HermesRpc {
  private readonly queue: BoundedEventQueue<Incoming>
  private readonly pending = new Map<string | number, Waiting>()
  private nextId = 0
  private closed = false
  private disposed = false
  readonly finished: Promise<void>
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
  static async connect(grant: GatewayGrant, handlers: Handlers, options: HermesAdapterOptions, signal?: AbortSignal): Promise<HermesRpc> {
    if (signal?.aborted) throw new HarnessSdkError('RUNTIME_DISPOSED')
    let socket: WebSocket
    try {
      socket = options.webSocketFactory ? options.webSocketFactory(grant.url, [...grant.protocols]) : new WebSocket(grant.url, grant.protocols)
    } catch { throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'Cannot connect to Hermes gateway', true) }
    const client = new HermesRpc(socket, handlers, options)
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('close', failed); socket.removeEventListener('error', failed)
          signal?.removeEventListener('abort', aborted)
        }
        const opened = () => {
          cleanup()
          socket.protocol === 'hermes-gateway-v1' ? resolve() : reject(new HarnessSdkError('HERMES_GATEWAY_UNSUPPORTED', 'Hermes WebSocket protocol mismatch'))
        }
        const failed = () => { cleanup(); reject(new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes connection failed', true)) }
        const aborted = () => { cleanup(); reject(new HarnessSdkError('RUNTIME_DISPOSED')) }
        const timer = setTimeout(failed, options.timeoutMs ?? 30_000)
        socket.addEventListener('open', opened, { once: true }); socket.addEventListener('close', failed, { once: true }); socket.addEventListener('error', failed, { once: true })
        signal?.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted) { aborted(); return }
        if (socket.readyState === 1) opened()
        else if (socket.readyState > 1) failed()
      })
      return client
    } catch (cause) { client.dispose(); throw cause }
  }
  get connected(): boolean { return !this.closed && this.socket.readyState === 1 }
  private async read(): Promise<void> {
    for await (const entry of this.queue) {
      if (this.disposed) continue
      if (entry.kind === 'event') await this.handlers.event(entry.value)
      else await this.handlers.request(entry.value)
    }
  }
  private receive(raw: unknown): void {
    let value: string
    if (typeof raw === 'string') value = raw
    else if (raw instanceof ArrayBuffer) value = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    else throw protocolError()
    if (Buffer.byteLength(value) > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('FRAME_TOO_LARGE')
    const frame = object(JSON.parse(value))
    if (frame.jsonrpc !== '2.0') throw protocolError()
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
    if (typeof id !== 'string' && typeof id !== 'number' || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) throw protocolError()
    const waiting = this.pending.get(id)
    if (!waiting) return
    const nativeError = Object.hasOwn(frame, 'error') ? new HermesRpcError(object(frame.error)) : undefined
    this.pending.delete(id); clearTimeout(waiting.timer)
    if (nativeError) waiting.reject(nativeError)
    else waiting.resolve(frame.result)
  }
  private send(frame: NativeObject): void {
    if (!this.connected) throw new HarnessSdkError('CONNECTION_CLOSED', 'Hermes connection is closed')
    const value = JSON.stringify(frame)
    if (Buffer.byteLength(value) > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new HarnessSdkError('FRAME_TOO_LARGE')
    if (this.socket.bufferedAmount + Buffer.byteLength(value) > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.socket.send(value)
  }
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
  reply(id: string | number, result: unknown): Promise<void> {
    try { this.send({ jsonrpc: '2.0', id, result }); return Promise.resolve() }
    catch { return Promise.reject(new HarnessSdkError('RESULT_UNKNOWN', 'Hermes response could not be delivered', false, true)) }
  }
  reject(id: string | number): Promise<void> {
    try { this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client interaction' } }); return Promise.resolve() }
    catch { return Promise.reject(new HarnessSdkError('RESULT_UNKNOWN', 'Hermes response could not be delivered', false, true)) }
  }
  private stop(cause: HarnessSdkError): void {
    if (this.closed) return
    this.closed = true
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new HarnessSdkError(cause.code, cause.message, false, waiting.mutation))
    }
    this.pending.clear(); this.queue.end(cause); this.socket.close()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop(new HarnessSdkError('CONNECTION_CLOSED', 'Hermes observation closed', false, true))
  }
}
