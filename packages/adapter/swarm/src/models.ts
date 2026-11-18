import { HarnessSdkError, type Client } from '@anureo/sdk'
import { createHash } from 'node:crypto'
import { isBeeId } from './profiles'

/** Application-authored advice, not provider capabilities or verified prices. */
export interface ModelGuidance {
  summary: string
  relativeCost?: 'low' | 'medium' | 'high' | 'unknown'
  /** Costs are comparable only within the same explicitly named billing environment. */
  comparisonGroup?: string
  preferredTasks?: readonly string[]
  limitations?: readonly string[]
  /** Advisory native effort ID; only an explicit bee/profile effort configures execution. */
  recommendedEffort?: string
  source: string
  reviewedAt: string
}

/** A model ID must be directly usable as SessionOpenParams.model on its owning backend. */
export interface SwarmModel {
  id: string
  name?: string
  description?: string
  isDefault?: boolean
  hidden?: boolean
  efforts?: readonly { id: string; description?: string }[]
  defaultEffort?: string
  serviceTiers?: readonly string[]
  inputModalities?: readonly string[]
  guidance?: ModelGuidance
}

/** Discovery is advisory unless the application explicitly requests an allowlist. */
export type SwarmBackendModelCatalog = { policy?: 'recommend' | 'allowlist'; effortConfigKey?: 'effort' | 'thinkingLevel' } & (
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
  requestedEffort?: string
  effortSource: 'bee' | 'profile' | 'backend-default'
  selectionReason?: string
  /** SHA-256 of the copied guidance for the explicitly requested model, when present. */
  guidanceRevision?: string
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

function texts(value: unknown, label: string, limit = 512): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Invalid ${label}`)
  return value.map(item => text(item, label, limit))
}

/** Validate and detach application-authored guidance before overlaying a discovered model. */
export function parseModelGuidance(value: unknown): ModelGuidance {
  const entry = object(value)
  const keys = ['summary', 'relativeCost', 'comparisonGroup', 'preferredTasks', 'limitations', 'recommendedEffort', 'source', 'reviewedAt']
  if (Object.keys(entry).some(key => !keys.includes(key))) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Unknown model guidance field')
  if (entry.relativeCost !== undefined && !['low', 'medium', 'high', 'unknown'].includes(entry.relativeCost as string)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Invalid relative cost')
  const reviewedAt = text(entry.reviewedAt, 'guidance review date', 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || !Number.isFinite(Date.parse(reviewedAt)) || new Date(reviewedAt).toISOString().slice(0, 10) !== reviewedAt) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Guidance reviewedAt must be a valid YYYY-MM-DD date')
  if (entry.relativeCost !== undefined && entry.relativeCost !== 'unknown' && entry.comparisonGroup === undefined) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Relative costs require a comparisonGroup')
  return {
    summary: text(entry.summary, 'guidance summary', 2000),
    ...(entry.relativeCost === undefined ? {} : { relativeCost: entry.relativeCost as ModelGuidance['relativeCost'] }),
    ...(entry.comparisonGroup === undefined ? {} : { comparisonGroup: text(entry.comparisonGroup, 'cost comparison group', 512) }),
    ...(entry.preferredTasks === undefined ? {} : { preferredTasks: texts(entry.preferredTasks, 'preferred tasks') }),
    ...(entry.limitations === undefined ? {} : { limitations: texts(entry.limitations, 'model limitations') }),
    ...(entry.recommendedEffort === undefined ? {} : { recommendedEffort: parseEffort(entry.recommendedEffort) }),
    source: text(entry.source, 'guidance source', 2000), reviewedAt,
  }
}

function parseEffort(value: unknown): string {
  const id = text(value, 'effort ID', 128)
  if (id !== id.trim()) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Effort ID must be exact')
  return id
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
  if (fields.effortConfigKey !== undefined && fields.effortConfigKey !== 'effort' && fields.effortConfigKey !== 'thinkingLevel') throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Unknown backend effort config key')
  const effortConfigKey = fields.effortConfigKey as SwarmBackendModelCatalog['effortConfigKey']
  if (fields.status === 'unavailable') {
    if (fields.models !== undefined) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Unavailable catalogs cannot contain models')
    return { status: 'unavailable', ...(policy ? { policy } : {}), ...(effortConfigKey ? { effortConfigKey } : {}), ...(fields.reason === undefined ? {} : { reason: text(fields.reason, 'catalog reason', 4000) }) }
  }
  if (fields.status !== 'available' || !Array.isArray(fields.models) || fields.models.length > 10_000) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Expected an available model list or an unavailable catalog')
  const ids = new Set<string>()
  const models = fields.models.map(value => {
    const entry = object(value)
    const id = text(entry.id, 'model ID', 512)
    if (id !== id.trim() || ids.has(id)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Invalid or duplicate model ID: ${id}`)
    ids.add(id)
    for (const key of ['hidden', 'isDefault'] as const) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Invalid ${key}`)
    if (entry.efforts !== undefined && (!Array.isArray(entry.efforts) || entry.efforts.length > 32)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Invalid model efforts')
    const efforts = (entry.efforts as unknown[] | undefined)?.map(value => {
      const effort = object(value)
      return { id: parseEffort(effort.id), ...(effort.description === undefined ? {} : { description: text(effort.description, 'effort description', 2000) }) }
    })
    if (efforts && new Set(efforts.map(effort => effort.id)).size !== efforts.length) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', 'Duplicate effort IDs')
    const guidance = entry.guidance === undefined ? undefined : parseModelGuidance(entry.guidance)
    if (guidance?.recommendedEffort !== undefined && efforts && !efforts.some(effort => effort.id === guidance.recommendedEffort)) throw new HarnessSdkError('SWARM_INVALID_MODEL_CATALOG', `Unsupported recommended effort for ${id}`)
    return { id,
      ...(entry.name === undefined ? {} : { name: text(entry.name, 'model name', 512) }),
      ...(entry.description === undefined ? {} : { description: text(entry.description, 'model description', 4000) }),
      ...(entry.hidden === undefined ? {} : { hidden: entry.hidden as boolean }),
      ...(entry.isDefault === undefined ? {} : { isDefault: entry.isDefault as boolean }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(entry.defaultEffort === undefined ? {} : { defaultEffort: parseEffort(entry.defaultEffort) }),
      ...(entry.serviceTiers === undefined ? {} : { serviceTiers: texts(entry.serviceTiers, 'service tiers', 128) }),
      ...(entry.inputModalities === undefined ? {} : { inputModalities: texts(entry.inputModalities, 'input modalities', 128) }),
      ...(guidance === undefined ? {} : { guidance }),
    }
  })
  return { status: 'available', ...(policy ? { policy } : {}), ...(effortConfigKey ? { effortConfigKey } : {}), models }
}

/** Copy application data once so instruction rendering and execution share a stable snapshot. */
export function parseModelCatalog(value: SwarmModelCatalog | undefined, memberKeys: readonly string[] = []): SwarmModelCatalog {
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

/** Validate per-model facts when known; never guess a config mapping from model/adapter names. */
export function selectEffort(value: unknown, model: string | undefined, backend: MemberBackend): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'effort must be a nonempty exact backend effort ID of at most 128 characters')
  if (!backend.catalog?.effortConfigKey) throw new HarnessSdkError('SWARM_EFFORT_UNSUPPORTED', 'The selected backend has no configured effort mapping')
  const entry = backend.catalog.status === 'available' ? backend.catalog.models.find(entry => entry.id === model) : undefined
  if (entry?.efforts !== undefined && !entry.efforts.some(effort => effort.id === value)) throw new HarnessSdkError('SWARM_EFFORT_NOT_ALLOWED', `Effort "${value}" is not supported by model "${model}"`)
  return value
}

export function effortConfig(effort: string | undefined, backend: MemberBackend): { effort: string } | { thinkingLevel: string } | undefined {
  if (effort === undefined) return undefined
  if (backend.catalog?.effortConfigKey === 'effort') return { effort }
  if (backend.catalog?.effortConfigKey === 'thinkingLevel') return { thinkingLevel: effort }
  throw new HarnessSdkError('SWARM_EFFORT_UNSUPPORTED')
}

export function parseSelectionReason(value: unknown, backend: MemberBackend): string | undefined {
  const guided = backend.catalog?.status === 'available' && backend.catalog.models.some(model => !model.hidden && model.guidance)
  if (value === undefined && !guided) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'selectionReason is required when the backend has visible model guidance; supply a nonempty reason of at most 2000 characters, including for a backend-default fallback')
  return value
}

export function executionSelection(backend: MemberBackend, model: string | undefined, fixed: boolean, selectionReason?: string, effort?: string): BeeExecutionSelection {
  const guidance = backend.catalog?.status === 'available' ? backend.catalog.models.find(entry => entry.id === model)?.guidance : undefined
  return { backend: backend.client.identity, route: { ...backend.route }, ...(model === undefined ? {} : { requestedModel: model }), modelSource: model === undefined ? 'backend-default' : fixed ? 'profile' : 'bee',
    ...(effort === undefined ? {} : { requestedEffort: effort }), effortSource: effort === undefined ? 'backend-default' : fixed ? 'profile' : 'bee',
    ...(selectionReason === undefined ? {} : { selectionReason }),
    ...(guidance === undefined ? {} : { guidanceRevision: createHash('sha256').update(JSON.stringify(guidance)).digest('hex') }),
  }
}

function visibleCatalog(backend: MemberBackend) {
  const catalog = backend.catalog
  return { backend: backend.client.identity, route: backend.route, policy: catalog?.policy ?? 'recommend',
    ...(catalog?.effortConfigKey ? { effortConfigKey: catalog.effortConfigKey } : {}),
    ...(catalog?.status === 'available' ? { status: 'available', models: catalog.models.filter(model => !model.hidden) } : { status: 'unavailable' }),
  }
}

export function modelInstructions(defaultBackend: MemberBackend, memberBackends: readonly { key: string; backend: MemberBackend }[]): string {
  return JSON.stringify({ defaultBackend: visibleCatalog(defaultBackend), memberRoutes: memberBackends.map(({ key, backend }) => ({ key, ...visibleCatalog(backend) })) })
}
