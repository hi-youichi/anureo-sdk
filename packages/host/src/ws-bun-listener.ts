import { createHostWebSocket, type HostWebSocketConnection } from './ws-connection'
import type { HostWebSocketListenerOptions } from './ws-listener'

export function listenBunHostWebSocket<Actor>(options: HostWebSocketListenerOptions<Actor>) {
  const transport = createHostWebSocket(options)
  const pathname = options.path ?? '/rpc'
  const maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) throw new RangeError('maxBufferedBytes must be a positive integer')
  type SocketData = { principal: () => Actor | null; connection?: HostWebSocketConnection }
  const server = Bun.serve<SocketData>({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname !== pathname) return new Response(null, { status: 404 })
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
      const principal = await options.authenticate(request)
      if (!principal || !principal()) return new Response(null, { status: 401 })
      if (server.upgrade(request, { data: { principal } })) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      maxPayloadLength: options.maxMessageBytes ?? 1024 * 1024,
      backpressureLimit: maxBufferedBytes,
      closeOnBackpressureLimit: true,
      open(socket) {
        socket.data.connection = transport.attach({
          send: text => socket.send(text) > 0,
          close: (code, reason) => socket.close(code, reason),
        }, socket.data.principal)
      },
      message(socket, message) {
        if (typeof message === 'string') void socket.data.connection?.receive(message)
        else socket.close(1003, 'Text messages required')
      },
      close(socket) {
        socket.data.connection?.disconnect()
      },
    },
  })
  return {
    address: { address: server.hostname, port: server.port },
    async close() { await server.stop(true) },
  }
}
