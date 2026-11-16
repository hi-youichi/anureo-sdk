import { HarnessSdkError, type Client } from '@anureo/sdk'
import type { JsonSchema, SessionOpenParams } from '@anureo/protocol'
import { routingTimeoutMs, type SwarmExecution } from './execution'

export type MemberTask = { role: string; task: string }
export type Plan = { kind: 'direct' } | { kind: 'team'; tasks: readonly MemberTask[] }
export type Exchange = { input: string; answer: string }

const planSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'tasks'],
  properties: {
    kind: { type: 'string', enum: ['direct', 'team'] },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'task'],
        properties: { role: { type: 'string' }, task: { type: 'string' } },
      },
    },
  },
}

function parsePlan(text: string): Plan {
  const value: { kind?: unknown; tasks?: unknown } = JSON.parse(text) ?? {}
  const tasks = value.tasks
  if (value.kind === 'direct' && Array.isArray(tasks) && tasks.length === 0) return { kind: 'direct' }
  if (value.kind === 'team' && Array.isArray(tasks) && tasks.length >= 2 && tasks.length <= 3 &&
      tasks.every((entry): entry is MemberTask => entry !== null && typeof entry === 'object' &&
        typeof entry.role === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(entry.role) &&
        typeof entry.task === 'string' && entry.task.trim().length > 0 && entry.task.length <= 3000)) {
    return { kind: 'team', tasks }
  }
  throw new HarnessSdkError('SWARM_INVALID_PLAN')
}

export async function planTurn(
  execution: SwarmExecution,
  backend: Client,
  params: SessionOpenParams,
  input: string,
  recent: readonly Exchange[],
  roles: readonly string[],
): Promise<Plan> {
  const { cwd, permissionMode } = params
  const instructions = [
    'You plan execution for an assistant. Classify the request from the supplied conversation data.',
    'Use only the supplied data. Return the plan immediately without calling tools or doing the work.',
    'Choose direct with an empty tasks array for simple, sequential, or write-heavy requests.',
    'Choose team when 2 or 3 independent read-only tasks can advance the request in parallel.',
    'For each task use a short lowercase role slug and a self-contained task description.',
    'Honor explicit requests to work directly or to use a team when splitting into independent tasks is feasible.',
    roles.length ? `Prefer these configured role slugs when they match the task: ${JSON.stringify(roles)}` : '',
  ].filter(Boolean).join('\n')
  const result = await execution.fresh(backend, { cwd, permissionMode, instructions }, session => {
    if (!session.capabilities.turn?.outputSchema) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    return execution.submit(session, {
      input: JSON.stringify({ request: input.slice(0, 12_000), recent }),
      outputSchema: planSchema,
    }, undefined, routingTimeoutMs)
  })
  if (result.status === 'completed') {
    try { return parsePlan(result.text) } catch { throw new HarnessSdkError('SWARM_INVALID_PLAN') }
  }
  const error = result.error
  throw new HarnessSdkError(error?.code ?? 'SWARM_ROUTING_INTERRUPTED', undefined, false, error?.outcomeUnknown)
}
