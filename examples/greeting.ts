import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

// Real-backend greeting example: submit one hello prompt to the local Codex CLI
// and print the assistant reply as it streams in.
// Requires the Codex CLI on PATH (override with CODEX_BIN) and an authenticated OpenAI account.
const client = await createClient({identity:{adapterId:"codex",runtimeConfigId:"local"},adapter:createCodexAdapter({
  command: process.env.CODEX_BIN ?? 'codex',
  timeoutMs: 60_000,
})})
try {
  const session = await client.sessions.create({cwd:process.cwd()})

  // Consume events before submitting input so the bounded queue never fills up.
  let streamed = false
  const consume = (async () => {
    for await (const event of session.events()) {
      if (event.type === 'item/delta' && event.payload.kind === 'text' && event.payload.text) {
        process.stdout.write(event.payload.text); streamed = true
      }
      if (event.type === 'item/completed' && event.payload.item.type === 'agentMessage') {
        if (!streamed) process.stdout.write(event.payload.item.text ?? '')
        process.stdout.write('\n')
      }
      if (event.type === 'turn/completed') {
        if (event.payload.status !== 'completed') throw new Error(`Turn ended: ${event.payload.status}`)
        return
      }
    }
    throw new Error('Event stream ended without a terminal event')
  })()
  void consume.catch(() => {})

  const turn = await session.submit({input:'こんにちは！用一句话打个招呼。'})
  await turn.result()
  await consume
  await session.close()
} finally {
  await client.dispose()
}
