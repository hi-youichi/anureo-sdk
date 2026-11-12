/** Real provider verification; no fake hosts or model stream substitutes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Session } from '@anureo/sdk'
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
  const { models } = await createPiCatalogSession({ cwd, ...(agentDir ? { agentDir } : {}) })
  if (!models.length) throw new HarnessSdkError('PI_NO_AVAILABLE_MODELS')
  if (model && !models.some(value => value.ref === model)) throw new HarnessSdkError('MODEL_NOT_FOUND')
  const client = await createClient({
    adapter: createPiAdapter({ persistSessions: false, ...(agentDir ? { agentDir } : {}), secrets: process.env.ANUREO_PI_LIVE_API_KEY ? [process.env.ANUREO_PI_LIVE_API_KEY] : [] }),
    identity: { adapterId: 'pi', runtimeConfigId: 'structured-live' },
  })
  const submit = async (session: Session, input: string, outputSchema?: Parameters<Session['submit']>[0]['outputSchema']) => {
    const result = await (await session.submit({ input, ...(outputSchema === undefined ? {} : { outputSchema }) }, { timeoutMs })).result({ timeoutMs })
    assert.equal(result.status, 'completed', result.status === 'failed' ? result.error.code : result.status)
    return result
  }
  try {
    const session = await client.sessions.create({ cwd, ...(model ? { model } : {}), permissionMode: 'read-only' })
    try {
      assert.equal(session.capabilities.mcp, undefined)
      assert(session.capabilities.extensions?.some(extension => extension.name === 'x-anureo/structured-output-tool'))
      log('ready', { model: model ?? session.snapshot.config.model, route: 'direct-tool', mcp: false })
      // Only the first prompt contains the nonce: later outputs must use retained context.
      const nonce = randomUUID()
      const first = await submit(session, `Remember this nonce for later turns: ${nonce}. Calculate 17 + 25. Return sum and nonce. Do not read files or run commands.`, { type: 'object', properties: { sum: { type: 'integer' }, nonce: { type: 'string' } }, required: ['sum', 'nonce'], additionalProperties: false })
      const firstValue = sumSchema.parse(JSON.parse(first.text))
      assert.deepEqual(firstValue, { sum: 42, nonce })
      assert(first.items.some(item => item.type === 'toolCall' && item.toolName === outputTool && item.status === 'completed'))
      log('schema-a', { status: first.status, value: firstValue })
      const second = await submit(session, 'Return the ordered integers 1, 2, 3 in values, together with the nonce remembered from the first turn. Do not read files or run commands.', { type: 'object', properties: { values: { type: 'array', items: { type: 'integer' } }, nonce: { type: 'string' } }, required: ['values', 'nonce'], additionalProperties: false })
      const secondValue = valuesSchema.parse(JSON.parse(second.text))
      assert.deepEqual(secondValue, { values: [1, 2, 3], nonce })
      assert(second.items.some(item => item.type === 'toolCall' && item.toolName === outputTool && item.status === 'completed'))
      log('schema-b', { status: second.status, value: secondValue })
      const plain = await submit(session, 'Reply with only the remembered nonce, with no formatting, labels, punctuation or extra text. Do not call any tools.')
      assert.equal(plain.text, nonce)
      assert(!plain.items.some(item => item.type === 'toolCall' && item.toolName === outputTool))
      log('plain-text', { status: plain.status, contextPreserved: true, outputToolCalled: false })
      const page = await session.request('history/read', { sessionId: session.id, requestId: randomUUID(), limit: 200 })
      const submittedValues = page.items.flatMap(({ item }) => item.type === 'toolCall' && item.toolName === outputTool && item.status === 'completed' ? [item.input] : [])
      assert(submittedValues.some(value => isDeepStrictEqual(value, firstValue)))
      assert(submittedValues.some(value => isDeepStrictEqual(value, secondValue)))
      log('history', { priorStructuredSubmissionsRetained: true })
    } finally { await session.close() }
    const workflowValue = await agent('Calculate 17 + 25. Do not read files or run commands. Follow the final output tool contract.', { client, cwd, ...(model ? { model } : {}), schema: z.strictObject({ sum: z.number().int() }) })
    assert.deepEqual(workflowValue, { sum: 42 })
    log('workflow', { value: workflowValue, route: 'direct-tool', status: 'passed' })
  } finally { await client.dispose() }
} catch (cause) {
  log('failed', { code: cause instanceof HarnessSdkError ? cause.code : cause instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'LIVE_CHECK_FAILED' })
  process.exitCode = 1
} finally { await rm(cwd, { recursive: true, force: true }) }
