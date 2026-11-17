import { HarnessSdkError, type Client } from '@anureo/sdk'
import { isBeeId } from './profiles'

/** A model ID must be directly usable as SessionOpenParams.model on its owning backend. */
export interface SwarmModel {
  id: string
  name?: string
  description?: string
  isDefault?: boolean
  hidden?: boolean
}

/** Discovery is advisory unless the application explicitly requests an allowlist. */
export type SwarmBackendModelCatalog = { policy?: 'recommend' | 'allowlist' } & (
  | { status: 'available'; models: readonly SwarmModel[] }
  | { status: 'unavailable'; reason?: string }
)

/** Keys in members refer to memberBackends keys, not provider names or model IDs. */
export interface SwarmModelCatalog {
  default?: SwarmBackendModelCatalog
  members?: Readonly<Record<string, SwarmBackendModelCatalog>>
}

/** Requested execution settings; these do not confirm which model the provider actually ran. */
export interface BeeExecutionSelection {
  backend: { adapterId: string; runtimeConfigId: string }
  route: { kind: 'default' } | { kind: 'member'; key: string }
  requestedModel?: string
  modelSource: 'bee' | 'profile' | 'backend-default'
}

/** Internal, session-owned route. Live Clients must never enter snapshots or tool responses. */
export interface MemberBackend {
  client: Client
  route: BeeExecutionSelection['route']
  catalog?: SwarmBackendModelCatalog
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Expected a model catalog object')
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Invalid ${label}`)
  return value
}

/** Validate an explicit tool model without normalizing case, aliases or surrounding whitespace. */
export function parseRequestedModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'model must be a nonempty exact model ID of at most 512 characters')
  return value
}

function parseBackendCatalog(value: unknown): SwarmBackendModelCatalog {
  const fields = object(value)
  if (fields.policy !== undefined && fields.policy !== 'recommend' && fields.policy !== 'allowlist') throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Unknown model selection policy')
  const policy = fields.policy as SwarmBackendModelCatalog['policy']
  if (fields.status === 'unavailable') {
    if (fields.models !== undefined) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Unavailable catalogs cannot contain models')
    return { status: 'unavailable', ...(policy ? { policy } : {}), ...(fields.reason === undefined ? {} : { reason: text(fields.reason, 'catalog reason', 4000) }) }
  }
  if (fields.status !== 'available' || !Array.isArray(fields.models) || fields.models.length > 10_000) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Expected an available model list or an unavailable catalog')
  const ids = new Set<string>()
  const models = fields.models.map(value => {
    const entry = object(value)
    const id = text(entry.id, 'model ID', 512)
    if (id !== id.trim() || ids.has(id)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Invalid or duplicate model ID: ${id}`)
    ids.add(id)
    for (const key of ['hidden', 'isDefault'] as const) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Invalid ${key}`)
    return { id,
      ...(entry.name === undefined ? {} : { name: text(entry.name, 'model name', 512) }),
      ...(entry.description === undefined ? {} : { description: text(entry.description, 'model description', 4000) }),
      ...(entry.hidden === undefined ? {} : { hidden: entry.hidden as boolean }),
      ...(entry.isDefault === undefined ? {} : { isDefault: entry.isDefault as boolean }),
    }
  })
  return { status: 'available', ...(policy ? { policy } : {}), models }
}

/** Copy application data once so instruction rendering and execution share a stable snapshot. */
export function parseModelCatalog(value: SwarmModelCatalog | undefined, memberKeys: readonly string[]): SwarmModelCatalog {
  if (value === undefined) return {}
  const fields = object(value)
  const members: Record<string, SwarmBackendModelCatalog> = Object.create(null)
  if (fields.members !== undefined) {
    for (const [key, catalog] of Object.entries(object(fields.members))) {
      if (!isBeeId(key) || !memberKeys.includes(key)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `No memberBackends route for catalog "${key}"`)
      members[key] = parseBackendCatalog(catalog)
    }
  }
  return { ...(fields.default === undefined ? {} : { default: parseBackendCatalog(fields.default) }), members }
}

export function selectTemporaryModel(model: unknown, backend: MemberBackend): string | undefined {
  if (model === undefined) return undefined
  const requested = parseRequestedModel(model)
  if (backend.catalog?.policy === 'allowlist' && (backend.catalog.status !== 'available' || !backend.catalog.models.some(entry => entry.id === requested))) {
    throw new HarnessSdkError('SWARM_MODEL_NOT_ALLOWED', `Model "${requested}" is not allowed on the selected backend`)
  }
  return requested
}

export function executionSelection(backend: MemberBackend, model: string | undefined, fixed: boolean): BeeExecutionSelection {
  return { backend: backend.client.identity, route: { ...backend.route }, ...(model === undefined ? {} : { requestedModel: model }), modelSource: model === undefined ? 'backend-default' : fixed ? 'profile' : 'bee' }
}

function visibleCatalog(backend: MemberBackend) {
  const catalog = backend.catalog
  return { backend: backend.client.identity, route: backend.route, policy: catalog?.policy ?? 'recommend',
    ...(catalog?.status === 'available' ? { status: 'available', models: catalog.models.filter(model => !model.hidden) } : { status: 'unavailable' }),
  }
}

export function modelInstructions(defaultBackend: MemberBackend, memberBackends: readonly { key: string; backend: MemberBackend }[]): string {
  return JSON.stringify({ defaultBackend: visibleCatalog(defaultBackend), memberRoutes: memberBackends.map(({ key, backend }) => ({ key, ...visibleCatalog(backend) })) })
}
