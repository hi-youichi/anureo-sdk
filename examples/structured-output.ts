import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createClient, HarnessSdkError, type Session } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createClaudeAdapter } from '@anureo/adapter-claude'
import { validateJsonSchema, type HistoryItem, type JsonSchema } from '@anureo/protocol'

// Live example: uses the installed CLIs, their existing login profiles and real
// model requests. Run: bun run example:schema [all|codex|claude]
const selected = process.argv[2] ?? 'all'
if (!['all', 'codex', 'claude'].includes(selected) || process.argv.length > 3) throw new Error('Usage: bun run example:schema [all|codex|claude]')
const timeoutMs = Number(process.env.SCHEMA_TIMEOUT_MS ?? 180_000)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) throw new Error('Invalid SCHEMA_TIMEOUT_MS')
const reportPath = resolve(process.env.SCHEMA_REPORT ?? 'artifacts/schema-live.json')
const exec = promisify(execFile)
type Backend = 'codex' | 'claude'
type Check = { name: string; durationMs: number; status: 'passed' }
type Run = { backend: Backend; version?: string; model?: string; status: 'passed' | 'failed'; checks: Check[]; error?: { stage: string; code: string; outcomeUnknown?: boolean } }

const schemaA = {
  type: 'object', properties: { sum: { type: 'integer' }, token: { type: 'string' } },
  required: ['sum', 'token'], additionalProperties: false,
} satisfies JsonSchema
const schemaB = {
  type: 'object', properties: { product: { type: 'integer' }, rememberedToken: { type: 'string' } },
  required: ['product', 'rememberedToken'], additionalProperties: false,
} satisfies JsonSchema

async function submit(session: Session, input: string, outputSchema?: JsonSchema): Promise<string> {
  const turn = await session.submit({ input, ...(outputSchema !== undefined ? { outputSchema } : {}) }, { timeoutMs })
  const result = await turn.result({ timeoutMs })
  if (result.status === 'failed') throw new HarnessSdkError(result.error.code, result.error.message, result.error.retryable, result.error.outcomeUnknown)
  if (result.status !== 'completed') throw new HarnessSdkError('EXAMPLE_INTERRUPTED')
  assert.notEqual(result.text, '', 'Final text is missing')
  return result.text
}

async function history(session: Session): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []
  let cursor: string | undefined, snapshotToken: string | undefined
  do {
    const page = await session.request('history/read', { requestId: randomUUID(), sessionId: session.id, limit: 200, ...(cursor ? { cursor } : {}), ...(snapshotToken ? { snapshotToken } : {}) })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
    snapshotToken = page.snapshotToken
  } while (cursor)
  return items
}

async function requireClaudeLogin(command: string, env: Record<string, string | undefined>): Promise<void> {
  let stdout: string
  try { stdout = (await exec(command, ['auth', 'status'], { env, timeout: 15_000 })).stdout }
  catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 1 && 'stdout' in cause && typeof cause.stdout === 'string') stdout = cause.stdout
    else throw cause
  }
  const status = JSON.parse(stdout) as { loggedIn?: boolean }
  if (status.loggedIn !== true) throw new HarnessSdkError('AUTH_REQUIRED', 'Run claude auth login before this example')
}

async function run(backend: Backend, cwd: string): Promise<Run> {
  const result: Run = { backend, status: 'failed', checks: [] }
  const command = (backend === 'codex' ? process.env.CODEX_BIN : process.env.CLAUDE_BIN) ?? backend
  const model = backend === 'codex' ? process.env.CODEX_MODEL : process.env.CLAUDE_MODEL
  let stage = 'initialize'
  try {
    result.version = (await exec(command, ['--version'], { timeout: 15_000 })).stdout.trim()
    if (model) result.model = model
    console.log(`[${backend}] ${result.version}; opening a real model session`)
    const adapter = backend === 'codex'
      ? createCodexAdapter({ command, cwd })
      // Deliberately use the CLI login. stateDir stores adapter transcripts and
      // turn mappings only; defaultHome leaves CLAUDE_CONFIG_DIR at its default.
      : createClaudeAdapter({ command, defaultHome: true, stateDir: join(cwd, 'claude-store'), env: process.env })
    if ('env' in adapter) {
      stage = 'authentication'
      await requireClaudeLogin(command, adapter.env)
    }
    stage = 'initialize'
    const client = await createClient({ adapter, identity: { adapterId: backend, runtimeConfigId: 'schema-live' } })
    try {
      const session = await client.sessions.create({ cwd, ...(model ? { model } : {}), permissionMode: backend === 'codex' ? 'read-only' : 'dontAsk', instructions: 'This is a small arithmetic and conversation-memory test. Do not read files, run shell commands, browse, or spawn subagents. Use StructuredOutput only when the output format requires it.' })
      assert.equal(session.capabilities.turn?.outputSchema, true, 'Backend does not offer outputSchema')
      const nativeId = session.binding.nativeRef!.value
      const token = randomUUID()
      const expectedA = { sum: 17 + 25, token }
      const expectedB = { product: 6 * 7, rememberedToken: token }
      async function check(name: string, work: () => Promise<void>) {
        stage = name
        console.log(`[${backend}] ${name}: running`)
        const started = Date.now()
        await work()
        assert.equal(session.binding.nativeRef!.value, nativeId, 'Output format switch changed the native session ID')
        const durationMs = Date.now() - started
        result.checks.push({ name, status: 'passed', durationMs })
        console.log(`[${backend}] ${name}: passed (${durationMs} ms)`)
      }
      await check('schema-a', async () => {
        const value: unknown = JSON.parse(await submit(session, `Remember this token for later turns: ${token}. Calculate 17 + 25 and return sum and token using the requested output format.`, schemaA))
        assert.equal(validateJsonSchema(schemaA, value), true, 'Schema A validation failed')
        assert.deepEqual(value, expectedA)
      })
      await check('schema-b-and-context', async () => {
        const value: unknown = JSON.parse(await submit(session, 'Calculate 6 * 7. Return product and rememberedToken, recalling the token from the first user message. Use the new output format.', schemaB))
        assert.equal(validateJsonSchema(schemaB, value), true, 'Schema B validation failed')
        assert.deepEqual(value, expectedB)
      })
      await check('plain-text-and-context', async () => {
        const text = await submit(session, 'The output format is now ordinary text. Recall the token from the first user message. Reply exactly SCHEMA_OK: followed by that token, with no JSON, quotes, whitespace or explanation.')
        assert.equal(text.trim(), `SCHEMA_OK:${token}`)
      })
      if (backend === 'claude') {
        await check('saved-structured-history', async () => {
          const items = await history(session)
          const values = items.flatMap(entry => {
            if (entry.item.type !== 'agentMessage' || entry.item.phase !== 'final') return []
            try { return [JSON.parse(entry.item.text)] } catch { return [] }
          })
          assert(values.some(value => value.sum === expectedA.sum && value.token === token), 'Schema A is missing from saved history')
          assert(values.some(value => value.product === expectedB.product && value.rememberedToken === token), 'Schema B is missing from saved history')
        })
      }
      await session.close()
      result.status = 'passed'
    } finally { await client.dispose() }
  } catch (cause) {
    result.status = 'failed'
    const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'EXAMPLE_FAILED'
    result.error = { stage, code, ...(cause instanceof HarnessSdkError ? { outcomeUnknown: cause.outcomeUnknown } : {}) }
    console.error(`[${backend}] ${stage}: failed (${code})`)
  }
  return result
}

const directory = await mkdtemp(join(tmpdir(), 'anureo-schema-live-'))
const runs: Run[] = []
try {
  for (const backend of (selected === 'all' ? ['codex', 'claude'] : [selected]) as Backend[]) {
    const cwd = join(directory, backend)
    await mkdir(cwd)
    runs.push(await run(backend, cwd))
  }
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), live: true, runs }, null, 2) + '\n')
  console.log(`Report: ${reportPath}`)
  if (runs.some(run => run.status !== 'passed')) process.exitCode = 1
} finally { await rm(directory, { recursive: true, force: true }) }
