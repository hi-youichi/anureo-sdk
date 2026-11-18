import { HarnessSdkError } from '@anureo/sdk'
import type { z } from 'zod'
import { executeAgent, prepareAgentCall, type AgentOptions, type PreparedAgentCall } from './agent-execution'
import { currentRun } from './workflow-state'
import { journaledCall } from './journal-call'
import { canonicalJson, type JsonValue } from './persistence/json'

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
  if (context) return memoizedAgent(prompt, options)
  const outcome = await executeAgent(prompt, prepareAgentCall(options))
  return outcome.status === 'dropped' ? null : outcome.value
}

/** Project the options the journaled call hashes with the prompt. Preserve the persisted key
 * format by using null for absent model, instructions, permission mode and schema, and omitting
 * absent fallback. Use the client identity so equivalent backend configurations share a key. */
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

/** Reserve the journal key synchronously through journaledCall, then replay the saved result or
 * execute fresh through agent-execution. The prepared call is built inside the tracked region so
 * preflight failures mark the run incomplete. Schema validation awaits async refinements for
 * fresh and replayed results. Drops mark the run incomplete; fatal failures stop later dispatch. */
async function memoizedAgent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  let prepared!: PreparedAgentCall
  /** The drop reason is only known after execution; the journal reads it lazily at append time. */
  const dropCode = { value: undefined as string | undefined }
  const build = () => {
    prepared = prepareAgentCall(options)
    return { prompt, canonical: canonicalOptions(prepared), get droppedCode() { return dropCode.value } }
  }
  const run = () => executeAgent(prompt, prepared).then(outcome => {
    if (outcome.status === 'dropped') dropCode.value = outcome.error.code
    return outcome.status === 'dropped' ? null : outcome.value as JsonValue
  })
  if (options.schema !== undefined) {
    return journaledCall(build, run, stored => prepared.output!.parse(canonicalJson(stored))) as Promise<string | Record<string, unknown> | null>
  }
  return journaledCall(build, run) as Promise<string | Record<string, unknown> | null>
}
