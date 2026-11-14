/** Real provider verification; no fake hosts or model stream substitutes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Client, type Session } from '@anureo/sdk'
import { agent } from '@anureo/workflow'
import { z } from 'zod'
import { createPiAdapter, createPiCatalogSession } from '@anureo/adapter-pi'

const model = process.env.PI_SMOKE_MODEL
const agentDir = process.env.PI_SMOKE_AGENT_DIR
const timeoutMs = 180_000
const outputTool = 'anureo_submit_result'
const sumSchema = z.strictObject({ sum: z.number().int(), nonce: z.string() })
const valuesSchema = z.strictObject({ values: z.array(z.number().int()), nonce: z.string() })
const cwd = await mkdtemp(join(tmpdir(), 'anureo-pi-structured-live-'))
const log = (check: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ check, ...data }))

try {
  await checkLiveOutput({ cwd, model, agentDir })
} catch (cause) {
  log('failed', { code: cause instanceof HarnessSdkError ? cause.code : cause instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'LIVE_CHECK_FAILED' })
  process.exitCode = 1
} finally {
  await rm(cwd, { recursive: true, force: true })
}

/** Working directory owned by the entry code and optional provider configuration from the environment. */
interface LiveCheckOptions {
  cwd: string
  model?: string
  agentDir?: string
}

/**
 * Validate credential-available models before opening the client, then run session and workflow checks.
 * Await client disposal on either outcome; failures reach the entry code's report and exit status.
 */
async function checkLiveOutput({ cwd, model, agentDir }: LiveCheckOptions) {
  const { models } = await createPiCatalogSession({ cwd, ...(agentDir ? { agentDir } : {}) })
  if (!models.length) throw new HarnessSdkError('PI_NO_AVAILABLE_MODELS')
  if (model && !models.some(value => value.ref === model)) throw new HarnessSdkError('MODEL_NOT_FOUND')
  const client = await createClient({
    adapter: createPiAdapter({ persistSessions: false, ...(agentDir ? { agentDir } : {}), secrets: process.env.ANUREO_PI_LIVE_API_KEY ? [process.env.ANUREO_PI_LIVE_API_KEY] : [] }),
    identity: { adapterId: 'pi', runtimeConfigId: 'structured-live' },
  })
  try {
    await checkSessionOutput({ client, cwd, model })
    const workflowValue = await agent('Calculate 17 + 25. Do not read files or run commands. Follow the final output tool contract.', { client, cwd, ...(model ? { model } : {}), schema: z.strictObject({ sum: z.number().int() }) })
    assert.deepEqual(workflowValue, { sum: 42 })
    log('workflow', { value: workflowValue, route: 'direct-tool', status: 'passed' })
  } finally {
    await client.dispose()
  }
}

/**
 * Check schema changes, plain output and retained history on the same read-only session.
 * Only the first prompt supplies the nonce, so later checks require retained context.
 * Close the session before returning or rejecting; the caller retains the client.
 */
async function checkSessionOutput({ client, cwd, model }: Pick<LiveCheckOptions, 'cwd' | 'model'> & { client: Client }) {
  const session = await client.sessions.create({ cwd, ...(model ? { model } : {}), permissionMode: 'read-only' })
  try {
    assert.equal(session.capabilities.mcp, undefined)
    assert(session.capabilities.extensions?.some(extension => extension.name === 'x-anureo/structured-output-tool'))
    log('ready', { model: model ?? session.snapshot.config.model, route: 'direct-tool', mcp: false })
    const nonce = randomUUID()
    const firstValue = await checkStructuredTurn({
      session, check: 'schema-a', schema: sumSchema, expected: { sum: 42, nonce },
      input: `Remember this nonce for later turns: ${nonce}. Calculate 17 + 25. Return sum and nonce. Do not read files or run commands.`,
      outputSchema: { type: 'object', properties: { sum: { type: 'integer' }, nonce: { type: 'string' } }, required: ['sum', 'nonce'], additionalProperties: false },
    })
    const secondValue = await checkStructuredTurn({
      session, check: 'schema-b', schema: valuesSchema, expected: { values: [1, 2, 3], nonce },
      input: 'Return the ordered integers 1, 2, 3 in values, together with the nonce remembered from the first turn. Do not read files or run commands.',
      outputSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } }, nonce: { type: 'string' } }, required: ['values', 'nonce'], additionalProperties: false },
    })
    const plain = await submitCompleted(session, 'Reply with only the remembered nonce, with no formatting, labels, punctuation or extra text. Do not call any tools.')
    assert.equal(plain.text, nonce)
    assert(!plain.items.some(item => item.type === 'toolCall' && item.toolName === outputTool))
    log('plain-text', { status: plain.status, contextPreserved: true, outputToolCalled: false })
    await checkHistory(session, [firstValue, secondValue])
  } finally {
    await session.close()
  }
}

/**
 * Submit once and await terminal completion with separate 180-second waits for association and result.
 * Omit the schema for plain text. Request/wait failures and non-completed terminals reject;
 * the caller owns session cleanup, and a timeout does not cancel native execution.
 */
async function submitCompleted(session: Session, input: string, outputSchema?: Parameters<Session['submit']>[0]['outputSchema']) {
  const turn = await session.submit({ input, ...(outputSchema === undefined ? {} : { outputSchema }) }, { timeoutMs })
  const result = await turn.result({ timeoutMs })
  assert.equal(result.status, 'completed', result.status === 'failed' ? result.error.code : result.status)
  return result
}

/**
 * Verify one schema-bearing turn's parsed value and completed result-tool evidence before logging success.
 * Supply matching wire and local schemas; the local schema must accept the expected value.
 * checkSessionOutput passes the locally validated value to checkHistory; parse and assertion failures reject.
 */
async function checkStructuredTurn<S extends z.ZodObject>({ session, input, outputSchema, schema, expected, check }: {
  session: Session
  input: string
  outputSchema: NonNullable<Parameters<Session['submit']>[0]['outputSchema']>
  schema: S
  expected: z.output<S>
  check: string
}) {
  const result = await submitCompleted(session, input, outputSchema)
  const value = schema.parse(JSON.parse(result.text))
  assert.deepEqual(value, expected)
  assert(result.items.some(item => item.type === 'toolCall' && item.toolName === outputTool && item.status === 'completed'))
  log(check, { status: result.status, value })
  return value
}

/** Assert both prior submissions remain in the first 200 history items; request or assertion failures reject. */
async function checkHistory(session: Session, expectedValues: readonly unknown[]) {
  const page = await session.request('history/read', { sessionId: session.id, requestId: randomUUID(), limit: 200 })
  const submittedValues = page.items.flatMap(({ item }) => item.type === 'toolCall' && item.toolName === outputTool && item.status === 'completed' ? [item.input] : [])
  for (const expected of expectedValues) {
    assert(submittedValues.some(value => isDeepStrictEqual(value, expected)))
  }
  log('history', { priorStructuredSubmissionsRetained: true })
}
