export interface RpcRequest {
  id: number | null
  method: string
  params?: unknown
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: unknown
}

export type RpcResponse = { jsonrpc: '2.0'; id: number | null } & (
  | { result: unknown; error?: never }
  | { error: { code: number; message: string; data?: unknown }; result?: never }
)

export interface HostConnection<Actor> {
  id: string
  principal(): Actor | null
  send(notification: RpcNotification): void | Promise<void>
  close?(): void
}

export interface HostDispatcher<Actor> {
  handle(connection: HostConnection<Actor>, request: RpcRequest): RpcResponse | Promise<RpcResponse>
  disconnect(connectionId: string): void
}

export function rpcError(id: number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function decodeRequest(text: string): RpcRequest | RpcResponse {
  let value: unknown
  try { value = JSON.parse(text) } catch { return rpcError(null, -32700, 'Parse error') }
  if (!value || typeof value !== 'object' || !('jsonrpc' in value) || value.jsonrpc !== '2.0'
    || !('id' in value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)
    || !('method' in value) || typeof value.method !== 'string' || !value.method) {
    return rpcError(null, -32600, 'Invalid Request')
  }
  return { id: value.id, method: value.method, ...('params' in value ? { params: value.params } : {}) }
}
