#!/usr/bin/env bun
// Scripted Codex app-server protocol, no model calls or credentials.
import readline from 'node:readline'
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.164.0\n'); process.exit(0) }
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const threadId = 'refactor-fixture'
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  const reply = result => send({ id: message.id, result })
  switch (message.method) {
    case 'initialize': reply({ userAgent: 'codex/0.164.0' }); break
    case 'account/read': reply({ account: null, requiresOpenaiAuth: false }); break
    case 'model/list': reply({ data: [], nextCursor: null }); break
    case 'thread/start': reply({ thread: { id: threadId } }); break
    case 'turn/start': {
      const prompt = message.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const result = prompt.startsWith('PLAN')
        ? { summary: 'One module', modules: [{ id: 'main', name: 'Main', description: 'Entry point', files: ['main.ts'] }] }
        : { summary: 'Direct and readable implementation; keep it.', changes: [], deferred: [] }
      reply({ turn: { id: 'turn', status: 'inProgress', items: [] } })
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn', status: 'inProgress', items: [] } } })
      send({ method: 'item/completed', params: { threadId, turnId: 'turn', item: {
        id: 'message', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(result),
      } } })
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed', items: [] } } })
      break
    }
    default: reply({})
  }
}
