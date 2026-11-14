// Simulates a native-lifecycle AHP peer that supports only text output.
import { createInterface } from 'node:readline'
import { answer } from './answer.mjs'

const sessions = new Map()
const capabilities = { input: { delivery: ['native'] }, turn: { inputModalities: ['text'] } }
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  let result
  switch (method) {
    case 'initialize':
      result = { protocolVersion: 1, protocolContract: 'native-lifecycle', runtime: { name: 'fixture', version: '1', adapter: 'ahp' }, capabilities }
      break
    case 'session/open': {
      const binding = params.binding
      sessions.set(binding.sessionId, { seq: 0 })
      result = { binding, capabilities, streamId: 'fixture', state: { binding, capabilities, status: 'ready', activeTurnIds: [], config: {}, capabilityRevision: 1 } }
      break
    }
    case 'input/submit': {
      const { sessionId, submissionId, input, outputSchema } = params
      const text = input.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (outputSchema || !text.includes('matches this JSON Schema')) throw new Error('Expected JSON text fallback')
      const session = sessions.get(sessionId)
      const turnId = `turn-${id}`
      /** Publish one notification in this session's observation sequence. Only item events carry
       * the optional envelope turn ID here. Serialization and write failures fail the fixture. */
      const event = (type, payload, itemTurnId) => send({ method: type, params: {
        sessionId, streamId: 'fixture', seq: ++session.seq, timestamp: new Date().toISOString(), turnId: itemTurnId, type, payload,
      } })
      event('turn/started', { turnId })
      event('submission/bound', { submissionId, turnId })
      // Put fallback JSON in final text before completion so the SDK can validate the full result.
      event('item/completed', { item: { id: 'result', type: 'agentMessage', phase: 'final', text: JSON.stringify(answer(text)) } }, turnId)
      event('turn/completed', { turnId, status: 'completed' })
      result = { accepted: true, submissionId, disposition: 'started', turnId }
      break
    }
    case 'session/close':
      sessions.delete(params.sessionId)
      result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' }
      break
    default:
      send({ id, error: { code: -32601, message: 'Unsupported fixture method' } })
      continue
  }
  send({ id, result })
}
