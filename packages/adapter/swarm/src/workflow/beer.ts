// beer(): an agent()-shaped workflow step that runs as a swarm bee under a façade client.
import { HarnessSdkError, type Client, type TurnResult } from '@anureo/sdk'
import type { z } from 'zod'
import { agent, isDroppedOutcome, journaledCall, prepareOutputSchema } from '@anureo/workflow'
import type { JsonValue } from '@anureo/protocol'
import { swarmWorkflowClient, type SwarmWorkflowDelegate, type WorkflowStep } from './runner'

/** agent() options plus bee-specific fields; bee-only fields require a swarm workflow client. */
export interface BeerOptions<S extends z.ZodObject = z.ZodObject> {
  client: Client
  cwd: string
  model?: string
  instructions?: string
  /** Ignored under swarm (the session owns it); must be omitted there. */
  permissionMode?: string
  schema?: S
  /** Member backend route for the step bee; defaults to the swarm default backend. */
  role?: string
  /** Display name for the step bee. */
  name?: string
  context?: string
  constraints?: string
  expectedOutput?: string
}

const BEER_ONLY_FIELDS = ['role', 'name', 'context', 'constraints', 'expectedOutput'] as const

export function beer(prompt: string, options: BeerOptions<never> & { schema?: undefined }): Promise<string | null>
export function beer<S extends z.ZodObject>(prompt: string, options: BeerOptions<S> & { schema: S }): Promise<z.output<S> | null>
export function beer<S extends z.ZodObject>(prompt: string, options: BeerOptions<S>): Promise<string | z.output<S> | null>
/** One workflow step: a pooled swarm bee under a façade client, or plain agent() otherwise. */
export async function beer(prompt: string, options: BeerOptions): Promise<string | Record<string, unknown> | null> {
  const delegate = (options.client as unknown as Record<typeof swarmWorkflowClient, SwarmWorkflowDelegate | undefined>)[swarmWorkflowClient]
  if (!delegate) {
    const beeOnly = BEER_ONLY_FIELDS.find(field => options[field] !== undefined)
    if (beeOnly !== undefined) {
      throw new HarnessSdkError('SWARM_OPTION_REQUIRES_SWARM', `"${beeOnly}" requires a swarm workflow client; pass ctx.client from the SwarmWorkflowRunContext`)
    }
    return agent(prompt, options)
  }
  if (options.permissionMode !== undefined) throw new HarnessSdkError('SWARM_OPTION_UNSUPPORTED', 'permissionMode is owned by the swarm session')
  const output = options.schema === undefined ? undefined : prepareOutputSchema(options.schema)
  if (output && !delegate.outputSchemaAdvertised) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED', 'Swarm workflows did not advertise structured output')
  const canonical: JsonValue = {
    model: options.model ?? null,
    instructions: options.instructions ?? null,
    permissionMode: null,
    schema: output?.schema ?? null,
    cwd: options.cwd,
    client: options.client.identity,
    role: options.role ?? null,
    context: options.context ?? null,
    constraints: options.constraints ?? null,
    expectedOutput: options.expectedOutput ?? null,
  }
  const call = { prompt, canonical, droppedCode: 'BEER_DROPPED', failureCode: 'BEER_FAILED' }
  const step: WorkflowStep = {
    prompt,
    ...(options.role !== undefined ? { role: options.role } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    ...(options.expectedOutput !== undefined ? { expectedOutput: options.expectedOutput } : {}),
    ...(output !== undefined ? { outputSchema: output.schema } : {}),
  }
  const execute = async (): Promise<JsonValue | null> => {
    const result = await delegate.step(step)
    if (result.status === 'completed') {
      if (output) return await output.parse(result.text) as unknown as JsonValue
      return result.text
    }
    if (result.error && isDroppedOutcome(result.error, result.status)) return null
    if (result.status === 'interrupted' && delegate.turnEnded()) throw new HarnessSdkError('SWARM_WORKFLOW_TURN_ENDED', 'The outer turn ended; queued workflow steps were cancelled')
    if (result.error) {
      const { code, message, retryable, outcomeUnknown, details } = result.error
      throw new HarnessSdkError(code, message, retryable, outcomeUnknown, details)
    }
    throw new HarnessSdkError('BEER_INTERRUPTED')
  }
  if (output) return journaledCall(call, execute, stored => output.parse(JSON.stringify(stored)) as unknown as Record<string, unknown>)
  return journaledCall(call, execute) as Promise<string | null>
}
