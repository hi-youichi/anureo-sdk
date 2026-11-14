import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError, type Client, type Session } from '@anureo/sdk'
import type { z } from 'zod'
import { prepareOutputSchema, type AgentOutputSchema } from './output-schema'
import { isDroppedOutcome, isStartupBlockException } from './agent-outcome'
import { currentRun, type RunContext } from './run-context'
import { isFatal } from './workflow-state'
import { canonicalJson, jsonCopy, type JsonValue } from './persistence/json'
import type { JsonObject } from '@anureo/protocol'

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
  /** Optional openSession permission mode; unsupported values fail session open. */
  permissionMode?: string
  /** Zod object with closed objects and required JSON fields; conversions are rejected before opening. */
  schema?: S
}

/**
 * Submit once in a fresh session and return terminal text after session cleanup.
 * Return null for confirmed terminal authentication, usage/rate-limit or native service unavailability,
 * explicit skip or startup denial; unknown outcomes, other execution failures and cleanup failures reject.
 * Cleanup failures preserve a primary execution error with details.cleanupErrors, or reject with
 * RESOURCE_RELEASE_FAILED. Input is never automatically retried or interrupted, and releasing
 * observation does not confirm native execution stopped.
 * Inside workflow(), journal calls in invocation order and reuse eligible saved results on resume;
 * new executions also wait for terminal journal publication. The caller still owns the client.
 */
export function agent(prompt: string, options: AgentOptions<never> & { schema?: undefined }): Promise<string | null>
/**
 * Return locally validated typed output with the same lifecycle and journal behavior as text mode.
 * Unsupported schemas reject before opening; output validation awaits async refinements and rejects
 * missing, malformed or invalid JSON without replaying input. Defaults never fill omitted answers.
 */
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S> & { schema: S }): Promise<z.output<S> | null>
/** Select text or typed output from an optional schema, retaining agent's cleanup and failure contract. */
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S>): Promise<string | z.output<S> | null>
export async function agent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const context = currentRun()
  if (context) return memoizedAgent(context, prompt, options)
  return executeAgent(prompt, options)
}

// Do not impose the SDK's short observation timeout on model execution.
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

/**
 * agent calls this inside workflow's ambient run. Reserve the cache key before any await, revalidate
 * typed cache hits locally, and publish new execution outcomes before resolving. RunState tracks
 * even unawaited calls for workflow's drain; drops mark it incomplete and fatal failures stop dispatch.
 * Prior uncertain failures reject for reconciliation rather than resubmitting input.
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

/** Run one uncached call for agent or memoizedAgent; preflight precedes acquisition and cleanup precedes settlement. */
async function executeAgent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const { client, cwd, model, instructions, permissionMode, schema } = options
  const output = schema === undefined ? undefined : prepareOutputSchema(schema)
  const session = await openAgentSession({ client, cwd, model, instructions, permissionMode })
  if (!session) return null // A failed open never hands session ownership to this call.
  const outcome = await observeAgentTurn({ session, prompt, output })
  const cleanupErrors = await releaseAgentSession(session)
  return settleAgentOutcome(outcome, cleanupErrors)
}

/** Acquire a fresh session; only trusted startup denial becomes null. Other open failures propagate unchanged. */
function openAgentSession({ client, cwd, model, instructions, permissionMode }: Omit<AgentOptions, 'schema'>): Promise<Session | null> {
  return client.sessions.create({
    cwd,
    ...(model !== undefined ? { model } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  })
    .catch(cause => { if (isStartupBlockException(cause)) return null; throw cause })
}

/**
 * Submit once and await terminal evidence plus local validation. Capture execution failures so
 * executeAgent can release the session before exposing the outcome; this phase never retries or closes it.
 */
async function observeAgentTurn({ session, prompt, output }: {
  session: Session
  prompt: string
  output: AgentOutputSchema | undefined
}): Promise<AgentOutcome> {
  try {
    if (output && !session.capabilities.turn?.outputSchema) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Session does not support structured output')
    const turn = await session.submit({ input: prompt, ...(output ? { outputSchema: output.schema } : {}) }, { timeoutMs: LONG_OBSERVATION_TIMEOUT_MS })
    const result = await turn.result({ timeoutMs: LONG_OBSERVATION_TIMEOUT_MS })
    if (result.status === 'completed') {
      return { status: 'completed', value: output ? await output.parse(result.text) : result.text }
    } else if (result.error && isDroppedOutcome(result.error, result.status)) {
      return { status: 'dropped', error: { code: result.error.code, outcomeUnknown: result.error.outcomeUnknown } }
    } else if (result.error) {
      const { code, message, retryable, outcomeUnknown, details } = result.error
      throw new HarnessSdkError(code, message, retryable, outcomeUnknown, details)
    } else {
      throw new HarnessSdkError('AGENT_INTERRUPTED')
    }
  } catch (cause) {
    if (isStartupBlockException(cause)) return { status: 'dropped', error: { code: cause.code, outcomeUnknown: cause.outcomeUnknown } }
    return { status: 'failed', error: sdkError(cause, 'AGENT_FAILED', true) }
  }
}

/** Await close then disposal even if close fails, deduplicating repeated SDK error instances in encounter order. */
async function releaseAgentSession(session: Session): Promise<AgentErrorSummary[]> {
  // Closing observation does not prove the backend execution stopped. Never retry input.
  const cleanupErrors = new Set<HarnessSdkError>()
  try { await session.close() } catch (cause) { cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true)) }
  try { await session.dispose() } catch (cause) { cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true)) }
  return [...cleanupErrors].map(error => ({ code: error.code, outcomeUnknown: error.outcomeUnknown }))
}

/** Cleanup failure overrides values/null; an execution failure keeps its code and gains cleanup diagnostics. */
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
