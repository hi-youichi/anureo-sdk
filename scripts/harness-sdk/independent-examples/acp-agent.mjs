// A vanilla ACP v1 fixture. No Anureo package or patched ACP extension is used.
import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = text => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'vanilla-acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
let prompt
const finish = (text, stopReason = 'end_turn') => { if (!prompt) return; if (text) notify(text); send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason } }); prompt = undefined }
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  const result = value => send({ jsonrpc: '2.0', id: message.id, result: value })
  if (!message.method) { if (message.id === 'permission') finish('approval answered'); continue }
  switch (message.method) {
    case 'initialize': result({ protocolVersion: 1, agentInfo: { name: 'vanilla-fixture', version: '1.0.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [] }); break
    case 'session/new': result({ sessionId: 'vanilla-acp-session' }); break
    case 'session/load': result({}); break
    case 'session/prompt': {
      prompt = message
      const text = message.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text === '/approval') send({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: 'vanilla-acp-session', toolCall: { toolCallId: 'tool', title: 'Example permission', kind: 'execute' }, options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }, { optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] } })
      else if (text !== '/wait') finish(text)
      break
    }
    case 'session/cancel': finish('', 'cancelled'); break
    default: if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  }
}
