import { createServer, type Server as HttpServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@anureo/protocol'
import { HarnessSdkError } from '../errors'

export const OUTPUT_SERVER_NAME = 'anureo_output'
export const OUTPUT_TOOL = {
  name: 'submit_result',
  description: 'Submit the final structured result for the current task. Use its outputId and satisfy its JSON Schema. After acceptance, end the task. On validation errors, correct the value and submit again.',
  inputSchema: { type: 'object' as const, properties: { outputId: { type: 'string', minLength: 1 }, value: {} }, required: ['outputId', 'value'], additionalProperties: false },
}
export interface OutputBridgeLease {
  readonly config: McpServer
  dispose(): Promise<void>
}
type Handler = (args: unknown) => Promise<CallToolResult>
interface Lease { credential: string; handler: Handler; active: Set<Server>; disposed: boolean; requests: number }

/** One listener per Client; independent leases and protocol instances prevent cross-session state. */
export class OutputBridgeManager {
  private listener?: HttpServer
  private starting?: Promise<number>
  private closed = false
  private readonly leases = new Map<string, Lease>()
  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {}
  private listen(): Promise<number> {
    return this.starting ??= new Promise((resolve, reject) => {
      const listener = this.listener = createServer((req, res) => {
        let counted: Lease | undefined
        void (async () => {
          const lease = this.leases.get(req.url ?? '')
          if (this.closed || !lease || lease.disposed) { res.writeHead(404).end(); return }
          if (req.headers.authorization !== `Bearer ${lease.credential}`) { res.writeHead(401).end(); return }
          const address = listener.address()
          const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
          if (req.headers.host !== expectedHost || req.headers.origin && req.headers.origin !== `http://${expectedHost}`) { res.writeHead(403).end(); return }
          if (req.method !== 'POST') { res.writeHead(405).end(); return }
          if (lease.requests >= 32) { res.writeHead(429).end(); return }
          lease.requests++; counted = lease
          const chunks: Buffer[] = []; let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > this.maxFrameBytes) { res.writeHead(413).end(); return }
            chunks.push(Buffer.from(chunk))
          }
          let body: unknown
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400).end(); return }
          if (lease.disposed) { res.writeHead(404).end(); return }
          const server = new Server({ name: OUTPUT_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
          server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [OUTPUT_TOOL] }))
          server.setRequestHandler(CallToolRequestSchema, async request => {
            if (lease.disposed) return toolError('STRUCTURED_OUTPUT_EXPIRED')
            if (request.params.name !== OUTPUT_TOOL.name) return toolError('UNKNOWN_TOOL')
            return lease.handler(request.params.arguments)
          })
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
          lease.active.add(server)
          res.once('close', () => { lease.active.delete(server); void server.close().catch(() => {}) })
          await server.connect(transport)
          await transport.handleRequest(req, res, body)
        })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }).finally(() => { if (counted) counted.requests-- })
      })
      listener.requestTimeout = 30_000
      listener.headersTimeout = 10_000
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address()
        if (!address || typeof address === 'string') { reject(new HarnessSdkError('STRUCTURED_OUTPUT_BRIDGE_FAILED')); return }
        if (this.closed) { listener.close(); reject(new HarnessSdkError('CLIENT_DISPOSED')); return }
        resolve(address.port)
      })
    })
  }
  async create(transport: 'http' | 'stdio', handler: Handler): Promise<OutputBridgeLease> {
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED')
    const proxy = transport === 'stdio' ? createRequire(import.meta.url).resolve('@anureo/sdk/structured-output-stdio') : undefined
    const port = await this.listen()
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED')
    const path = `/mcp/${randomBytes(24).toString('hex')}`
    const credential = randomBytes(32).toString('hex')
    const lease: Lease = { credential, handler, active: new Set(), disposed: false, requests: 0 }
    this.leases.set(path, lease)
    const url = `http://127.0.0.1:${port}${path}`
    const config: McpServer = transport === 'http'
      ? { type: 'http', name: OUTPUT_SERVER_NAME, url, headers: { Authorization: `Bearer ${credential}` } }
      : { type: 'stdio', name: OUTPUT_SERVER_NAME, command: process.execPath, args: [proxy!], env: { ANUREO_OUTPUT_BRIDGE_URL: url, ANUREO_OUTPUT_BRIDGE_AUTH: credential } }
    return { config, dispose: async () => {
      if (lease.disposed) return
      lease.disposed = true; this.leases.delete(path)
      const results = await Promise.allSettled([...lease.active].map(server => server.close()))
      lease.active.clear()
      if (results.some(result => result.status === 'rejected')) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED')
    } }
  }
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const lease of this.leases.values()) { lease.disposed = true; await Promise.allSettled([...lease.active].map(server => server.close())) }
    this.leases.clear()
    if (this.starting) await this.starting.catch(() => {})
    if (this.listener?.listening) {
      const stopped = new Promise<void>((resolve, reject) => this.listener!.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()))
      this.listener.closeAllConnections()
      await stopped
    }
  }
}

export function toolError(code: string, issues?: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, ...(issues ? { issues } : {}) }) }] }
}
