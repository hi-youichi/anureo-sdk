/**
 * Verify typed native output with authenticated CLIs and real model requests.
 * Run: bun run example:workflow-schema [all|codex|claude]. The default checks Codex
 * then Claude, stopping on failure and disposing each opened client.
 */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createClaudeAdapter } from '@anureo/adapter-claude'
import { agent } from '@anureo/workflow'

const selected = process.argv[2] ?? 'all'
if (!['all', 'codex', 'claude'].includes(selected) || process.argv.length > 3) {
  throw new Error('Usage: bun run example:workflow-schema [all|codex|claude]')
}
const schema = z.strictObject({ sum: z.number().int() })
const cwd = process.cwd()
for (const backend of selected === 'all' ? ['codex', 'claude'] : [selected]) {
  const adapter = backend === 'codex'
    ? createCodexAdapter({ command: process.env.CODEX_BIN ?? 'codex', cwd })
    : createClaudeAdapter({ command: process.env.CLAUDE_BIN ?? 'claude', defaultHome: true, env: process.env })
  const client = await createClient({ adapter, identity: { adapterId: backend, runtimeConfigId: 'workflow-schema' } })
  try {
    const value = await agent('Calculate 17 + 25.', {
      client, cwd, schema,
      model: backend === 'codex' ? process.env.CODEX_MODEL : process.env.CLAUDE_MODEL,
      instructions: 'Answer directly without reading files or running commands.',
    })
    assert(value !== null, `${backend} did not produce a result`)
    assert.equal(value.sum, 42)
    assert.equal(schema.safeParse(value).success, true)
    console.log(JSON.stringify({ backend, value, status: 'passed' }))
  } finally {
    await client.dispose()
  }
}
