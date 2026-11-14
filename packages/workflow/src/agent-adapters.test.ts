import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { createClient, type Client, type StructuredOutputToolDefinition } from '@anureo/sdk'
import { createAcpAdapter } from '@anureo/adapter-acp'
import { createClaudeAdapter } from '@anureo/adapter-claude'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createPiAdapter } from '@anureo/adapter-pi'
import { fakeFactory } from '../../adapter/pi/tests/fake-host'
import { agent, parallel } from './index'

const fakeClaude = fileURLToPath(new URL('../../adapter/claude/tests/fixtures/fake-claude.mjs', import.meta.url))

test('Zod agent crosses the official Claude SDK and a real JSONL process in fresh native sessions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-workflow-native-'))
  const log = join(cwd, 'initialize.jsonl')
  const client = await createClient({ adapter: createClaudeAdapter({
    command: fakeClaude,
    executableRuntime: 'node', stateDir: join(cwd, 'state'), env: { FAKE_SCHEMA_PROBE: '1', FAKE_SCHEMA_LOG: log },
  }), identity: { adapterId: 'claude', runtimeConfigId: 'workflow' } })
  try {
    const schema = z.object({ answer: z.literal(42) })
    expect(await parallel([
      () => agent('first', { client, cwd, schema }),
      () => agent('second', { client, cwd, schema }),
    ])).toEqual([{ answer: 42 }, { answer: 42 }])
    const records = await readNativeLog(log)
    const structured = records.filter(record => record.schema)
    expect(structured).toHaveLength(2)
    expect(new Set(structured.map(record => record.sessionId)).size).toBe(2)
    expect(structured[0].schema).toMatchObject({ type: 'object', properties: { answer: { const: 42 } } })
  } finally {
    await releaseNativeFixture(client, cwd)
  }
}, 15_000)

test('Claude nominal success without native structured_output never falls back to prose', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-workflow-missing-'))
  const client = await createClient({ adapter: createClaudeAdapter({
    command: fakeClaude, executableRuntime: 'node', stateDir: cwd,
  }), identity: { adapterId: 'claude', runtimeConfigId: 'missing' } })
  try {
    await expect(agent('missing', { client, cwd, schema: z.object({ answer: z.number() }) })).rejects.toMatchObject({ code: 'CLAUDE_STRUCTURED_OUTPUT_MISSING' })
  } finally {
    await releaseNativeFixture(client, cwd)
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
    const starts = (await readNativeLog(log)).filter(frame => frame.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0].params.outputSchema).toMatchObject({ type: 'object', properties: { answer: { const: 42 } } })
  } finally {
    await releaseNativeFixture(client, cwd)
  }
}, 15_000)

test('workflow Zod output uses MCP and retains local refinement failures', async () => {
  const adapter = createAcpAdapter({ command: process.execPath, args: [fileURLToPath(new URL('../../adapter/acp/tests/fixtures/fake-acp.mjs', import.meta.url)), '--scenario', 'mcp-output'] })
  const client = await createClient({ adapter, identity: { adapterId: 'acp', runtimeConfigId: 'workflow-mcp' } })
  try {
    const options = { client, cwd: process.cwd() }
    const schema = z.object({ sum: z.number().int() })
    const value = await agent('17 + 25', { ...options, schema })
    expect(value).toEqual({ sum: 42 })
    await expect(agent('17 + 25', { ...options, schema: schema.refine(value => value.sum < 0) }))
      .rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false })
  } finally { await client.dispose() }
})

test('workflow schema uses direct Pi tools and retains Zod refinement validation', async () => {
  const fake = fakeFactory(host => {
    let output: StructuredOutputToolDefinition | undefined
    Object.assign(host, {
      /** Store the SDK's tool for the host script. The Pi adapter forwards an omitted tool to clear it. */
      async setOutputTool(tool?: StructuredOutputToolDefinition) { output = tool },
    })
    host.script = async host => {
      if (!output) throw new Error('Output tool must be registered before scripted execution')
      await output.execute({ sum: 42 })
      await host.assistant('submitted')
    }
  })
  const client = await createClient({ adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }), identity: { adapterId: 'pi', runtimeConfigId: 'workflow-direct-tool' } })
  try {
    const options = { client, cwd: process.cwd() }
    const schema = z.object({ sum: z.number().int() })
    expect(await agent('17 + 25', { ...options, schema })).toEqual({ sum: 42 })
    await expect(agent('17 + 25', { ...options, schema: schema.refine(value => value.sum < 0) }))
      .rejects.toMatchObject({ code: 'AGENT_STRUCTURED_OUTPUT_INVALID', outcomeUnknown: false })
    expect(fake.opens.every(open => !Object.hasOwn(open, 'mcpServers'))).toBe(true)
  } finally { await client.dispose() }
})

/** Read the fixture's JSONL records in write order. Missing logs or malformed records fail the test. */
async function readNativeLog(path: string) {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

/** Remove fixture files after client disposal succeeds. Either failure rejects the test. */
async function releaseNativeFixture(client: Client, cwd: string): Promise<void> {
  await client.dispose()
  await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
