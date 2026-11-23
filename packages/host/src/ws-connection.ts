import { randomUUID } from 'node:crypto'
import { decodeRequest, rpcError, type HostConnection, type HostDispatcher, type RpcNotification, type RpcRequest, type RpcResponse } from './rpc'

export interface WebSocketPort {
  /** Return false when the socket cannot accept the frame within its send budget. */
  send(text: string, kind: 'response' | 'notification'): boolean | void
  close(code: number, reason: string): void
  onNotification?(notification: RpcNotification): void
}

export interface HostWebSocketOptions<Actor> {
  dispatcher: HostDispatcher<Actor>
  maxMessageBytes?: number
  maxInFlight?: number
}

export interface HostWebSocketConnection {
  readonly id: string
  receive(text: string): Promise<void>
  dispatch(request: RpcRequest): Promise<{ response: RpcResponse; sent: boolean } | undefined>
  /** Call when the underlying connection closes or is removed from the host. */
  disconnect(): void
}

export interface HostWebSocket<Actor> {
  attach(socket: WebSocketPort, principal: () => Actor | null, id?: string): HostWebSocketConnection
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

/** Attach a Host to an application-owned WebSocket without taking over routing or HTTP upgrade. */
export function createHostWebSocket<Actor>(options: HostWebSocketOptions<Actor>): HostWebSocket<Actor> {
  const { dispatcher } = options
  const maxMessageBytes = positiveLimit(options.maxMessageBytes ?? 1024 * 1024, 'maxMessageBytes')
  const maxInFlight = positiveLimit(options.maxInFlight ?? 64, 'maxInFlight')
  const active = new Set<string>()

  return {
    attach(socket: WebSocketPort, principal: () => Actor | null, id: string = randomUUID()): HostWebSocketConnection {
      if (active.has(id)) throw new Error('Host connection id is already attached')
      active.add(id)
      let disconnected = false
      let pending = 0

      function disconnect() {
        if (disconnected) return
        disconnected = true
        dispatcher.disconnect(id)
        if (!pending) active.delete(id)
      }

      function close(code: number, reason: string) {
        if (disconnected) return
        disconnect()
        socket.close(code, reason)
      }

      function send(message: unknown, kind: 'response' | 'notification' = 'response'): boolean {
        if (disconnected) return false
        try {
          if (socket.send(JSON.stringify(message), kind) !== false) return true
        } catch (error) {
          close(1011, 'Send failed')
          if (kind === 'notification') throw error
          return false
        }
        close(1013, 'Send buffer full')
        if (kind === 'notification') throw new Error('Host WebSocket send buffer full')
        return false
      }

      const connection: HostConnection<Actor> = {
        id,
        principal: () => disconnected ? null : principal(),
        send(notification) {
          if (disconnected) return
          socket.onNotification?.(notification)
          send(notification, 'notification')
        },
        close: () => close(1011, 'Host closed connection'),
      }

      async function dispatch(request: RpcRequest) {
        if (disconnected) return
        if (pending >= maxInFlight) {
          const response = rpcError(request.id, -32000, 'Too many in-flight requests')
          return { response, sent: send(response) }
        }
        pending++
        try {
          let response: RpcResponse
          try { response = await dispatcher.handle(connection, request) }
          catch { response = rpcError(request.id, -32603, 'Internal error') }
          return { response, sent: send(response) }
        }
        finally {
          pending--
          if (disconnected && !pending) {
            // A request that was already authorized can finish after the socket closes.
            // Release any subscriptions it registered late before allowing id reuse.
            dispatcher.disconnect(id)
            active.delete(id)
          }
        }
      }

      return {
        id,
        async receive(text) {
          if (disconnected) return
          if (Buffer.byteLength(text) > maxMessageBytes) {
            close(1009, 'Message too large')
            return
          }
          const message = decodeRequest(text)
          if ('jsonrpc' in message) send(message)
          else await dispatch(message)
        },
        dispatch,
        disconnect,
      }
    },
  }
}
