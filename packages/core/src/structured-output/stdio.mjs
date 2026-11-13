/**
 * Internal executable resolved by OutputBridgeManager.create for native clients to launch over stdio.
 * ANUREO_OUTPUT_BRIDGE_URL and ANUREO_OUTPUT_BRIDGE_AUTH identify its private session lease. Forward
 * tools to that bridge and exit when stdin ends, a termination signal arrives, the owner disappears
 * or the bridge fails a ping. Startup failures report only a safe code on stderr and exit with 1.
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
/**
 * Stop heartbeat, settle both MCP peer closes (ignoring their rejections), then exit with code.
 * Stdin-end and SIGTERM/SIGINT listeners start cleanup; checkLiveness and startup failure await it.
 * Only the first call performs cleanup; later calls return without waiting for that exit.
 */
async function close(code = 0) {
  if (closing) return
  closing = true
  clearInterval(heartbeat)
  await Promise.allSettled([downstream.close(), upstream.close()])
  process.exit(code)
}
let checking = false
/**
 * The 2-second heartbeat invokes this without awaiting. Check owner identity even during startup,
 * then ping only after upstream connects, allowing 3 seconds for a reply. Owner loss exits with 0;
 * ping failure exits with 1. The checking flag prevents overlapping pings during slow replies.
 */
async function checkLiveness() {
  if (closing || checking) return
  if (process.ppid !== parent || process.ppid === 1) { await close(); return }
  if (!ready) return
  checking = true
  try { await upstream.ping({ timeout: 3000 }) } catch { await close(1) }
  finally { checking = false }
}
/** Periodically detect a dead owner or bridge; unref keeps monitoring from holding an otherwise finished process open. */
const heartbeat = setInterval(() => { void checkLiveness() }, 2000)
heartbeat.unref()
process.stdin.once('end', () => { void close() })
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
/**
 * Connect upstream with the required lease URL/credential before attaching downstream stdio.
 * Upstream initialization uses a 10-second request timeout; connection enables heartbeat pings. The SDK
 * invokes the registered downstream handlers, which return upstream tool lists/results or propagate rejection
 * to protocol handling. Configuration/connection failures reject to the module entry for safe stderr
 * reporting and close(1); this function does not own process exit.
 */
async function connectProxy() {
  const url = process.env.ANUREO_OUTPUT_BRIDGE_URL
  const credential = process.env.ANUREO_OUTPUT_BRIDGE_AUTH
  if (!url || !credential) throw new Error('configuration')
  await upstream.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }), { timeout: 10000 })
  ready = true
  downstream.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools())
  downstream.setRequestHandler(CallToolRequestSchema, request => upstream.callTool(request.params))
  await downstream.connect(new StdioServerTransport())
}
try {
  await connectProxy()
} catch {
  process.stderr.write('STRUCTURED_OUTPUT_BRIDGE_FAILED\n')
  await close(1)
}
