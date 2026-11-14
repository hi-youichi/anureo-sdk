import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createClaudeAdapter } from '@anureo/adapter-claude'

// Uses installed, authenticated CLIs and makes real model requests.
// Run: bun run example:schema [all|codex|claude]
// "all" runs Codex then Claude; a failure stops the sequence after client cleanup.
const selected = process.argv[2] ?? 'all'
if (!['all', 'codex', 'claude'].includes(selected) || process.argv.length > 3) {
  throw new Error('Usage: bun run example:schema [all|codex|claude]')
}

const outputSchema = {
  type: 'object',
  properties: { sum: { type: 'integer' } },
  required: ['sum'],
  additionalProperties: false,
}
const cwd = process.cwd()
const timeoutMs = 180_000

for (const backend of selected === 'all' ? ['codex', 'claude'] : [selected]) {
  const { adapter, ...sessionOptions } = backend === 'codex'
    ? {
        adapter: createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd }),
        model: process.env.CODEX_MODEL,
        permissionMode: 'read-only',
      }
    : {
        adapter: createClaudeAdapter({ command: process.env.CLAUDE_BIN ?? 'claude', defaultHome: true, env: process.env }),
        model: process.env.CLAUDE_MODEL,
        permissionMode: 'dontAsk',
      }
  const client = await createClient({ adapter, identity: { adapterId: backend, runtimeConfigId: 'local' } })
  try {
    const session = await client.sessions.create({
      cwd,
      ...sessionOptions,
      instructions: 'Answer directly without reading files or running commands.',
    })
    const turn = await session.submit({ input: 'Calculate 17 + 25.', outputSchema }, { timeoutMs })
    // Submission returns on turn association. The SDK validates final output before
    // publishing a successful result.
    const result = await turn.result({ timeoutMs })
    if (result.status === 'failed') throw new Error(result.error.message)
    if (result.status !== 'completed') throw new Error(`Turn ${result.status}`)

    // The completed result carries validated JSON text such as {"sum":42}.
    console.log(backend, JSON.parse(result.text))
  } finally {
    // Release this backend's session and adapter before advancing or propagating failure.
    await client.dispose()
  }
}
