import { createClient, type Session } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'

// Real-backend greeting example: submit one hello prompt to the local Codex CLI
// and print the assistant reply as it streams in.
// Requires the Codex CLI on PATH (override with CODEX_BIN) and an authenticated OpenAI account.
const client = await createClient({
  identity: {
    adapterId: 'codex',
    runtimeConfigId: 'local',
  },
  adapter: createCodexAdapter({
    command: process.env.CODEX_BIN ?? 'codex',
    timeoutMs: 60_000,
  }),
})
try {
  const session = await client.sessions.create({cwd:process.cwd()})

  // Subscribe before submitting: session events are live and are not replayed.
  const consume = streamGreeting(session)
  // Handle early rejection now; awaiting the original consume below propagates it
  // only if turn.result() succeeds. If turn.result() rejects, that await is skipped.
  void consume.catch(() => {})

  const turn = await session.submit({input:'こんにちは！用一句话打个招呼。'})
  await turn.result()
  await consume
  await session.close()
} finally {
  // Disposal also releases the session if submission, observation or close rejects.
  await client.dispose()
}

/**
 * Print live text for the greeting run above, using completed message text only until
 * a text delta has been printed. Call before submit to subscribe synchronously; resolve
 * at turn completion and reject failed/interrupted turns, read failures or premature
 * stream end. The loop releases its subscription; the caller still owns client cleanup.
 */
async function streamGreeting(session: Session): Promise<void> {
  let streamed = false
  for await (const event of session.events()) {
    if (event.type === 'item/delta' && event.payload.kind === 'text' && event.payload.text) {
      process.stdout.write(event.payload.text)
      streamed = true
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
}
