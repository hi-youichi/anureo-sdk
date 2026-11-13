// Owns authenticated loopback bridge listeners and leases; must not validate task results or own output-tool policy.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@anureo/protocol'
import { OUTPUT_SERVER_NAME, OUTPUT_TOOL, toolError } from './tool'
import { HarnessSdkError } from '../sdk-error'

// Preserve existing bridge imports while production callers depend on the tool contract directly.
export { OUTPUT_SERVER_NAME, OUTPUT_TOOL, toolError } from './tool'

/** Session-scoped authenticated endpoint configuration and its cleanup handle; the manager owns the shared listener. */
export interface OutputBridgeLease {
  /** Native-reachable config contains lease credentials; callers must keep it out of public state/history. */
  readonly config: McpServer
  /** Invalidate this endpoint and close its active protocol instances; reject release failure without stopping other leases. */
  dispose(): Promise<void>
}
type Handler = (args: unknown) => Promise<CallToolResult>
/** One lease's secret, submission handler and live protocol instances; requests counts admitted HTTP bodies until their response settles. */
interface Lease { credential: string; handler: Handler; active: Set<Server>; disposed: boolean; requests: number }

/** One listener per Client; independent leases and protocol instances prevent cross-session state. */
export class OutputBridgeManager {
  private listener?: HttpServer
  private starting?: Promise<number>
  private closed = false
  private readonly leases = new Map<string, Lease>()
  /** Configure the maximum HTTP request frame for a client-wide manager; no listener starts before the first lease is requested. */
  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {}
  /** Lazily start one authenticated loopback HTTP listener and cache its port promise; reject startup/disposal races. */
  private listen(): Promise<number> {
    return this.starting ??= new Promise((resolve, reject) => {
      const listener = this.listener = createServer((req, res) => {
        void this.handleRequest(req, res, listener)
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
  /** Admit one authenticated request, account for it while its body/response is active, and dispatch it to a lease-local MCP server. */
  private handleRequest(req: IncomingMessage, res: ServerResponse, listener: HttpServer): Promise<void> {
    let counted: Lease | undefined
    // Keep accounting outside dispatch so an error response precedes permit release.
    return (async () => {
      const lease = this.admitRequest(req, res, listener)
      if (!lease) return
      lease.requests++; counted = lease
      const body = await this.readRequestBody(req, res)
      if (body === undefined) return
      if (lease.disposed) { res.writeHead(404).end(); return }
      await this.dispatchRequest(req, res, body, lease)
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }).finally(() => { if (counted) counted.requests-- })
  }
  /** Apply endpoint, credential, origin, method and concurrency rules in order; write the established rejection status and return no lease on failure. */
  private admitRequest(req: IncomingMessage, res: ServerResponse, listener: HttpServer): Lease | undefined {
    const lease = this.leases.get(req.url ?? '')
    if (this.closed || !lease || lease.disposed) { res.writeHead(404).end(); return }
    if (req.headers.authorization !== `Bearer ${lease.credential}`) { res.writeHead(401).end(); return }
    const address = listener.address()
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    if (req.headers.host !== expectedHost || req.headers.origin && req.headers.origin !== `http://${expectedHost}`) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (lease.requests >= 32) { res.writeHead(429).end(); return }
    return lease
  }
  /** Read and parse one bounded JSON frame; return undefined after writing the original 413 or 400 response. */
  private async readRequestBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > this.maxFrameBytes) { res.writeHead(413).end(); return }
      chunks.push(Buffer.from(chunk))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { res.writeHead(400).end(); return }
  }
  /** Create and connect an independent MCP server/transport for this HTTP response; response close removes and closes the server. */
  private async dispatchRequest(req: IncomingMessage, res: ServerResponse, body: unknown, lease: Lease): Promise<void> {
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
  }
  /** Allocate an unguessable authenticated session endpoint and HTTP/stdio MCP config; reject disposed managers, proxy resolution or listener failure. Caller must dispose the returned lease. */
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
  /** Close admission, settle active protocol instances, then stop listener/connections; reject listener shutdown errors after invalidating every lease. */
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
