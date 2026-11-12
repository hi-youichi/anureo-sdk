import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError, type Client } from '@anureo/sdk'
import type { z } from 'zod'
import { prepareOutputSchema } from './output-schema'
import { isDroppedOutcome, isStartupBlockException } from './agent-outcome'
import { currentRun, type RunContext } from './run-context'
import { isFatal } from './workflow-state'
import { canonicalJson, jsonCopy, type JsonValue } from './persistence/json'
import type { JsonObject } from '@anureo/protocol'
import type { PriorFailure } from './persistence/journal'

// Do not impose the SDK's short observation timeout on model execution.
const LONG_OBSERVATION_TIMEOUT_MS = 0x7fffffff

export interface AgentOptions<S extends z.ZodObject = z.ZodObject> {
  client: Client
  cwd: string
  model?: string
  instructions?: string
  /** Optional openSession permission mode; unsupported values fail session open. */
  permissionMode?: string
  schema?: S
}

type AgentOutcome =
  | { status: 'completed'; value: string | Record<string, unknown> }
  | { status: 'dropped'; error: { code: string; outcomeUnknown: boolean } }
  | { status: 'failed'; error: HarnessSdkError }

export function agent(prompt: string, options: AgentOptions<never> & { schema?: undefined }): Promise<string | null>
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S> & { schema: S }): Promise<z.output<S> | null>
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S>): Promise<string | z.output<S> | null>
/** Execute one fresh session, validate its terminal output, and release its observation resources. */
export async function agent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const context = currentRun()
  if (context) return memoizedAgent(context, prompt, options)
  return executeAgent(prompt, options)
}

/** Semantic fields participating in the journal cache identity; presentation fields never do. */
function canonicalOptions(options: AgentOptions, schema: JsonObject | undefined): JsonValue {
  return {
    model: options.model ?? null,
    instructions: options.instructions ?? null,
    permissionMode: options.permissionMode ?? null,
    schema: schema ?? null,
    cwd: options.cwd,
    client: options.client.identity,
  }
}

async function memoizedAgent<S extends z.ZodObject>(
  context: RunContext,
  prompt: string,
  options: AgentOptions<S>,
): Promise<string | z.output<S> | null> {
  const { journal, state } = context
  const output = options.schema === undefined ? undefined : prepareOutputSchema(options.schema)
  // The key advances synchronously here: host invocation order fixes the chain.
  const key = journal.nextKey(prompt, canonicalOptions(options, output?.schema))
  return state.track(async () => {
    state.assertDispatch()
    const hit = journal.resultFor(key)
    if (hit !== undefined) {
      return output ? output.parse(canonicalJson(hit)) : hit as string
    }
    const prior = journal.beginExecution(key)
    if (prior?.outcomeUnknown) {
      throw new HarnessSdkError('WORKFLOW_RECONCILIATION_REQUIRED',
        'A previous run left this agent call with an unknown outcome; reconcile it before resuming', false, true)
    }
    const agentId = randomUUID()
    await journal.append({ type: 'started', key, agentId })
    state.assertDispatch()
    try {
      const value = await executeAgent(prompt, options)
      if (value === null) {
        await journal.append({ type: 'failed', key, agentId, code: 'AGENT_DROPPED', outcomeUnknown: false })
        state.noteIncomplete()
        return null
      }
      const stored = jsonCopy(value) as JsonValue
      await journal.append({ type: 'result', key, agentId, result: stored })
      return jsonCopy(stored) as string | z.output<S>
    } catch (cause) {
      const error = sdkError(cause, 'AGENT_FAILED')
      if (isFatal(error)) state.stop(error)
      // The storage layer may have published a terminal record already; never
      // append a contradictory failure after a storage error.
      if (error.code !== 'WORKFLOW_STORAGE_FAILED') {
        await journal.append({ type: 'failed', key, agentId,
          code: error.code, outcomeUnknown: error.outcomeUnknown === true })
      }
      throw error
    }
  })
}

async function executeAgent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const { client, cwd, model, instructions, permissionMode, schema } = options
  const output = schema === undefined ? undefined : prepareOutputSchema(schema)
  const session = await client.sessions.create({ cwd, ...(model !== undefined ? { model } : {}), ...(instructions !== undefined ? { instructions } : {}), ...(permissionMode !== undefined ? { permissionMode } : {}) })
    .catch(cause => { if (isStartupBlockException(cause)) return null; throw cause })
  if (!session) return null // A failed open never hands session ownership to this call.
  let outcome: AgentOutcome
  try {
    if (output && !session.capabilities.turn?.outputSchema) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Session does not support structured output')
    const turn = await session.submit({ input: prompt, ...(output ? { outputSchema: output.schema } : {}) }, { timeoutMs: LONG_OBSERVATION_TIMEOUT_MS })
    const result = await turn.result({ timeoutMs: LONG_OBSERVATION_TIMEOUT_MS })
    if (result.status === 'completed') {
      outcome = { status: 'completed', value: output ? await output.parse(result.text) : result.text }
    } else if (result.error && isDroppedOutcome(result.error, result.status)) {
      outcome = { status: 'dropped', error: { code: result.error.code, outcomeUnknown: result.error.outcomeUnknown } }
    } else if (result.error) {
      const { code, message, retryable, outcomeUnknown, details } = result.error
      throw new HarnessSdkError(code, message, retryable, outcomeUnknown, details)
    } else {
      throw new HarnessSdkError('AGENT_INTERRUPTED')
    }
  } catch (cause) {
    if (isStartupBlockException(cause)) outcome = { status: 'dropped', error: { code: cause.code, outcomeUnknown: cause.outcomeUnknown } }
    else outcome = { status: 'failed', error: sdkError(cause, 'AGENT_FAILED', true) }
  }

  // Closing observation does not prove the backend execution stopped. Never retry input.
  const cleanupErrors = new Set<HarnessSdkError>()
  try { await session.close() } catch (cause) { cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true)) }
  try { await session.dispose() } catch (cause) { cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true)) }
  if (cleanupErrors.size) {
    const errors = [...cleanupErrors].map(error => ({ code: error.code, outcomeUnknown: error.outcomeUnknown }))
    if (outcome.status === 'failed') {
      const failure = outcome.error
      throw new HarnessSdkError(failure.code, failure.message, failure.retryable, failure.outcomeUnknown,
        { ...failure.details, cleanupErrors: errors })
    }
    throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Agent session cleanup failed', false,
      errors.some(error => error.outcomeUnknown), { errors, ...(outcome.status === 'dropped' ? { droppedError: outcome.error } : {}) })
  }
  switch (outcome.status) {
    case 'completed': return outcome.value
    case 'dropped': return null
    case 'failed': throw outcome.error
  }
}
