// Owns the shared loopback listener, authenticated session leases and request-scoped MCP transports.
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer } from '@anureo/protocol'
import { OUTPUT_SERVER_NAME, OUTPUT_TOOL, toolError } from './tool'
import { HarnessSdkError } from '../errors'

// Preserve existing bridge imports while production callers depend on the tool contract directly.
export { OUTPUT_SERVER_NAME, OUTPUT_TOOL, toolError } from './tool'

/** Internal endpoint and cleanup handle retained by OutputSession.prepareBridge. The manager owns the shared listener. */
export interface OutputBridgeLease {
  /** Native-reachable config containing lease credentials. Keep it out of public state and history. */
  readonly config: McpServer
  /**
   * Revoke admission immediately, then await active protocol closes. Reject with
   * RESOURCE_RELEASE_FAILED if any close rejects. Other leases remain usable. Repeated calls
   * return without waiting for an earlier disposal or retrying cleanup.
   */
  dispose(): Promise<void>
}

/**
 * Internal bridge owner constructed by withStructuredOutput for one Client. OutputSession.prepareBridge
 * requests independent session leases. The adapter wrapper must dispose this manager after session
 * cleanup to release the shared listener, even when individual lease cleanup fails.
 */
export class OutputBridgeManager {
  /** Set the HTTP body limit in bytes (default 8 MiB). A create call starts the listener on demand. */
  constructor(private readonly maxFrameBytes = 8 * 1024 * 1024) {}

  /**
   * Allocate an authenticated endpoint and native MCP configuration, awaiting shared listener startup.
   * OutputSession.prepareBridge supplies a serialized submitValue handler, injects config into native
   * open params and on setup failure releases any acquired lease before publishing a warning. Stdio
   * entry resolution happens before listener startup. Resolution and startup failures reject.
   * Observing manager disposal before lease allocation rejects with CLIENT_DISPOSED. Keep credentials
   * private and dispose the lease after use.
   */
  async create(transport: 'http' | 'stdio', handler: Handler): Promise<OutputBridgeLease> {
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED')
    const resolvedTransport: ResolvedTransport = transport === 'stdio'
      ? { type: 'stdio', proxy: createRequire(import.meta.url).resolve('@anureo/sdk/structured-output-stdio') }
      : { type: transport }
    const port = await this.listen()
    if (this.closed) throw new HarnessSdkError('CLIENT_DISPOSED')
    const path = `/mcp/${randomBytes(24).toString('hex')}`
    const credential = randomBytes(32).toString('hex')
    const lease: Lease = { credential, handler, active: new Set(), disposed: false, requests: 0 }
    this.leases.set(path, lease)
    const url = `http://127.0.0.1:${port}${path}`
    return {
      config: bridgeConfig({ transport: resolvedTransport, url, credential }),
      dispose: () => this.releaseLease(path, lease),
    }
  }

  /**
   * Close admission, settle active protocol closes, then stop the listener and its connections.
   * withStructuredOutput's dispose port awaits this after attempting session disposal and classifies
   * shutdown rejection with other resource failures. Individual protocol close rejections are ignored
   * here. Listener shutdown errors reject. Repeated calls return without awaiting an earlier disposal.
   */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const lease of this.leases.values()) {
      lease.disposed = true
      await closeLeaseServers(lease)
    }
    this.leases.clear()
    if (this.starting) await this.starting.catch(() => {})
    const listener = this.listener
    if (listener?.listening) await stopListener(listener)
  }

  private listener?: HttpServer
  private starting?: Promise<number>
  private closed = false
  private readonly leases = new Map<string, Lease>()

  /**
   * OutputBridgeManager.create awaits this port before allocating a lease. Lazily start one
   * loopback HTTP listener and cache its port promise, including startup or disposal-race rejection.
   */
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
        if (!address || typeof address === 'string') {
          reject(new HarnessSdkError('STRUCTURED_OUTPUT_BRIDGE_FAILED'))
          return
        }
        if (this.closed) {
          listener.close()
          reject(new HarnessSdkError('CLIENT_DISPOSED'))
          return
        }
        resolve(address.port)
      })
    })
  }

  /**
   * The listener's request callback starts this operation without awaiting it. Admit, parse and dispatch
   * one request. Contain failures with a 500 status when headers permit, then release its concurrency permit.
   * Accounting ends when dispatch/error handling settles, independently of response-close cleanup.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse, listener: HttpServer): Promise<void> {
    let countedLease: Lease | undefined
    // Keep accounting outside dispatch so an error response precedes permit release.
    return (async () => {
      const lease = this.admitRequest(req, res, listener)
      if (!lease) return
      lease.requests++
      countedLease = lease
      const body = await this.readRequestBody(req, res)
      if (body === undefined) return
      if (lease.disposed) { res.writeHead(404).end(); return }
      await this.dispatchRequest(req, res, body, lease)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }).finally(() => {
      if (countedLease) countedLease.requests--
    })
  }

  /**
   * Apply endpoint, credential, host/origin, POST and 32-request concurrency checks in that order.
   * Write the rejection response and return no lease on failure. handleRequest reserves the permit
   * synchronously after success. An absent or empty Origin is allowed for native clients.
   */
  private admitRequest(req: IncomingMessage, res: ServerResponse, listener: HttpServer): Lease | undefined {
    const lease = this.leases.get(req.url ?? '')
    if (this.closed || !lease || lease.disposed) { res.writeHead(404).end(); return }
    if (req.headers.authorization !== `Bearer ${lease.credential}`) { res.writeHead(401).end(); return }
    const address = listener.address()
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : ''
    const origin = req.headers.origin
    if (req.headers.host !== expectedHost || (origin && origin !== `http://${expectedHost}`)) { res.writeHead(403).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (lease.requests >= 32) { res.writeHead(429).end(); return }
    return lease
  }

  /**
   * Read one bounded JSON body for handleRequest. Return undefined after a 413 size rejection or a
   * 400 parse rejection. Stream failures reject into handleRequest's HTTP error path. Parsing waits
   * for the body to end, while an oversized body is rejected immediately.
   */
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

  /**
   * Connect a fresh stateless MCP server/transport and await its HTTP dispatch for handleRequest.
   * Setup or dispatch rejections reach handleRequest's HTTP error path. Response close removes
   * the server and attempts best-effort close. Lease and manager disposal also close tracked servers.
   */
  private async dispatchRequest(req: IncomingMessage, res: ServerResponse, body: unknown, lease: Lease): Promise<void> {
    const server = createToolServer(lease)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    lease.active.add(server)
    res.once('close', () => {
      lease.active.delete(server)
      void server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /**
   * The returned lease callback delegates here when OutputSession.release or prepareBridge awaits
   * disposal. Revoke this endpoint before awaiting closes, clear its server registry after settlement
   * and reject RESOURCE_RELEASE_FAILED on any close rejection. Revocation is permanent even on failure.
   */
  private async releaseLease(path: string, lease: Lease): Promise<void> {
    if (lease.disposed) return
    lease.disposed = true
    this.leases.delete(path)
    const results = await closeLeaseServers(lease)
    lease.active.clear()
    if (results.some(result => result.status === 'rejected')) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED')
  }
}

/** OutputSession.prepareBridge supplies a serialized submitValue callback whose result becomes the tool response. */
type Handler = (args: unknown) => Promise<CallToolResult>

/** Mutable state for one endpoint shared by its admitted requests and disposal paths. */
interface Lease {
  credential: string
  handler: Handler
  /** Servers tracked from request dispatch until response close or explicit lease cleanup. */
  active: Set<Server>
  disposed: boolean
  /** Admitted handlers whose dispatch or error response is still in progress. */
  requests: number
}

/** Stdio entry resolution must succeed before create starts the shared listener. */
type ResolvedTransport = { type: 'http' } | { type: 'stdio'; proxy: string }

/** Build native config for create using the resolved transport, with the bearer credential in headers or subprocess env. */
function bridgeConfig({ transport, url, credential }: { transport: ResolvedTransport; url: string; credential: string }): McpServer {
  if (transport.type === 'http') {
    return { type: 'http', name: OUTPUT_SERVER_NAME, url, headers: { Authorization: `Bearer ${credential}` } }
  }
  return {
    type: 'stdio',
    name: OUTPUT_SERVER_NAME,
    command: process.execPath,
    args: [transport.proxy],
    env: { ANUREO_OUTPUT_BRIDGE_URL: url, ANUREO_OUTPUT_BRIDGE_AUTH: credential },
  }
}

/**
 * Register MCP tool handlers for dispatchRequest before it connects the server. The SDK invokes
 * them to list the shared tool or call the lease handler after checking revocation and tool name.
 * The SDK handles handler rejections as protocol failures. dispatchRequest owns connection and tracking.
 */
function createToolServer(lease: Lease): Server {
  const server = new Server({ name: OUTPUT_SERVER_NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [OUTPUT_TOOL] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (lease.disposed) return toolError('STRUCTURED_OUTPUT_EXPIRED')
    if (request.params.name !== OUTPUT_TOOL.name) return toolError('UNKNOWN_TOOL')
    return lease.handler(request.params.arguments)
  })
  return server
}

/**
 * Snapshot and close every currently active server for releaseLease or manager disposal, settling all
 * rejections so each caller can apply its own failure and registry policy. Callers revoke admission first.
 */
function closeLeaseServers(lease: Lease): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled([...lease.active].map(server => server.close()))
}

/**
 * Stop a listening server after OutputBridgeManager.dispose settles protocol cleanup and startup.
 * Force remaining connections closed so idle HTTP peers cannot hold disposal open. Resolve after
 * listener closure, ignoring an already-stopped race, and reject other listener shutdown errors.
 */
function stopListener(listener: HttpServer): Promise<void> {
  const stopped = new Promise<void>((resolve, reject) => {
    listener.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    })
  })
  listener.closeAllConnections()
  return stopped
}
