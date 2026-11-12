#!/usr/bin/env bun
// Emulates the Codex app-server wire lifecycle for CLI subprocess tests; it must not run models or read credentials.
import readline from 'node:readline'
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.164.0\n'); process.exit(0) }
/** Serialize one fixture reply/event to stdout, returning the stream write result.
 * The protocol loop owns ordering; serialization or synchronous stream errors escape to fail the test. */
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const threadId = 'refactor-fixture'
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  /** Send a result for this request ID, returning send's write result or propagating its errors.
   * The protocol loop must acknowledge turn/start before publishing that turn's lifecycle events. */
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
      // The adapter needs the turn acknowledgement before it can associate subsequent events.
      // Final text must arrive before completion so structured-output parsing sees a full response.
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
