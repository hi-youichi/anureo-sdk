import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createClient } from '@anureo/sdk'
import { createClaudeAdapter } from '@anureo/adapter-claude'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { agent, parallel } from './index'

test('Zod agent crosses the official Claude SDK and a real JSONL process in fresh native sessions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-workflow-native-'))
  const log = join(cwd, 'initialize.jsonl')
  const client = await createClient({ adapter: createClaudeAdapter({
    command: fileURLToPath(new URL('../../adapter/claude/tests/fixtures/fake-claude.mjs', import.meta.url)),
    executableRuntime: 'node', stateDir: join(cwd, 'state'), env: { FAKE_SCHEMA_PROBE: '1', FAKE_SCHEMA_LOG: log },
  }), identity: { adapterId: 'claude', runtimeConfigId: 'workflow' } })
  try {
    const schema = z.object({ answer: z.literal(42) })
    expect(await parallel([
      () => agent('first', { client, cwd, schema }),
      () => agent('second', { client, cwd, schema }),
    ])).toEqual([{ answer: 42 }, { answer: 42 }])
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const structured = records.filter(record => record.schema)
    expect(structured).toHaveLength(2)
    expect(new Set(structured.map(record => record.sessionId)).size).toBe(2)
    expect(structured[0].schema).toMatchObject({ type: 'object', properties: { answer: { const: 42 } } })
  } finally {
    await client.dispose()
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 15_000)

test('Claude nominal success without native structured_output never falls back to prose', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-workflow-missing-'))
  const client = await createClient({ adapter: createClaudeAdapter({
    command: fileURLToPath(new URL('../../adapter/claude/tests/fixtures/fake-claude.mjs', import.meta.url)), executableRuntime: 'node', stateDir: cwd,
  }), identity: { adapterId: 'claude', runtimeConfigId: 'missing' } })
  try {
    await expect(agent('missing', { client, cwd, schema: z.object({ answer: z.number() }) })).rejects.toMatchObject({ code: 'CLAUDE_STRUCTURED_OUTPUT_MISSING' })
  } finally {
    await client.dispose()
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 15_000)

const codexCases = [
  { scenario: 'workflow-schema', expected: { answer: 42 }, description: 'returns a successful structured result' },
  { scenario: 'auth-expired', expected: null, description: 'returns null when authentication expires' },
] as const

for (const { scenario, expected, description } of codexCases) test(`Zod agent crosses Codex native process: ${description}`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-workflow-codex-'))
  const log = join(cwd, 'requests.jsonl')
  const client = await createClient({ adapter: createCodexAdapter({ command: process.execPath,
    args: [fileURLToPath(new URL('../../adapter/codex/tests/fake-app-server.mjs', import.meta.url))],
    version: '0.164.0', env: { FAKE_SCENARIO: scenario, FAKE_LOG_FILE: log },
  }), identity: { adapterId: 'codex', runtimeConfigId: scenario } })
  try {
    const value = await agent('answer', { client, cwd, schema: z.object({ answer: z.literal(42) }) })
    expect(value).toEqual(expected)
    const starts = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(frame => frame.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0].params.outputSchema).toMatchObject({ type: 'object', properties: { answer: { const: 42 } } })
  } finally {
    await client.dispose()
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 15_000)
