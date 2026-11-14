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
  const adapter = backend === 'codex'
    ? createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd })
    : createClaudeAdapter({ command: process.env.CLAUDE_BIN ?? 'claude', defaultHome: true, env: process.env })
  const model = backend === 'codex' ? process.env.CODEX_MODEL : process.env.CLAUDE_MODEL
  const client = await createClient({ adapter, identity: { adapterId: backend, runtimeConfigId: 'local' } })
  try {
    const session = await client.sessions.create({
      cwd, model,
      permissionMode: backend === 'codex' ? 'read-only' : 'dontAsk',
      instructions: 'Answer directly without reading files or running commands.',
    })
    const turn = await session.submit({ input: 'Calculate 17 + 25.', outputSchema }, { timeoutMs })
    const result = await turn.result({ timeoutMs })
    if (result.status === 'failed') throw new Error(result.error.message)
    if (result.status !== 'completed') throw new Error(`Turn ${result.status}`)

    // submit returns a turn handle; result waits for completion and schema validation.
    // A completed result carries JSON text such as {"sum":42}, ready for parsing.
    console.log(backend, JSON.parse(result.text))
  } finally {
    // Each backend's client owns its session and adapter, including on turn/parse failure.
    await client.dispose()
  }
}
