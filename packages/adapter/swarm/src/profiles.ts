import { HarnessSdkError } from '@anureo/sdk'

/** Reusable source configuration for a fixed bee; sessions persist until revision rotation or closure. */
export interface BeeProfile {
  id: string
  name: string
  description: string
  instructions: string
  model?: string
  effort?: string
}

export type BeeProfileScope = 'user' | 'project'
/** Origin metadata supplied by the embedding application, separate from JSON profile content. */
export interface BeeProfileSource {
  scope: BeeProfileScope
  /** Stable origin namespace, e.g. the absolute profile directory. Distinguishes projects in shared stores. */
  namespace?: string
}
export interface BeeProfileRegistration {
  profile: BeeProfile
  source?: BeeProfileSource
  sourceFile?: string
}
/** A string addresses legacy unscoped data; an object addresses a specific origin. */
export type BeeProfileReference = string | { id: string; source?: BeeProfileSource }

export function parseProfileSource(value: BeeProfileSource): BeeProfileSource {
  if (!value || !['user', 'project'].includes(value.scope) ||
      (value.namespace !== undefined && (typeof value.namespace !== 'string' || !value.namespace.trim()))) {
    throw new HarnessSdkError('SWARM_INVALID_PROFILE', 'Expected a user or project source with an optional nonempty namespace')
  }
  return { scope: value.scope, ...(value.namespace !== undefined ? { namespace: value.namespace } : {}) }
}

export function profileReference(value: BeeProfileReference): { id: string; source?: BeeProfileSource } {
  const ref = typeof value === 'string' ? { id: value } : value
  if (!ref || !isBeeId(ref.id)) throw new HarnessSdkError('SWARM_INVALID_PROFILE', 'Invalid profile reference')
  return { id: ref.id, ...(ref.source !== undefined ? { source: parseProfileSource(ref.source) } : {}) }
}

export function profileReferenceKey(value: BeeProfileReference): string {
  const { id, source } = profileReference(value)
  return JSON.stringify([id, source?.scope ?? null, source?.namespace ?? null])
}

/** Keeps all origins; default lookup prefers project, then user, then unscoped registrations. */
export class BeeProfileRegistry {
  readonly entries: readonly BeeProfileRegistration[]
  private readonly byScope = new Map<string, BeeProfileRegistration>()
  constructor(entries: readonly BeeProfileRegistration[]) {
    this.entries = entries.map(entry => {
      const profile = parseBeeProfile(entry.profile)
      const source = entry.source !== undefined ? parseProfileSource(entry.source) : undefined
      if (entry.sourceFile !== undefined && (typeof entry.sourceFile !== 'string' || !entry.sourceFile.trim())) {
        throw new HarnessSdkError('SWARM_INVALID_PROFILE', 'Expected a nonempty sourceFile')
      }
      const key = `${source?.scope ?? ''}/${profile.id}`
      if (this.byScope.has(key)) throw new HarnessSdkError('SWARM_INVALID_PROFILE', `Duplicate profile ${key}`)
      const registration = { profile, ...(source ? { source } : {}), ...(entry.sourceFile ? { sourceFile: entry.sourceFile } : {}) }
      this.byScope.set(key, registration)
      return registration
    })
  }
  resolve(id: string, scope?: BeeProfileScope): BeeProfileRegistration | undefined {
    if (scope !== undefined) return this.byScope.get(`${scope}/${id}`)
    return this.byScope.get(`project/${id}`) ?? this.byScope.get(`user/${id}`) ?? this.byScope.get(`/${id}`)
  }
}

export function isBeeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value)
}

/** Validate profile data supplied by an embedding application or configuration loader. */
export function parseBeeProfile(value: unknown): BeeProfile {
  const invalid = (message: string) => new HarnessSdkError('SWARM_INVALID_PROFILE', message)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Expected a profile object')
  const fields = value as Record<string, unknown>
  const { id, name, description, instructions, model, effort } = fields
  if (!isBeeId(id)) throw invalid('Expected a lowercase profile id of up to 40 letters, digits, or hyphens')
  const required = (key: string, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw invalid(`Expected a nonempty string for "${key}"`)
    return text.trim()
  }
  if (effort !== undefined && (typeof effort !== 'string' || !effort.trim() || effort !== effort.trim() || effort.length > 128)) throw invalid('Expected an exact backend effort ID of at most 128 characters')
  return {
    id,
    name: required('name', name),
    description: required('description', description),
    instructions: required('instructions', instructions),
    ...(model === undefined ? {} : { model: required('model', model) }),
    ...(effort === undefined ? {} : { effort: effort as string }),
  }
}
