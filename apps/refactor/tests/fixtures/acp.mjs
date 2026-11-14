// Simulates an ACP stdio agent that submits validated work through the SDK's MCP bridge.
import { createInterface } from 'node:readline'
import { submitOutput } from '../../../../packages/adapter/acp/tests/fixtures/mcp-output-client.mjs'
import { answer } from './answer.mjs'

const servers = new Map()
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  let result
  switch (method) {
    case 'initialize':
      result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} }, mcpCapabilities: { http: true } } }
      break
    case 'session/new': {
      const sessionId = String(id)
      servers.set(sessionId, params.mcpServers)
      result = { sessionId }
      break
    }
    case 'session/prompt': {
      const server = servers.get(params.sessionId).find(server => server.name === 'anureo_output')
      // The bridge must accept the result before the prompt reply ends the turn.
      await submitOutput(server, params.prompt, answer)
      result = { stopReason: 'end_turn' }
      break
    }
    case 'session/close':
      servers.delete(params.sessionId)
      result = {}
      break
    default:
      send({ id, error: { code: -32601, message: 'Unsupported fixture method' } })
      continue
  }
  send({ id, result })
}
