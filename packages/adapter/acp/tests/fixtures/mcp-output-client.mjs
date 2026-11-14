import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * Submit one scripted result using the session's ACP MCP server config and the SDK contract in the prompt.
 * The refactor app's ACP fixture supplies a synchronous answer callback that receives the joined text blocks.
 * The adapter's fake-acp fixture omits it and uses the schema to select the test value.
 * Both callers await tool submission and stdio cleanup before returning an end-turn response.
 * MCP request failures, missing tools and rejected values reject the prompt handler.
 */
export async function submitOutput(server, prompt, answer) {
  const connection = server.type === 'http' ? { rpc: createHttpRpc(server) } : createStdioConnection(server)
  const { rpc } = connection
  try {
    await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'scripted-acp', version: '1' },
    })
    const { tools } = await rpc('tools/list', {})
    if (tools[0]?.name !== 'submit_result') throw new Error('missing tool')

    const args = outputArguments(prompt, answer)
    const result = await rpc('tools/call', { name: 'submit_result', arguments: args })
    if (result.isError) throw new Error('output rejected')
  } finally {
    if (connection.child) await closeChild(connection.child)
  }
}

/**
 * Build tool arguments from the SDK's trailing prompt contract. Parse the schema before invoking
 * a custom answer so both caller paths require valid schema JSON. Parsing or callback errors
 * prevent the tool call, and the bridge checks the output ID and value.
 */
function outputArguments(prompt, answer) {
  const text = prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const outputId = text.match(/outputId: (anureo_output_[a-f0-9]{48})/)?.[1]
  const schema = JSON.parse(text.split('JSON Schema: ').at(-1))
  if (answer) return { outputId, value: answer(text) }

  const value = schema.properties?.sum ? { sum: 42 } : { label: 'second' }
  return { outputId, value }
}

/** Return a request function that uses the session's supplied HTTP headers and rejects on HTTP, JSON parsing or RPC errors. */
function createHttpRpc(server) {
  let sequence = 0
  return async (method, params) => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...Object.fromEntries(server.headers.map(header => [header.name, header.value])),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
    })
    const message = await response.json()
    if (!response.ok || message.error) throw new Error('MCP request failed')
    return message.result
  }
}

/** Spawn the bridge and return its child and request function. Requests settle by reply ID or reject after five seconds. submitOutput owns child shutdown. */
function createStdioConnection(server) {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...Object.fromEntries(server.env.map(entry => [entry.name, entry.value])) },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const pending = new Map()
  let sequence = 0
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    const request = pending.get(message.id)
    if (!request) return

    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error('MCP error'))
    else request.resolve(message.result)
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('MCP timeout'))
    }, 5000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { child, rpc }
}

/** End the live bridge's stdin to allow graceful exit, then send SIGKILL if the exit is still pending after 1.5 seconds. */
async function closeChild(child) {
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.stdin.end()
  const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
  await exited
  clearTimeout(timer)
}
