import { createHarnessRuntime } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'

// Runs a scripted backend without an account or model service.
const runtime = createHarnessRuntime(createScriptedAdapter())
try {
  await runtime.initialize({ protocolVersions: [1], clientInfo: { name: 'anureo-example', version: '0.2.0' } })
  const session = await runtime.openSession({
    requestId: 'open', mode: 'new', cwd: process.cwd(),
    binding: { sessionId: 'example', adapterId: 'scripted', runtimeConfigId: 'local' },
  })
  const consume = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'item/completed' && event.payload.item.type === 'agentMessage') {
        console.log(event.payload.item.text)
      }
      if (event.type === 'turn/completed') {
        if (event.payload.status !== 'completed') throw new Error(`Turn ended: ${event.payload.status}`)
        return
      }
    }
    throw new Error('Event stream ended without a terminal event')
  })()
  void consume.catch(() => {})
  await session.startTurn({
    requestId: 'start', sessionId: session.binding.sessionId, turnId: 'turn-1',
    input: [{ type: 'text', text: 'Hello from Anureo SDK' }],
  })
  await consume
  await session.close()
} finally {
  await runtime.dispose()
}
