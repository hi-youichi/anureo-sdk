import { HarnessSdkError, sdkError, type Client } from '@anureo/sdk'
import type { z } from 'zod'
import { prepareOutputSchema } from './output-schema'
import { isDroppedOutcome, isStartupBlockException } from './agent-outcome'

export interface AgentOptions<S extends z.ZodObject = z.ZodObject> {
  client: Client
  cwd: string
  model?: string
  instructions?: string
  schema?: S
}

export function agent(prompt: string, options: AgentOptions<never> & { schema?: undefined }): Promise<string | null>
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S> & { schema: S }): Promise<z.output<S> | null>
export function agent<S extends z.ZodObject>(prompt: string, options: AgentOptions<S>): Promise<string | z.output<S> | null>
/** Execute one fresh session, validate its terminal output, and release its observation resources. */
export async function agent(prompt: string, options: AgentOptions): Promise<string | Record<string, unknown> | null> {
  const { client, cwd, model, instructions, schema } = options
  const output = schema === undefined ? undefined : prepareOutputSchema(schema)
  const session = await client.sessions.create({ cwd, ...(model !== undefined ? { model } : {}), ...(instructions !== undefined ? { instructions } : {}) })
    .catch(cause => { if (isStartupBlockException(cause)) return null; throw cause })
  if (!session) return null // A failed open never hands session ownership to this call.
  let value: string | Record<string, unknown> | null = null
  let failure: HarnessSdkError | undefined
  let droppedError: { code: string; outcomeUnknown: boolean } | undefined
  try {
    if (output && !session.capabilities.turn?.outputSchema) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Backend does not support outputSchema')
    // Do not impose the SDK's short observation timeout on model execution.
    const turn = await session.submit({ input: prompt, ...(output ? { outputSchema: output.schema } : {}) }, { timeoutMs: 0x7fffffff })
    const result = await turn.result({ timeoutMs: 0x7fffffff })
    if (result.status === 'completed') {
      value = output ? await output.parse(result.text) : result.text
    } else if (result.error && isDroppedOutcome(result.error, result.status)) {
      droppedError = { code: result.error.code, outcomeUnknown: result.error.outcomeUnknown }
    } else if (result.error) {
      const { code, message, retryable, outcomeUnknown, details } = result.error
      throw new HarnessSdkError(code, message, retryable, outcomeUnknown, details)
    } else {
      throw new HarnessSdkError('AGENT_INTERRUPTED')
    }
  } catch (cause) {
    if (isStartupBlockException(cause)) droppedError = { code: cause.code, outcomeUnknown: cause.outcomeUnknown }
    else failure = sdkError(cause, 'AGENT_FAILED', true)
  }

  // Closing observation does not prove the backend execution stopped. Never retry input.
  const cleanupErrors = new Set<HarnessSdkError>()
  try { await session.close() } catch (cause) { cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true)) }
  try { await session.dispose() } catch (cause) { cleanupErrors.add(sdkError(cause, 'RESOURCE_RELEASE_FAILED', true)) }
  if (cleanupErrors.size) {
    const errors = [...cleanupErrors].map(error => ({ code: error.code, outcomeUnknown: error.outcomeUnknown }))
    if (failure) throw new HarnessSdkError(failure.code, failure.message, failure.retryable, failure.outcomeUnknown,
      { ...failure.details, cleanupErrors: errors })
    throw new HarnessSdkError('RESOURCE_RELEASE_FAILED', 'Agent session cleanup failed', false,
      errors.some(error => error.outcomeUnknown), { errors, ...(droppedError ? { droppedError } : {}) })
  }
  if (failure) throw failure
  return value
}
