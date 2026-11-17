// CLI integration peer: negotiates instructions and drives the real Swarm MCP endpoint.
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const sessions = new Map()
let next = 0
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
async function handle(frame) {
  const p = frame.params ?? {}
  const respond = result => send({ id: frame.id, result })
  if (frame.method === 'initialize') return respond({ protocolVersion: 1, agentInfo: { name: 'swarm-cli-fixture', version: '1' },
    agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } }, _meta: { ahp: { version: 1, instructions: true } } })
  if (frame.method === 'session/new') {
    const sessionId = 'fixture-' + ++next
    sessions.set(sessionId, p.mcpServers ?? [])
    return respond({ sessionId })
  }
  if (frame.method === 'session/close') return respond({})
  if (frame.method === 'session/prompt') {
    const input = p.prompt.filter(b => b.type === 'text').map(b => b.text).join('\n')
    let text = 'Hello ' + input
    const server = sessions.get(p.sessionId)?.find(s => s.name === 'anureo-swarm')
    const mention = input.match(/Delegate this request to fixed bee ([a-z][a-z0-9-]*)(?: with profileScope=(user|project))? before answering\.\n([\s\S]+)/)
    if (server && mention) {
      const headers = Array.isArray(server.headers) ? Object.fromEntries(server.headers.map(h => [h.name, h.value])) : server.headers
      const client = new Client({ name: 'cli-main-fixture', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }))
      try {
        async function call(name, args) {
          const result = await client.callTool({ name, arguments: args })
          const text = result.content.find(b => b.type === 'text')?.text
          if (result.isError) throw new Error(text)
          return JSON.parse(text)
        }
        const bee = await call('bee_create', { profileId: mention[1], ...(mention[2] ? { profileScope: mention[2] } : {}) })
        const task = await call('bee_delegate', { beeId: bee.beeId, task: mention[3], context: 'CLI test', constraints: 'Read only', expectedOutput: 'Evidence' })
        const report = await call('bee_wait', { taskId: task.taskId })
        if (report.state !== 'completed') throw new Error('Member did not complete')
        await call('bee_assess', { taskId: task.taskId, verdict: 'accepted', reason: 'Inspected member evidence', evidence: [report.text] })
        text = 'Reviewed member evidence'
      } finally { await client.close() }
    }
    send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    return respond({ stopReason: 'end_turn' })
  }
  if ('id' in frame) send({ id: frame.id, error: { code: -32601, message: 'Method not found' } })
}
createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim()) void handle(JSON.parse(line)).catch(error => { process.stderr.write(String(error)); process.exit(2) })
}).on('close', () => process.exit(0))
