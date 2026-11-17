import { HarnessSdkError } from '@anureo/sdk'

/** Reusable configuration for a fixed bee. Each assignment starts a fresh Session. */
export interface BeeProfile {
  id: string
  name: string
  description: string
  instructions: string
  model?: string
}

export function isBeeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value)
}

/** Validate profile data supplied by an embedding application or configuration loader. */
export function parseBeeProfile(value: unknown): BeeProfile {
  const invalid = (message: string) => new HarnessSdkError('SWARM_INVALID_PROFILE', message)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a profile object')
  const fields = value as Record<string, unknown>
  const { id, name, description, instructions, model } = fields
  if (!isBeeId(id)) throw invalid('Expected a lowercase profile id of up to 40 letters, digits, or hyphens')
  const required = (key: string, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw invalid(`Expected a nonempty string for "${key}"`)
    return text.trim()
  }
  return {
    id,
    name: required('name', name),
    description: required('description', description),
    instructions: required('instructions', instructions),
    ...(model === undefined ? {} : { model: required('model', model) }),
  }
}
