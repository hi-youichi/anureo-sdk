// Proxies MCP stdio to a session bridge and watches its owner; must not validate or retain task results.
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
/** Idempotently stop heartbeat, settle both MCP peers and exit with the supplied code; lifecycle signals and upstream failure share this cleanup path. */
async function close(code = 0) {
  if (closing) return
  closing = true
  clearInterval(heartbeat)
  await Promise.allSettled([downstream.close(), upstream.close()])
  process.exit(code)
}
let checking = false
/** Check owner identity and upstream reachability once; the flag prevents slow pings from overlapping and confusing cleanup. */
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
/** Connect upstream with the lease credential, then expose its tool contract over stdio; caller owns startup failure reporting and process exit. */
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
