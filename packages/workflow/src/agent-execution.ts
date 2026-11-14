import type { HarnessError } from '@anureo/protocol'
import { HarnessSdkError, sdkError, type Client, type Session, type SubmitOptions } from '@anureo/sdk'
import type { z } from 'zod'
import { prepareOutputSchema, type AgentOutputSchema } from './output-schema'

/** Configure an agent call. Keep the client usable until settlement and dispose it separately. */
export interface AgentOptions<S extends z.ZodObject = z.ZodObject> {
  /** Initialized client selecting the backend. The caller owns client disposal. */
  client: Client
  /** Working directory forwarded to the fresh session. */
  cwd: string
  /** Backend model selection. Omit to use the backend's selection. */
  model?: string
  /** Session instructions, separate from the input prompt. */
  instructions?: string
  /** Permission mode forwarded to the fresh session. Accepted values and defaults depend on the backend. */
  permissionMode?: string
  /** Portable Zod object schema with closed objects and required JSON fields. Omit to return text. */
  schema?: S
  /**
   * With a schema, opt in to prompting for JSON when the session lacks structured output.
   * With a schema and no fallback, an unsupported session causes agent to reject before submission.
   * In a workflow this option contributes to replay identity even in text mode.
   */
  outputFallback?: 'json-text'
  /**
   * Positive observation timeouts in milliseconds, up to 2,147,483,647 (the default).
   * The association wait begins at submission and the result wait begins after association.
   * Expiry rejects with an unknown outcome and does not interrupt native execution.
   * These limits do not affect journal replay identity.
   */
  wait?: { associationMs?: number; resultMs?: number }
}

const LONG_OBSERVATION_TIMEOUT_MS = 0x7fffffff

/** Capture session settings and prepare structured output before any asynchronous work. */
export function prepareAgentCall(options: AgentOptions) {
  const { client, cwd, model, instructions, permissionMode, schema, outputFallback, wait } = options
  const timeouts = wait && { associationMs: wait.associationMs, resultMs: wait.resultMs }
  for (const timeout of [timeouts?.associationMs, timeouts?.resultMs]) {
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > LONG_OBSERVATION_TIMEOUT_MS)) {
      throw new HarnessSdkError('INVALID_PARAMS', 'Agent observation timeouts must be positive and at most 2,147,483,647 ms')
    }
  }
  return {
    client, cwd, model, instructions, permissionMode, outputFallback,
    wait: timeouts,
    output: schema === undefined ? undefined : prepareOutputSchema(schema),
  }
}

export type PreparedAgentCall = ReturnType<typeof prepareAgentCall>

/**
 * Run a fresh call for agent outside a workflow or for executeJournaledAgent after it publishes
 * its started marker and rechecks dispatch. Release the acquired session before returning the
 * completed or dropped outcome or throwing an execution or release failure.
 */
export async function executeAgent(prompt: string, call: PreparedAgentCall): Promise<SettledAgentOutcome> {
  const { output, outputFallback, wait } = call
  const opening = openAgentSession(call)
  let session: Session
  try {
    session = await opening
  } catch (cause) {
    if (isStartupBlockException(cause)) return { status: 'dropped', error: summarizeAgentError(cause) }
    throw cause
  }
  const outcome = await observeAgentTurn({ session, prompt, output, outputFallback, wait })
  const cleanupErrors = await releaseAgentSession(session)
  return settleAgentOutcome(outcome, cleanupErrors)
}

/** Completed or dropped execution after successful session release. */
type SettledAgentOutcome =
  | { status: 'completed'; value: string | Record<string, unknown> }
  | { status: 'dropped'; error: AgentErrorSummary }

type AgentOutcome =
  | SettledAgentOutcome
  | { status: 'failed'; error: HarnessSdkError }

/** Safe diagnostics retained from cleanup and dropped terminals without native messages. */
interface AgentErrorSummary {
  code: string
  outcomeUnknown: boolean
}

interface AgentTurnRequest {
  session: Session
  prompt: string
  output: AgentOutputSchema | undefined
  outputFallback: AgentOptions['outputFallback']
  wait: AgentOptions['wait']
}

/** Request a fresh session and give executeAgent ownership when it attaches. */
function openAgentSession({ client, cwd, model, instructions, permissionMode }: Pick<
  AgentOptions, 'client' | 'cwd' | 'model' | 'instructions' | 'permissionMode'
>): Promise<Session> {
  return client.sessions.create({
    cwd,
    ...(model !== undefined ? { model } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  })
}

/**
 * Submit once, then await the associated turn's retained terminal result and any local validation.
 * Return execution evidence to executeAgent, which owns session release and final settlement.
 */
async function observeAgentTurn(request: AgentTurnRequest): Promise<AgentOutcome> {
  const { session, output, wait } = request
  try {
    const submission = agentSubmission(request)
    const turn = await session.submit(submission, { timeoutMs: wait?.associationMs ?? LONG_OBSERVATION_TIMEOUT_MS })
    const result = await turn.result({ timeoutMs: wait?.resultMs ?? LONG_OBSERVATION_TIMEOUT_MS })
    if (result.status === 'completed') {
      return { status: 'completed', value: output ? await output.parse(result.text) : result.text }
    }
    return classifyTerminalFailure(result.status, result.error)
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
function agentSubmission({ session, prompt, output, outputFallback }: AgentTurnRequest): SubmitOptions {
  if (!output) return { input: prompt }
  if (session.capabilities.turn?.outputSchema) return { input: prompt, outputSchema: output.schema }
  if (outputFallback !== 'json-text') {
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Session does not support structured output')
  }
  const instruction = 'Return the final answer as a single JSON object that matches this JSON Schema. Do not include Markdown fences or surrounding prose.'
  return { input: `${prompt}\n\n${instruction}\n${JSON.stringify(output.schema)}` }
}

/**
 * Classify a retained failed or interrupted terminal for observeAgentTurn to return to executeAgent.
 * Only confirmed outcomes qualify for a drop. Tagged startup denial qualifies in either status,
 * explicit skip applies to interruption, and the terminal API allowlist applies to failure.
 * Retain other errors for rejection after cleanup and supply AGENT_INTERRUPTED when details are absent.
 */
function classifyTerminalFailure(status: 'failed' | 'interrupted', error: HarnessError | undefined): AgentOutcome {
  if (!error) return { status: 'failed', error: new HarnessSdkError('AGENT_INTERRUPTED') }
  if (!error.outcomeUnknown) {
    const explicitSkip = status === 'interrupted' && error.details?.workflowDisposition === 'skipped'
    if (explicitSkip || isStartupBlocked(error) || (status === 'failed' && terminalApiErrors.has(error.code))) {
      return { status: 'dropped', error: summarizeAgentError(error) }
    }
  }
  return {
    status: 'failed',
    error: new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown, error.details),
  }
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
 * Settle executeAgent after both release attempts. Return completed or dropped outcomes on successful cleanup.
 * Throw the primary failure with any cleanup diagnostics, or RESOURCE_RELEASE_FAILED if cleanup
 * was the only failure.
 */
function settleAgentOutcome(outcome: AgentOutcome, errors: AgentErrorSummary[]): SettledAgentOutcome {
  if (errors.length) {
    if (outcome.status === 'failed') {
      const failure = outcome.error
      const prior = failure.details?.cleanupErrors
      throw new HarnessSdkError(failure.code, failure.message, failure.retryable, failure.outcomeUnknown,
        { ...failure.details, cleanupErrors: [...(Array.isArray(prior) ? prior : []), ...errors] })
    }
    throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Agent session cleanup failed', false,
      errors.some(error => error.outcomeUnknown), { errors, ...(outcome.status === 'dropped' ? { droppedError: outcome.error } : {}) })
  }
  if (outcome.status === 'failed') throw outcome.error
  return outcome
}

/** Share the startup-denial rule between classifyTerminalFailure and isStartupBlockException.
 * The adapter must supply the dedicated code, a confirmed outcome and the startup disposition. */
function isStartupBlocked(error: Pick<HarnessSdkError, 'code' | 'outcomeUnknown' | 'details'>): boolean {
  return !error.outcomeUnknown && error.code === 'AGENT_STARTUP_BLOCKED' && error.details?.workflowDisposition === 'startup_blocked'
}

/** Recognize a thrown SDK startup denial during session creation or turn observation. */
function isStartupBlockException(cause: unknown): cause is HarnessSdkError {
  return cause instanceof HarnessSdkError && isStartupBlocked(cause)
}

// Only apply to native failed terminal results, never open/submit/observation failures.
const terminalApiErrors = new Set([
  'AUTH_REQUIRED', 'AUTH_FORBIDDEN', 'USAGE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'NATIVE_SERVICE_UNAVAILABLE',
])
