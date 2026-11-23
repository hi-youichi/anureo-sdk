export { createHostWebSocket, type HostWebSocket, type HostWebSocketConnection, type HostWebSocketOptions, type WebSocketPort } from './ws-connection'
import type { HostWebSocketListenerOptions } from './ws-listener'
export type { HostWebSocketListenerOptions } from './ws-listener'

export async function listenHostWebSocket<Actor>(options: HostWebSocketListenerOptions<Actor>) {
  if (typeof Bun !== 'undefined') {
    const { listenBunHostWebSocket } = await import('./ws-bun-listener')
    return listenBunHostWebSocket(options)
  }
  const { listenNodeHostWebSocket } = await import('./ws-listener')
  return listenNodeHostWebSocket(options)
}
