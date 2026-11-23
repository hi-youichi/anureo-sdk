import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { createHostWebSocket, type HostWebSocketOptions } from './ws-connection'

export interface HostWebSocketListenerOptions<Actor> extends HostWebSocketOptions<Actor> {
  authenticate(request: Request): (() => Actor | null) | null | Promise<(() => Actor | null) | null>
  hostname?: string
  port?: number
  path?: string
  maxBufferedBytes?: number
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Start an application-owned listener. Closing it releases sockets without closing the Host. */
export async function listenNodeHostWebSocket<Actor>(options: HostWebSocketListenerOptions<Actor>) {
  const transport = createHostWebSocket(options)
  const pathname = options.path ?? '/rpc'
  const maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) throw new RangeError('maxBufferedBytes must be a positive integer')
  const websocket = new WebSocketServer({ noServer: true, maxPayload: options.maxMessageBytes ?? 1024 * 1024 })
  const server = createServer((_request, response) => response.writeHead(404).end())
  const upgrades = new Set<Duplex>()
  let closing: Promise<void> | undefined

  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?', 1)[0] !== pathname) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    upgrades.add(socket)
    const onError = () => socket.destroy()
    socket.on('error', onError)
    void Promise.resolve().then(() => options.authenticate(new Request(`http://localhost${request.url}`, { headers: request.headers as HeadersInit }))).then(principal => {
      if (socket.destroyed) return
      if (!principal || !principal()) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      websocket.handleUpgrade(request, socket, head, peer => {
        const connection = transport.attach({
          send(text) {
            if (peer.readyState !== WebSocket.OPEN || peer.bufferedAmount + Buffer.byteLength(text) > maxBufferedBytes) return false
            peer.send(text, error => { if (error) peer.terminate() })
          },
          close(code, reason) { peer.close(code, reason) },
        }, principal)
        peer.on('message', (data, binary) => {
          if (binary) peer.close(1003, 'Text messages required')
          else void connection.receive(data.toString())
        })
        peer.once('close', () => connection.disconnect())
        peer.on('error', () => peer.terminate())
      })
    }).catch(() => {
      if (!socket.destroyed) rejectUpgrade(socket, 500, 'Internal Server Error')
    }).finally(() => {
      upgrades.delete(socket)
      socket.off('error', onError)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.hostname ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')

  return {
    address,
    close(): Promise<void> {
      return closing ??= new Promise((resolve, reject) => {
        for (const socket of upgrades) socket.destroy()
        for (const peer of websocket.clients) peer.terminate()
        websocket.close()
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}
