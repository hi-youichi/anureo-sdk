import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * fake-acp's output scenarios await one scripted MCP result submission before replying to session/prompt.
 * Reject protocol/tool failures and always await owned stdio-child cleanup; HTTP has no owned child.
 */
export async function submitOutput(server, prompt) {
  const connection = server.type === 'http' ? { rpc: createHttpRpc(server) } : createStdioConnection(server)
  const { rpc } = connection
  try {
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'scripted-acp', version: '1' } })
    if ((await rpc('tools/list', {})).tools[0]?.name !== 'submit_result') throw new Error('missing tool')
    const text = prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const outputId = text.match(/outputId: (anureo_output_[a-f0-9]{48})/)?.[1]
    const schema = JSON.parse(text.split('JSON Schema: ').at(-1))
    const value = schema.properties?.sum ? { sum: 42 } : { label: 'second' }
    if ((await rpc('tools/call', { name: 'submit_result', arguments: { outputId, value } })).isError) throw new Error('output rejected')
  } finally {
    if (connection.child) await closeChild(connection.child)
  }
}

/** Build sequential HTTP JSON-RPC requests using the bridge's supplied headers; reject HTTP/RPC errors. */
function createHttpRpc(server) {
  let sequence = 0
  return async (method, params) => {
    const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) })
    const message = await response.json()
    if (!response.ok || message.error) throw new Error('MCP request failed')
    return message.result
  }
}

/** Spawn the bridge and correlate replies with five-second waits; submitOutput owns closing the child. */
function createStdioConnection(server) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) }, stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map()
  let sequence = 0
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line), wait = pending.get(message.id)
    if (!wait) return
    pending.delete(message.id); clearTimeout(wait.timer)
    message.error ? wait.reject(new Error('MCP error')) : wait.resolve(message.result)
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')) }, 5000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { child, rpc }
}

/** End stdio, force termination after 1.5 seconds if necessary, and await the child's exit. */
async function closeChild(child) {
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
  await exited; clearTimeout(timer)
}
