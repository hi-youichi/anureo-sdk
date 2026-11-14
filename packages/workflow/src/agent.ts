import { randomUUID } from 'node:crypto'
import type { HarnessError, JsonObject } from '@anureo/protocol'
import { HarnessSdkError, sdkError, type Client, type Session, type SubmitOptions } from '@anureo/sdk'
import type { z } from 'zod'
import { prepareOutputSchema, type AgentOutputSchema } from './output-schema'
import { isDroppedOutcome, isStartupBlockException } from './agent-outcome'
import { currentRun, type RunContext } from './run-context'
import { isFatal } from './workflow-state'
import { canonicalJson, jsonCopy, type JsonValue } from './persistence/json'

/** Configure an independent agent call. Keep the client usable until settlement and dispose it separately. */
export interface AgentOptions<S extends z.ZodObject = z.ZodObject> {
  /** Initialized, borrowed client selecting the backend; agent releases only its own session. */
  client: Client
  /** Working directory forwarded to the fresh session. */
  cwd: string
  /** Backend model selection; omission leaves selection to the session/backend. */
  model?: string
  /** Session instructions, separate from the input prompt. */
  instructions?: string
  /** Permission mode forwarded to the fresh session. Accepted values and defaults depend on the backend. */
  permissionMode?: string
  /** Portable Zod object schema with closed objects and required JSON fields. Omit to return text. */
  schema?: S
  /**
   * With a schema, ask for JSON in the prompt when the session lacks structured output.
   * Without this opt-in, an unsupported session rejects before submission.
   */
  outputFallback?: 'json-text'
}

/**
 * Run a prompt in a fresh session and return the SDK's final text, which can be empty.
 * Await the associated turn's terminal result. Once a session is acquired, close and dispose it
 * before settling, including when submission or observation fails.
 * Return null for confirmed terminal authentication, usage/rate-limit or native service unavailability,
 * explicit skip or startup denial; unknown outcomes, other execution failures and cleanup failures reject.
 * Cleanup failures preserve a primary execution error with details.cleanupErrors, or reject with
 * RESOURCE_RELEASE_FAILED. Input is never automatically retried or interrupted, and releasing
 * observation does not confirm native execution stopped.
 * Inside workflow(), journal calls in invocation order and reuse eligible saved results on resume
 * without opening a session. New executions wait for terminal journal publication. A previous
 * unknown outcome rejects with WORKFLOW_RECONCILIATION_REQUIRED. The caller still owns the client.
 */
export function agent(prompt: string, options: AgentOptions<never> & { schema?: undefined }): Promise<string | null>
/**
 * Return locally validated typed output with the same lifecycle and journal behavior as text mode.
 * Unsupported schemas reject before opening. Validation awaits async refinements for fresh and
 * replayed results. Missing, malformed or invalid JSON rejects without replaying input.
 * Defaults never fill omitted answers.
 */
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S> & { schema: S }): Promise<z.output<S> | null>
/** Select text or typed output from an optional schema, retaining agent's cleanup and failure contract. */
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S>): Promise<string | z.output<S> | null>
export async function agent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const context = currentRun()
  if (context) return memoizedAgent(context, prompt, options)
  return executeAgent(prompt, options)
}

// Give association and terminal observation the longest supported timer delay for model execution.
const LONG_OBSERVATION_TIMEOUT_MS = 0x7fffffff

/** Execution evidence retained until cleanup has settled, before returning or rejecting the call. */
type AgentOutcome =
  | { status: 'completed'; value: string | Record<string, unknown> }
  | { status: 'dropped'; error: AgentErrorSummary }
  | { status: 'failed'; error: HarnessSdkError }

/** Safe diagnostics retained from cleanup and dropped terminals without native messages. */
interface AgentErrorSummary {
  code: string
  outcomeUnknown: boolean
}

/** Build the options memoizedAgent hashes with the prompt. Include client identity and the converted schema. */
function canonicalOptions(options: AgentOptions, schema: JsonObject | undefined): JsonValue {
  return {
    model: options.model ?? null,
    instructions: options.instructions ?? null,
    permissionMode: options.permissionMode ?? null,
    schema: schema ?? null,
    ...(options.outputFallback ? { outputFallback: options.outputFallback } : {}),
    cwd: options.cwd,
    client: options.client.identity,
  }
}

/**
 * Reserve the key in invocation order when agent inherits a workflow run. Register replay or
 * execution with RunState so workflow drains the call even if the body leaves it unawaited.
 * Return saved text or revalidate saved data on a cache hit. Reject prior uncertain failures for
 * reconciliation before opening a session.
 */
async function memoizedAgent<S extends z.ZodObject>(
  context: RunContext,
  prompt: string,
  options: AgentOptions<S>,
): Promise<string | z.output<S> | null> {
  const { journal, state } = context
  const output = options.schema === undefined ? undefined : prepareOutputSchema(options.schema)
  // The key advances synchronously here: host invocation order fixes the chain.
  const key = journal.nextKey(prompt, canonicalOptions(options, output?.schema))
  return state.track(() => {
    state.assertDispatch()
    const hit = journal.resultFor(key)
    if (hit !== undefined) return replayAgentResult(hit, output)
    const prior = journal.beginExecution(key)
    if (prior?.outcomeUnknown) {
      throw new HarnessSdkError('WORKFLOW_RECONCILIATION_REQUIRED',
        'A previous run left this agent call with an unknown outcome; reconcile it before resuming', false, true)
    }
    return executeJournaledAgent({ context, key, prompt, options })
  })
}

/** Decode memoizedAgent's cache hit. Typed hits can reject if the current schema rejects the saved data. */
async function replayAgentResult<S extends z.ZodObject>(
  hit: JsonValue,
  output: AgentOutputSchema<S> | undefined,
): Promise<string | z.output<S>> {
  return output ? output.parse(canonicalJson(hit)) : hit as string
}

/**
 * Execute memoizedAgent's cache miss after saving its started marker and rechecking dispatch.
 * After execution settles, publish a result or failure before returning. Drops mark the run
 * incomplete. Fatal failures stop later dispatch, and WORKFLOW_STORAGE_FAILED rejects without
 * a second terminal write.
 */
async function executeJournaledAgent<S extends z.ZodObject>({ context, key, prompt, options }: {
  context: RunContext
  key: string
  prompt: string
  options: AgentOptions<S>
}): Promise<string | z.output<S> | null> {
  const { journal, state } = context
  const agentId = randomUUID()
  await journal.append({ type: 'started', key, agentId })
  state.assertDispatch()
  try {
    // Cache identity was computed at invocation. Fresh execution reads options after publication.
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
    // The storage layer may have published a terminal record already.
    if (error.code !== 'WORKFLOW_STORAGE_FAILED') {
      await journal.append({ type: 'failed', key, agentId,
        code: error.code, outcomeUnknown: error.outcomeUnknown === true })
    }
    throw error
  }
}

/**
 * Run a fresh call for agent or executeJournaledAgent. Validate the schema before opening, then
 * release the acquired session before returning text, data or null or rejecting with a failure.
 */
async function executeAgent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const { client, cwd, model, instructions, permissionMode, schema } = options
  const output = schema === undefined ? undefined : prepareOutputSchema(schema)
  const session = await openAgentSession({ client, cwd, model, instructions, permissionMode })
  if (!session) return null // A failed open never hands session ownership to this call.
  const outcome = await observeAgentTurn({ session, prompt, output, outputFallback: options.outputFallback })
  const cleanupErrors = await releaseAgentSession(session)
  return settleAgentOutcome(outcome, cleanupErrors)
}

/**
 * Give executeAgent ownership of the attached session. A confirmed startup denial from the open
 * promise resolves to null. Other rejections and synchronous request setup errors propagate.
 */
function openAgentSession({ client, cwd, model, instructions, permissionMode }: Pick<
  AgentOptions, 'client' | 'cwd' | 'model' | 'instructions' | 'permissionMode'
>): Promise<Session | null> {
  return client.sessions.create({
    cwd,
    ...(model !== undefined ? { model } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  })
    .catch(cause => {
      if (isStartupBlockException(cause)) return null
      throw cause
    })
}

/**
 * Submit once and await terminal evidence plus local validation. Capture execution failures so
 * executeAgent can release the session before exposing the outcome; this phase never retries or closes it.
 */
async function observeAgentTurn({ session, prompt, output, outputFallback }: {
  session: Session
  prompt: string
  output: AgentOutputSchema | undefined
  outputFallback: AgentOptions['outputFallback']
}): Promise<AgentOutcome> {
  try {
    const submission = agentSubmission({ session, prompt, output, outputFallback })
    const turn = await session.submit(submission, { timeoutMs: LONG_OBSERVATION_TIMEOUT_MS })
    const result = await turn.result({ timeoutMs: LONG_OBSERVATION_TIMEOUT_MS })
    if (result.status === 'completed') {
      return { status: 'completed', value: output ? await output.parse(result.text) : result.text }
    }
    return classifyAgentFailure(result.status, result.error)
  } catch (cause) {
    if (isStartupBlockException(cause)) return { status: 'dropped', error: summarizeAgentError(cause) }
    return { status: 'failed', error: sdkError(cause, 'AGENT_FAILED', true) }
  }
}

/**
 * Build observeAgentTurn's single submission using the attached session's capabilities.
 * With structured output requested, use its schema route or the opted-in JSON text prompt.
 * Throw CAPABILITY_UNSUPPORTED before submission if neither route is available.
 */
function agentSubmission({ session, prompt, output, outputFallback }: {
  session: Session
  prompt: string
  output: AgentOutputSchema | undefined
  outputFallback: AgentOptions['outputFallback']
}): SubmitOptions {
  if (!output) return { input: prompt }
  if (session.capabilities.turn?.outputSchema) return { input: prompt, outputSchema: output.schema }
  if (outputFallback !== 'json-text') {
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Session does not support structured output')
  }
  const instruction = 'Return the final answer as a single JSON object that matches this JSON Schema. Do not include Markdown fences or surrounding prose.'
  return { input: `${prompt}\n\n${instruction}\n${JSON.stringify(output.schema)}` }
}

/**
 * Classify a retained failed or interrupted terminal. Return drop evidence for settlement after
 * cleanup, or throw the terminal's SDK error through observeAgentTurn's startup-denial guard.
 */
function classifyAgentFailure(status: 'failed' | 'interrupted', error: HarnessError | undefined): AgentOutcome {
  if (!error) throw new HarnessSdkError('AGENT_INTERRUPTED')
  if (isDroppedOutcome(error, status)) return { status: 'dropped', error: summarizeAgentError(error) }
  throw new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown, error.details)
}

/** Project errors to the code and uncertainty exposed in agent's cleanup diagnostics. */
function summarizeAgentError(error: AgentErrorSummary): AgentErrorSummary {
  return { code: error.code, outcomeUnknown: error.outcomeUnknown }
}

/**
 * Release executeAgent's session in close/dispose order. Attempt disposal after close failure
 * and return distinct normalized SDK error instances as safe diagnostics in encounter order.
 */
async function releaseAgentSession(session: Session): Promise<AgentErrorSummary[]> {
  const cleanupErrors = new Set<HarnessSdkError>()
  for (const method of ['close', 'dispose'] as const) {
    try {
      await session[method]()
    } catch (cause) {
      cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true))
    }
  }
  return [...cleanupErrors].map(summarizeAgentError)
}

/**
 * Settle executeAgent after both release attempts. Return text/data or null on successful cleanup.
 * Throw the primary failure with any cleanup diagnostics, or RESOURCE_RELEASE_FAILED if cleanup
 * was the only failure.
 */
function settleAgentOutcome(outcome: AgentOutcome, errors: AgentErrorSummary[]): string | Record<string, unknown> | null {
  if (errors.length) {
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
