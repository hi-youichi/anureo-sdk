import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError } from '@anureo/sdk'
import type { z } from 'zod'
import { executeAgent, prepareAgentCall, type AgentOptions, type PreparedAgentCall } from './agent-execution'
import type { AgentOutputSchema } from './output-schema'
import { currentRun, isFatal, type RunContext } from './workflow-state'
import { canonicalJson, jsonCopy, type JsonValue } from './persistence/json'

/**
 * Run a prompt in a fresh session or replay an eligible workflow result. Return the SDK's final
 * text, which can be empty. Fresh execution awaits the associated turn's terminal result.
 * Once a session is acquired, attempt close and then disposal before settlement, even when
 * submission, observation or close fails.
 * Return null for a confirmed authentication, usage-limit, rate-limit or service-unavailability
 * failure reported in a failed terminal, an explicit skip reported on interruption, or a tagged
 * startup denial. Unknown outcomes, other execution failures and cleanup failures reject.
 * Cleanup failures preserve a primary execution error with details.cleanupErrors, or reject with
 * RESOURCE_RELEASE_FAILED. The caller decides whether to retry or request interruption through
 * the SDK. Agent submits at most once per call. Session release ends local observation and can
 * leave native execution running.
 * Inside workflow(), reserve cache keys in invocation order and reuse eligible saved results on
 * resume without opening a session. A journal miss awaits publication of its started record before
 * dispatch and its terminal record before returning a result. Checkpoint failures reject. A saved
 * failure with an unknown outcome at the same key rejects with WORKFLOW_RECONCILIATION_REQUIRED.
 * Keep the borrowed client usable until settlement and dispose it separately when finished.
 */
export function agent(prompt: string, options: AgentOptions<never> & { schema?: undefined }): Promise<string | null>
/**
 * Return typed output from a portable Zod object schema, with the same session ownership,
 * cleanup, drop, and journal behavior as text mode.
 * Unsupported schemas reject before opening. Validation awaits async refinements for fresh and
 * replayed results. The JSON must supply every required field before Zod checks run.
 * Missing, malformed or invalid JSON rejects without resubmitting the prompt.
 */
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S> & { schema: S }): Promise<z.output<S> | null>
/** Return text when schema is omitted or undefined, or validated data when it is supplied.
 * Both modes share agent's session ownership, cleanup, drop, and journal behavior. */
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S>): Promise<string | z.output<S> | null>
export async function agent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const context = currentRun()
  if (context) return memoizedAgent(context, prompt, options)
  const outcome = await executeAgent(prompt, prepareAgentCall(options))
  return outcome.status === 'dropped' ? null : outcome.value
}

/**
 * Track preflight, replay and execution so workflow observes failures and can drain unawaited calls.
 * Prepare the call and reserve its key synchronously in invocation order.
 */
async function memoizedAgent(
  context: RunContext,
  prompt: string,
  options: AgentOptions,
): Promise<string | Record<string, unknown> | null> {
  const { journal, state } = context
  return state.track(() => {
    const call = prepareAgentCall(options)
    const key = journal.nextKey(prompt, canonicalOptions(call))
    const decision = journal.resolveCall(key)
    if (decision.action === 'replay') return replayAgentResult(decision.result, call.output)
    if (decision.action === 'reconcile') {
      throw new HarnessSdkError('WORKFLOW_RECONCILIATION_REQUIRED',
        'A previous run left this agent call with an unknown outcome; reconcile it before resuming', false, true)
    }
    return executeJournaledAgent({ context, key, prompt, call })
  })
}

/** Project the options memoizedAgent hashes with the prompt. Preserve the persisted key format
 * by using null for absent model, instructions, permission mode and schema, and omitting absent
 * fallback. Use the client identity so equivalent backend configurations can share a key. */
function canonicalOptions(call: PreparedAgentCall): JsonValue {
  return {
    model: call.model ?? null,
    instructions: call.instructions ?? null,
    permissionMode: call.permissionMode ?? null,
    schema: call.output?.schema ?? null,
    ...(call.outputFallback ? { outputFallback: call.outputFallback } : {}),
    cwd: call.cwd,
    client: call.client.identity,
  }
}

/** Return saved text or await current schema validation for memoizedAgent's typed hit.
 * A rejected validation propagates to the agent caller without rerunning the prompt. */
async function replayAgentResult(
  hit: JsonValue,
  output: AgentOutputSchema | undefined,
): Promise<string | Record<string, unknown>> {
  return output ? output.parse(canonicalJson(hit)) : hit as string
}

/**
 * Execute memoizedAgent's cache miss after saving its started marker and rechecking dispatch.
 * Await fresh execution and session release before publishing the terminal event. Drops mark
 * the run incomplete. Fatal failures stop later dispatch, and WORKFLOW_STORAGE_FAILED rejects
 * without attempting a second terminal write. The dispatch check is outside the execution catch
 * so a call stopped during publication retains its started marker.
 */
async function executeJournaledAgent({ context, key, prompt, call }: {
  context: RunContext
  key: string
  prompt: string
  call: PreparedAgentCall
}): Promise<string | Record<string, unknown> | null> {
  const { journal, state } = context
  const agentId = randomUUID()
  await journal.append({ type: 'started', key, agentId })
  state.assertDispatch()
  try {
    const outcome = await executeAgent(prompt, call)
    if (outcome.status === 'dropped') {
      await journal.append({ type: 'failed', key, agentId, code: outcome.error.code, outcomeUnknown: false })
      state.noteIncomplete()
      return null
    }
    const stored = jsonCopy(outcome.value) as JsonValue
    await journal.append({ type: 'result', key, agentId, result: stored })
    return jsonCopy(stored) as string | Record<string, unknown>
  } catch (cause) {
    const error = sdkError(cause, 'AGENT_FAILED')
    if (isFatal(error)) state.stop(error)
    // The storage layer may have published a terminal record already.
    if (error.code !== 'WORKFLOW_STORAGE_FAILED') {
      try {
        await journal.append({ type: 'failed', key, agentId,
          code: error.code, outcomeUnknown: error.outcomeUnknown === true })
      } catch {
        state.noteStorageFailure()
        throw new HarnessSdkError(error.code, error.message, error.retryable, error.outcomeUnknown,
          { ...error.details, journalErrorCode: 'WORKFLOW_STORAGE_FAILED' })
      }
    }
    throw error
  }
}
