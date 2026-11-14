import { createClient } from '@anureo/sdk'
import { createHermesAdapter } from '@anureo/adapter-hermes'

// Run one arithmetic turn through a configured Hermes gateway and print its terminal text.
// HERMES_BIN selects the CLI; HERMES_PROFILE and HERMES_MODEL override the profile and model.
const client = await createClient({
  adapter: createHermesAdapter({
    command: process.env.HERMES_BIN ?? 'hermes',
    timeoutMs: 90_000,
    ...(process.env.HERMES_PROFILE ? { profile: process.env.HERMES_PROFILE } : {}),
  }),
  identity: { adapterId: 'hermes', runtimeConfigId: process.env.HERMES_PROFILE ?? 'default-profile' },
}, { timeoutMs: 120_000 })
try {
  const session = await client.sessions.create({
    cwd: process.cwd(),
    ...(process.env.HERMES_MODEL ? { model: process.env.HERMES_MODEL } : {}),
  })
  const turn = await session.submit({ input: 'What is 17 + 25? Answer in one sentence.' })
  const result = await turn.result({ timeoutMs: 180_000 })
  if (result.status === 'failed') throw new Error(result.error.message)
  if (result.status !== 'completed') throw new Error(`Turn ${result.status}`)
  console.log(result.text)
  await session.close()
} finally {
  // Release the SDK-owned session and adapter even when the result wait or native close fails.
  await client.dispose()
}
