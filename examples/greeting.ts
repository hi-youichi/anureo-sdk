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
  const session = await client.sessions.create({ cwd: process.cwd() })

  // Subscribe before submitting: session events are live and are not replayed.
  const eventConsumptionTask = streamGreeting(session)
  // Observe rejection while waiting for submission and the result. Awaiting the original
  // task afterward still propagates stream failures when those waits succeed.
  void eventConsumptionTask.catch(() => {})

  const turn = await session.submit({ input: 'こんにちは！用一句话打个招呼。' })
  await turn.result()
  await eventConsumptionTask
  await session.close()
} finally {
  // Disposal also releases the session if submission, observation or close rejects.
  await client.dispose()
}

/**
 * Print live text for the greeting. Subscribe before the example submits its single
 * turn, and use completed agent-message text as a fallback until the first nonempty text
 * delta. Resolve at the first terminal event for a completed turn. Reject failed or
 * interrupted outcomes, read failures, or premature stream end. The example awaits
 * this after Turn.result(), relying on the stream to check the terminal status. The
 * loop releases its subscription, and the example still owns session and client cleanup.
 */
async function streamGreeting(session: Session): Promise<void> {
  let hasWrittenDelta = false
  for await (const event of session.events()) {
    switch (event.type) {
      case 'item/delta': {
        const delta = event.payload
        if (delta.kind === 'text' && delta.text) {
          process.stdout.write(delta.text)
          hasWrittenDelta = true
        }
        break
      }
      case 'item/completed': {
        const { item } = event.payload
        if (item.type !== 'agentMessage') break
        if (!hasWrittenDelta) process.stdout.write(item.text ?? '')
        process.stdout.write('\n')
        break
      }
      case 'turn/completed': {
        const { status } = event.payload
        if (status !== 'completed') throw new Error(`Turn ended: ${status}`)
        return
      }
    }
  }
  throw new Error('Event stream ended without a terminal event')
}
