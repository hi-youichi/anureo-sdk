import { createClient } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'

// Runs a scripted backend without an account or model service.
const client = await createClient({
  adapter: createScriptedAdapter(),
  identity: { adapterId: 'scripted', runtimeConfigId: 'local' },
})
try {
  const session = await client.sessions.create({ cwd: process.cwd() })
  const turn = await session.submit({ input: 'Hello from Anureo SDK' })
  console.log((await turn.result()).text)
  await session.close()
} finally {
  await client.dispose()
}
