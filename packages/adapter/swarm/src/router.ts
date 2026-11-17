import { HarnessSdkError, type Client } from '@anureo/sdk'
import type { JsonSchema, SessionOpenParams } from '@anureo/protocol'
import { routingTimeoutMs, type SwarmExecution } from './execution'
import { isBeeId, type BeeProfile } from './profiles'

export type MemberTask = { kind: 'fixed'; profile: BeeProfile; task: string } |
  { kind: 'temporary'; role: string; name: string; task: string }
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
        required: ['profileId', 'role', 'name', 'task'],
        properties: {
          profileId: { type: ['string', 'null'] },
          role: { type: ['string', 'null'] },
          name: { type: ['string', 'null'] },
          task: { type: 'string' },
        },
      },
    },
  },
}

function parsePlan(text: string, profiles: ReadonlyMap<string, BeeProfile>): Plan {
  const value: { kind?: unknown; tasks?: unknown } = JSON.parse(text) ?? {}
  const tasks = value.tasks
  if (value.kind === 'direct' && Array.isArray(tasks) && tasks.length === 0) return { kind: 'direct' }
  if (value.kind !== 'team' || !Array.isArray(tasks) || tasks.length < 2 || tasks.length > 3) {
    throw new HarnessSdkError('SWARM_INVALID_PLAN')
  }
  return {
    kind: 'team',
    tasks: tasks.map((entry: unknown): MemberTask => {
      if (!entry || typeof entry !== 'object') throw new HarnessSdkError('SWARM_INVALID_PLAN')
      const { profileId, role, name, task } = entry as Record<string, unknown>
      if (typeof task !== 'string' || !task.trim() || task.length > 3000) throw new HarnessSdkError('SWARM_INVALID_PLAN')
      if (typeof profileId === 'string' && role === null && name === null) {
        const profile = profiles.get(profileId)
        if (profile) return { kind: 'fixed', profile, task }
      }
      if (profileId === null && isBeeId(role) && typeof name === 'string' && name.trim() && name.length <= 100) {
        return { kind: 'temporary', role, name: name.trim(), task }
      }
      throw new HarnessSdkError('SWARM_INVALID_PLAN')
    }),
  }
}

export async function planTurn(
  execution: SwarmExecution,
  backend: Client,
  params: SessionOpenParams,
  input: string,
  recent: readonly Exchange[],
  roles: readonly string[],
  profiles: ReadonlyMap<string, BeeProfile>,
): Promise<Plan> {
  const { cwd, permissionMode } = params
  const instructions = [
    'You plan execution for an assistant. Classify the request from the supplied conversation data.',
    'Use only the supplied data. Return the plan immediately without calling tools or doing the work.',
    'Choose direct with an empty tasks array for simple, sequential, or write-heavy requests.',
    'Choose team when 2 or 3 independent read-only tasks can advance the request in parallel.',
    'Use a self-contained task description for each assignment.',
    'For a fixed bee, use its configured profileId with role and name set to null.',
    'For a temporary bee, set profileId to null and provide a short lowercase role slug and a display name.',
    'Prefer a fixed bee when its description matches the assignment. Fill gaps with temporary bees.',
    'Honor explicit requests to work directly or to use a team when splitting into independent tasks is feasible.',
    roles.length ? 'Prefer a configured temporary role when it fits the task.' : '',
  ].filter(Boolean).join('\n')
  const result = await execution.fresh(backend, { cwd, permissionMode, instructions }, session => {
    if (!session.capabilities.turn?.outputSchema) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    return execution.submit(session, {
      input: JSON.stringify({
        request: input.slice(0, 12_000),
        recent,
        profiles: Array.from(profiles.values(), ({ id, name, description }) => ({ id, name, description })),
        roles,
      }),
      outputSchema: planSchema,
    }, undefined, routingTimeoutMs)
  })
  if (result.status === 'completed') {
    try { return parsePlan(result.text, profiles) } catch { throw new HarnessSdkError('SWARM_INVALID_PLAN') }
  }
  const error = result.error
  throw new HarnessSdkError(error?.code ?? 'SWARM_ROUTING_INTERRUPTED', undefined, false, error?.outcomeUnknown)
}
