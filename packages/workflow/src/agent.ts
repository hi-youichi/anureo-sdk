import { HarnessSdkError, sdkError, type Client } from '@anureo/sdk'

export interface AgentOptions {
  client: Client
  cwd: string
  model?: string
  instructions?: string
}

/** Execute one fresh session, return its final text, and release its observation resources. */
export async function agent(prompt: string, options: AgentOptions): Promise<string> {
  const { client, cwd, model, instructions } = options
  const session = await client.sessions.create({ cwd, ...(model !== undefined ? { model } : {}), ...(instructions !== undefined ? { instructions } : {}) })
  let text = ''
  let failure: HarnessSdkError | undefined
  try {
    // Do not impose the SDK's short observation timeout on model execution.
    const turn = await session.submit({ input: prompt }, { timeoutMs: 0x7fffffff })
    const result = await turn.result({ timeoutMs: 0x7fffffff })
    if (result.status === 'failed') {
      const { code, message, retryable, outcomeUnknown, details } = result.error
      throw new HarnessSdkError(code, message, retryable, outcomeUnknown, details)
    }
    if (result.status === 'interrupted') throw new HarnessSdkError('AGENT_INTERRUPTED')
    text = result.text
  } catch (cause) {
    failure = sdkError(cause, 'AGENT_FAILED', true)
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
      errors.some(error => error.outcomeUnknown), { errors })
  }
  if (failure) throw failure
  return text
}
