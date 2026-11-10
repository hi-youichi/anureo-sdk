import { HarnessSdkError, type Client, type Session } from '@anureo/sdk'
import type { JsonSchema, SessionOpenParams } from '@anureo/protocol'
import { analysisSchema, derivationSchema, parseAnalysis, parseDerivation, parseReview, reviewSchema, structuredOutputSchema } from './schemas'
import { analyzePrompt, derivePrompt, instructions, verifyPrompt } from './prompts'
import { positiveInteger } from './scheduler'
import type { AgentContext, ReadabilityAgent } from './types'

export interface SdkReadabilityAgentOptions {
  /** A fresh owned client per invocation. The runner disposes it after the task. */
  createClient: (context: AgentContext) => Promise<Client>
  session?: Pick<SessionOpenParams, 'model' | 'permissionMode' | 'config'>
  timeoutMs?: number
}

export function createSdkReadabilityAgent(options: SdkReadabilityAgentOptions): ReadabilityAgent {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 600_000, 'timeoutMs')
  if (timeoutMs > 0x7fffffff) throw new Error('timeoutMs exceeds the timer limit')

  async function run<T>(prompt: string, input: unknown, schema: JsonSchema, parse: (value: unknown) => T, context: AgentContext): Promise<T> {
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline
    const wait = { signal, timeoutMs }
    let client: Client | undefined
    let session: Session | undefined
    let output: T | undefined
    let failed = false
    const errors: unknown[] = []
    try {
      signal.throwIfAborted()
      client = await options.createClient({ ...context, signal })
      signal.throwIfAborted()
      session = await client.sessions.create({ ...options.session, cwd: context.root, instructions }, wait)
      const structured = session.capabilities.turn?.outputSchema === true
      const turn = await session.submit({ input: `${prompt}\n\nINPUT:\n${JSON.stringify(input)}\n\nOUTPUT SCHEMA:\n${JSON.stringify(schema)}`,
        ...(structured ? { outputSchema: structuredOutputSchema(schema) } : {}) }, wait)
      const result = await turn.result(wait)
      if (result.status === 'failed') throw new HarnessSdkError(result.error.code, result.error.message,
        result.error.retryable, result.error.outcomeUnknown, result.error.details)
      if (result.status !== 'completed') throw new Error(`Agent execution ${result.status}`)
      output = parse(JSON.parse(result.text))
    } catch (cause) {
      failed = true
      errors.push(cause)
      // Aborting an SDK wait alone does not interrupt native execution.
      if (session?.capabilities.input?.interrupt?.targets.includes('session')) {
        try { await session.interrupt({}, { timeoutMs: 5_000 }) }
        catch (error) { errors.push(error) }
      }
    } finally {
      try { await session?.dispose() } catch (error) { errors.push(error) }
      try { await client?.dispose() } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, failed ? 'Agent execution and cleanup failed' : 'Agent cleanup failed')
    return output as T
  }

  return {
    analyze: (task, context) => run(analyzePrompt, task, analysisSchema, parseAnalysis, context),
    derive: async (observations, context) => (await run(derivePrompt, observations, derivationSchema, parseDerivation, context)).rules,
    verify: (input, context) => run(verifyPrompt, input, reviewSchema, parseReview, context),
  }
}
