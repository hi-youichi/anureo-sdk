/** Verify Pi's direct structured-output tool with live model requests. */
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
import type { Item, ToolCallItem } from '@anureo/protocol'
import { submitCompleted } from './submit-completed'

const model = process.env.PI_SMOKE_MODEL
const agentDir = process.env.PI_SMOKE_AGENT_DIR
const turnWait = { associationMs: 180_000, resultMs: 180_000 }
const outputTool = 'anureo_submit_result'
const sumSchema = z.strictObject({ sum: z.number().int(), nonce: z.string() })
const valuesSchema = z.strictObject({ values: z.array(z.number().int()), nonce: z.string() })
const cwd = await mkdtemp(join(tmpdir(), 'anureo-pi-structured-live-'))
const log = (check: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ check, ...data }))

try {
  await checkLiveOutput({ cwd, model, agentDir })
} catch (cause) {
  log('failed', { code: liveFailureCode(cause) })
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

type SessionCheckOptions = Pick<LiveCheckOptions, 'cwd' | 'model'> & { client: Client }

/** Keep native error details out of the CLI failure report while retaining SDK and assertion codes. */
function liveFailureCode(cause: unknown): string {
  if (cause instanceof HarnessSdkError) return cause.code
  if (cause instanceof assert.AssertionError) return 'ASSERTION_FAILED'
  return 'LIVE_CHECK_FAILED'
}

/**
 * Validate credential-available models before opening the client, then run session and workflow checks.
 * Await client disposal on either outcome; a disposal rejection takes precedence over a check failure.
 * The CLI reports the rejection and removes the temporary directory after this settles.
 */
async function checkLiveOutput(options: LiveCheckOptions) {
  const { cwd, model, agentDir } = options
  await checkAvailableModel(options)
  const apiKey = process.env.ANUREO_PI_LIVE_API_KEY
  const client = await createClient({
    adapter: createPiAdapter({
      persistSessions: false,
      ...(agentDir ? { agentDir } : {}),
      secrets: apiKey ? [apiKey] : [],
    }),
    identity: { adapterId: 'pi', runtimeConfigId: 'structured-live' },
  })
  try {
    await checkSessionOutput({ client, cwd, model })
    await checkWorkflowOutput({ client, cwd, model })
  } finally {
    await client.dispose()
  }
}

/**
 * Require a usable catalog before checkLiveOutput opens a client. Catalog failures propagate.
 * An empty catalog rejects first. A supplied nonempty model must match a catalog reference.
 */
async function checkAvailableModel({ cwd, model, agentDir }: LiveCheckOptions) {
  const { models } = await createPiCatalogSession({ cwd, ...(agentDir ? { agentDir } : {}) })
  if (!models.length) throw new HarnessSdkError('PI_NO_AVAILABLE_MODELS')
  if (model && !models.some(value => value.ref === model)) throw new HarnessSdkError('MODEL_NOT_FOUND')
}

/**
 * Verify Pi advertises the direct tool, then check schema changes, plain output and history on one
 * read-only session. Await close even if a check fails. checkLiveOutput awaits this before starting
 * the workflow check and still owns the client.
 */
async function checkSessionOutput({ client, cwd, model }: SessionCheckOptions) {
  const session = await client.sessions.create({ cwd, ...(model ? { model } : {}), permissionMode: 'read-only' })
  try {
    assert.equal(session.capabilities.mcp, undefined)
    assert(session.capabilities.extensions?.some(extension => extension.name === 'x-anureo/structured-output-tool'))
    log('ready', { model: model ?? session.snapshot.config.model, route: 'direct-tool', mcp: false })
    const nonce = randomUUID()
    const submittedValues = await checkSchemaChange(session, nonce)
    await checkPlainTurn(session, nonce)
    await checkHistory(session, submittedValues)
  } finally {
    await session.close()
  }
}

/**
 * Check two schemas in order on the same session. Only the first prompt supplies the nonce,
 * so the second check depends on retained context. checkSessionOutput uses the verified values
 * for its history check and closes the session on request, parse or assertion failure.
 */
async function checkSchemaChange(session: Session, nonce: string) {
  const firstValue = await checkStructuredTurn({
    session, check: 'schema-a', schema: sumSchema, expected: { sum: 42, nonce },
    input: `Remember this nonce for later turns: ${nonce}. Calculate 17 + 25. Return sum and nonce. Do not read files or run commands.`,
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'integer' }, nonce: { type: 'string' } },
      required: ['sum', 'nonce'],
      additionalProperties: false,
    },
  })
  const secondValue = await checkStructuredTurn({
    session, check: 'schema-b', schema: valuesSchema, expected: { values: [1, 2, 3], nonce },
    input: 'Return the ordered integers 1, 2, 3 in values, together with the nonce remembered from the first turn. Do not read files or run commands.',
    outputSchema: {
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'integer' } }, nonce: { type: 'string' } },
      required: ['values', 'nonce'],
      additionalProperties: false,
    },
  })
  return [firstValue, secondValue]
}

/**
 * Verify one schema-bearing turn's parsed value and completed result-tool evidence before logging success.
 * Supply matching wire and local schemas; the local schema must accept the expected value.
 * checkSchemaChange collects the locally validated value for the history check. Submit, parse and
 * assertion failures reject to the session owner through checkSchemaChange.
 */
async function checkStructuredTurn<S extends z.ZodObject>({ session, input, outputSchema, schema, expected, check }: {
  session: Session
  input: string
  outputSchema: NonNullable<Parameters<Session['submit']>[0]['outputSchema']>
  schema: S
  expected: z.output<S>
  check: string
}) {
  const result = await submitCompleted(session, { input, outputSchema }, turnWait)
  const value = schema.parse(JSON.parse(result.text))
  assert.deepEqual(value, expected)
  assert(result.items.some(isCompletedOutputToolCall))
  log(check, { status: result.status, value })
  return value
}

/**
 * After both schema checks, checkSessionOutput awaits this schema-free turn before reading history.
 * Require the original nonce as plain text and reject any result-tool call, even an incomplete one.
 * Submit or assertion failures reject and the caller closes the session.
 */
async function checkPlainTurn(session: Session, nonce: string) {
  const plain = await submitCompleted(session, {
    input: 'Reply with only the remembered nonce, with no formatting, labels, punctuation or extra text. Do not call any tools.',
  }, turnWait)
  assert.equal(plain.text, nonce)
  assert(!plain.items.some(item => item.type === 'toolCall' && item.toolName === outputTool))
  log('plain-text', { status: plain.status, contextPreserved: true, outputToolCalled: false })
}

/**
 * Read the first 200 history items after checkSessionOutput's plain turn. Log success only if the
 * completed tool calls contain both verified submissions. Request or assertion failures reject.
 */
async function checkHistory(session: Session, expectedValues: readonly unknown[]) {
  const page = await session.request('history/read', { sessionId: session.id, requestId: randomUUID(), limit: 200 })
  const submittedValues = page.items.flatMap(({ item }) => isCompletedOutputToolCall(item) ? [item.input] : [])
  for (const expected of expectedValues) {
    assert(submittedValues.some(value => isDeepStrictEqual(value, expected)))
  }
  log('history', { priorStructuredSubmissionsRetained: true })
}

/** Identify successful result submissions consistently in terminal snapshots and retained history. */
function isCompletedOutputToolCall(item: Item): item is ToolCallItem & { status: 'completed' } {
  return item.type === 'toolCall' && item.toolName === outputTool && item.status === 'completed'
}

/**
 * Once the direct session is closed, checkLiveOutput runs this typed workflow call on a fresh
 * session managed by agent. Log only the expected sum after agent settles. Drops fail the
 * assertion and execution or cleanup failures reject to checkLiveOutput for client disposal.
 */
async function checkWorkflowOutput({ client, cwd, model }: SessionCheckOptions) {
  const value = await agent('Calculate 17 + 25. Do not read files or run commands. Follow the final output tool contract.', {
    client, cwd, ...(model ? { model } : {}), schema: z.strictObject({ sum: z.number().int() }),
  })
  assert.deepEqual(value, { sum: 42 })
  log('workflow', { value, route: 'direct-tool', status: 'passed' })
}
