/**
 * Internal package entry resolved by OutputBridgeManager.create and launched by the native MCP
 * client over stdio. ANUREO_OUTPUT_BRIDGE_URL and ANUREO_OUTPUT_BRIDGE_AUTH identify the private
 * session lease. Forward tool listings and calls over HTTP. Begin shutdown on stdin end, SIGTERM,
 * SIGINT, parent loss or failed upstream ping. Startup failures write a safe code to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const parent = process.ppid
const upstream = new Client({ name: 'anureo-output-proxy', version: '1.0.0' })
const downstream = new Server({ name: 'anureo_output', version: '1.0.0' }, { capabilities: { tools: {} } })
let closing = false
let ready = false
let checking = false

/**
 * Stop heartbeat, settle both MCP peer closes (ignoring their rejections), then exit with code.
 * Stdin-end and signal listeners start cleanup. checkLiveness and startup failure await it.
 * The first call selects the exit code (default 0). Later calls return without waiting.
 */
async function close(code = 0) {
  if (closing) return
  closing = true
  clearInterval(heartbeat)
  await Promise.allSettled([downstream.close(), upstream.close()])
  process.exit(code)
}

/**
 * The 2-second heartbeat invokes this without awaiting. Check owner identity even during startup,
 * then ping only after upstream connects, allowing 3 seconds for a reply. Owner loss requests
 * exit with 0 and ping failure requests exit with 1. Skip ticks while a ping is pending.
 */
async function checkLiveness() {
  if (closing || checking) return
  if (process.ppid !== parent || process.ppid === 1) {
    await close()
    return
  }
  if (!ready) return
  checking = true
  try { await upstream.ping({ timeout: 3000 }) } catch { await close(1) }
  finally { checking = false }
}

/**
 * Connect upstream with the required lease URL/credential before attaching downstream stdio.
 * Upstream initialization uses a 10-second request timeout. Connection enables heartbeat pings. The SDK
 * invokes the registered downstream handlers, which return upstream tool lists/results or propagate rejection
 * to protocol handling. Configuration/connection failures reject to the module entry for safe stderr
 * reporting and close(1).
 */
async function connectProxy() {
  const url = process.env.ANUREO_OUTPUT_BRIDGE_URL
  const credential = process.env.ANUREO_OUTPUT_BRIDGE_AUTH
  if (!url || !credential) throw new Error('configuration')
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${credential}` } },
  })
  await upstream.connect(transport, { timeout: 10000 })
  ready = true
  downstream.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools())
  downstream.setRequestHandler(CallToolRequestSchema, request => upstream.callTool(request.params))
  await downstream.connect(new StdioServerTransport())
}

// Register shutdown before connecting so startup is covered by the owner and signal checks.
const heartbeat = setInterval(() => { void checkLiveness() }, 2000)
heartbeat.unref()
process.stdin.once('end', () => { void close() })
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })

try {
  await connectProxy()
} catch {
  process.stderr.write('STRUCTURED_OUTPUT_BRIDGE_FAILED\n')
  await close(1)
}
