import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, open, link, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseBeeProfile, isBeeId, parseProfileSource, profileReference, profileReferenceKey, type BeeProfile, type BeeProfileReference, type BeeProfileSource } from '../profiles'
import { snapshot, type Immutable } from '../hooks'
import type { EvolutionEvidence, EvolutionProposal, EvolutionStore, EvidencePayload, HeadTransition, ProfileRevision, ResolvedProfile, StoreContext, TransitionResult, ValidationRecord } from './types'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error('EVOLUTION_INVALID_RECORD')
  return result
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const check = (context?: StoreContext) => { if (context?.signal?.aborted) throw new Error('EVOLUTION_ABORTED') }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const exists = (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'
function text(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new Error('EVOLUTION_INVALID_RECORD') }
function profileId(value: string) { if (!isBeeId(value)) throw new Error('EVOLUTION_INVALID_PROFILE_ID'); return value }
function recordId(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('EVOLUTION_INVALID_RECORD_ID'); return value }
export interface FileEvolutionStoreOptions {
  /** Caller-owned storage directory. Source profile files are never touched. */
  directory: string
  /** Explicit application/project namespace, isolated inside directory. */
  scope: string
}

/** Immutable content-addressed records plus an atomic, append-only head journal.
 * No mutable head file: linking one complete transition is the commit point.
 * Exclusive installation of generation G+1 supplies cross-process generation CAS.
 */
export class FileEvolutionStore implements EvolutionStore {
  readonly scope: string
  readonly directory: string
  constructor(options: FileEvolutionStoreOptions) {
    text(options.directory); text(options.scope)
    this.scope = options.scope
    this.directory = resolve(options.directory, hash(options.scope))
  }
  private path(kind: string, id: string) { return join(this.directory, kind, recordId(id) + '.json') }
  private async write<T extends object>(kind: string, value: T, context?: StoreContext): Promise<Immutable<T & { id: string }>> {
    check(context)
    const normalized = JSON.parse(canonical(value)) as T
    const record = { ...normalized, id: hash(normalized) }
    await this.atomic(this.path(kind, record.id), canonical(record), context)
    return snapshot(record)
  }
  private async atomic(file: string, content: string, context?: StoreContext, exclusive = false): Promise<boolean> {
    check(context)
    const temporary = file + '.' + randomUUID() + '.tmp'
    await mkdir(resolve(file, '..'), { recursive: true })
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(content); await handle.sync(); await handle.close()
      check(context)
      try { await link(temporary, file) }
      catch (error) {
        if (!exists(error)) throw error
        // Journal CAS is strict even when competing transitions are identical.
        if (exclusive) return false
        if (await readFile(file, 'utf8') !== content) throw new Error('EVOLUTION_IMMUTABLE_CONFLICT')
      }
      return true
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
  }
  private async read<T extends { id: string; scope: string; schemaVersion: number }>(kind: string, id: string): Promise<Immutable<T>> {
    const value = JSON.parse(await readFile(this.path(kind, id), 'utf8')) as T
    const { id: storedId, ...body } = value
    if (storedId !== id || hash(body) !== id || value.scope !== this.scope || value.schemaVersion !== 1) throw new Error('EVOLUTION_CORRUPT_RECORD')
    return snapshot(value)
  }
  readRevision(id: string) { return this.read<ProfileRevision>('revisions', id) }
  readEvidence(id: string) { return this.read<EvolutionEvidence>('evidence', id) }
  readProposal(id: string) { return this.read<EvolutionProposal>('proposals', id) }
  readValidation(id: string) { return this.read<ValidationRecord>('validations', id) }
  async listIds(kind: 'evidence' | 'proposals' | 'validations' | 'revisions'): Promise<string[]> {
    const files = await readdir(join(this.directory, kind)).catch(error => { if (missing(error)) return []; throw error })
    return files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => file.slice(0, -5)).sort()
  }
  appendEvidence(payload: EvidencePayload, context?: StoreContext) {
    if (!['task', 'assessment', 'turn'].includes(payload.kind)) throw new Error('EVOLUTION_INVALID_EVIDENCE')
    return this.write('evidence', { ...payload, schemaVersion: 1 as const, scope: this.scope }, context)
  }
  async saveRevision(profile: BeeProfile, experiences: readonly string[] = [], parentId?: string, context?: StoreContext, source?: BeeProfileSource) {
    if (!Array.isArray(experiences) || experiences.length > 100) throw new Error('EVOLUTION_INVALID_EXPERIENCES')
    experiences.forEach(text)
    let profileSource = source && parseProfileSource(source)
    if (parentId) {
      const parent = await this.readRevision(parentId)
      if (parent.profile.id !== profile.id || (profileSource && profileReferenceKey({ id: profile.id, source: profileSource }) !== profileReferenceKey({ id: parent.profile.id, source: parent.profileSource }))) throw new Error('EVOLUTION_INVALID_REVISION')
      profileSource ??= parent.profileSource
    }
    return this.write('revisions', { schemaVersion: 1 as const, scope: this.scope, profile: parseBeeProfile(profile), ...(profileSource ? { profileSource } : {}), experiences: [...experiences], ...(parentId ? { parentId } : {}) }, context)
  }
  async saveProposal(value: Omit<EvolutionProposal, 'id' | 'scope' | 'schemaVersion'>, context?: StoreContext) {
    profileId(value.profileId); text(value.rationale)
    const baseline = await this.readRevision(value.baselineId), candidate = await this.readRevision(value.candidateId)
    if (baseline.profile.id !== value.profileId || candidate.profile.id !== value.profileId || candidate.parentId !== baseline.id) throw new Error('EVOLUTION_INVALID_PROPOSAL')
    const key = profileReferenceKey({ id: value.profileId, source: baseline.profileSource })
    if (key !== profileReferenceKey({ id: candidate.profile.id, source: candidate.profileSource }) ||
        (value.profileSource && key !== profileReferenceKey({ id: value.profileId, source: value.profileSource }))) throw new Error('EVOLUTION_INVALID_PROPOSAL')
    if (!value.evidenceIds.length) throw new Error('EVOLUTION_MISSING_EVIDENCE')
    await Promise.all(value.evidenceIds.map(id => this.readEvidence(id)))
    return this.write('proposals', { ...value, profileSource: baseline.profileSource, schemaVersion: 1 as const, scope: this.scope }, context)
  }
  async saveValidation(value: Omit<ValidationRecord, 'id' | 'scope' | 'schemaVersion'>, context?: StoreContext) {
    const proposal = await this.readProposal(value.proposalId)
    text(value.validator.id); text(value.validator.version)
    if (value.baselineId !== proposal.baselineId || value.candidateId !== proposal.candidateId) throw new Error('EVOLUTION_INVALID_VALIDATION')
    if (value.status === 'completed') {
      const result = value.result
      if (!result || result.baselineId !== value.baselineId || result.candidateId !== value.candidateId || !['pass', 'fail', 'inconclusive'].includes(result.verdict)) throw new Error('EVOLUTION_INVALID_VALIDATION')
      text(result.suiteId)
      if (!Array.isArray(result.evidence) || result.evidence.length === 0 || result.evidence.length > 1000) throw new Error('EVOLUTION_MISSING_VALIDATION_EVIDENCE')
      for (const item of result.evidence) {
        text(item.check); text(item.baseline); text(item.candidate)
        if (!['pass', 'fail', 'inconclusive'].includes(item.outcome) || result.verdict === 'pass' && item.outcome !== 'pass') throw new Error('EVOLUTION_INVALID_VALIDATION')
      }
    } else if (value.status !== 'error' || !value.error || value.result) throw new Error('EVOLUTION_INVALID_VALIDATION')
    return this.write('validations', { ...value, schemaVersion: 1 as const, scope: this.scope }, context)
  }
  private headDirectory(reference: BeeProfileReference) {
    const { id, source } = profileReference(reference)
    return source ? join(this.directory, 'heads', 'scoped', hash(source), id) : join(this.directory, 'heads', id)
  }
  async history(reference: BeeProfileReference): Promise<Immutable<HeadTransition>[]> {
    const { id } = profileReference(reference)
    const directory = this.headDirectory(reference)
    const names = (await readdir(directory).catch(error => { if (missing(error)) return []; throw error })).filter(name => /^\d{16}\.json$/.test(name)).sort()
    const records: Immutable<HeadTransition>[] = []
    for (const name of names) {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as HeadTransition
      const { id: storedId, ...body } = value
      if (name !== String(records.length + 1).padStart(16, '0') + '.json' || hash(body) !== storedId || value.scope !== this.scope || value.schemaVersion !== 1 || value.profileId !== id || value.generation !== records.length + 1 || value.previousId !== records.at(-1)?.id) throw new Error('EVOLUTION_CORRUPT_HISTORY')
      if (profileReferenceKey(reference) !== profileReferenceKey({ id: value.profileId, source: value.profileSource })) throw new Error('EVOLUTION_CORRUPT_HISTORY')
      records.push(snapshot(value))
    }
    return records
  }
  async resolve(reference: BeeProfileReference): Promise<ResolvedProfile | undefined> {
    const { id } = profileReference(reference)
    const head = (await this.history(reference)).at(-1)
    if (!head) return
    const revision = await this.readRevision(head.revisionId)
    if (revision.profile.id !== id || profileReferenceKey(reference) !== profileReferenceKey({ id, source: revision.profileSource })) throw new Error('EVOLUTION_CORRUPT_HISTORY')
    return { head, revision }
  }
  async seed(profile: BeeProfile, experiences: readonly string[] = [], context?: StoreContext, origin?: BeeProfileSource): Promise<ResolvedProfile> {
    const reference = profileReference({ id: profile.id, source: origin })
    let current = await this.resolve(reference)
    if (!current && reference.source && await this.resolve(profile.id)) throw new Error(`EVOLUTION_LEGACY_PROFILE_REQUIRES_MIGRATION: @${profile.id} has unscoped history. Use a new store scope/directory or explicitly migrate its origin before selecting a scoped profile.`)
    const revision = await this.saveRevision(profile, experiences, undefined, context, reference.source)
    if (!current) {
      const head = await this.transition(reference, undefined, revision.id, 'seed', 'Application baseline', undefined, context)
      if (head) return { head, revision }
      // Another seeder installed generation 1. Never accept its source blindly.
      current = await this.resolve(reference)
      if (!current) throw new Error('EVOLUTION_CORRUPT_HISTORY')
    }
    // Compare against the original configured source, not the evolved head.
    let source = current.revision
    const seen = new Set<string>()
    while (source.parentId) {
      if (seen.has(source.id) || seen.size >= 10_000) throw new Error('EVOLUTION_CORRUPT_REVISION_CHAIN')
      seen.add(source.id)
      source = await this.readRevision(source.parentId)
      if (profileReferenceKey(reference) !== profileReferenceKey({ id: source.profile.id, source: source.profileSource })) throw new Error('EVOLUTION_CORRUPT_REVISION_CHAIN')
    }
    if (canonical(source.profile) !== canonical(parseBeeProfile(profile))) throw new Error(`EVOLUTION_SOURCE_PROFILE_MISMATCH: @${profile.id} differs from the stored configured baseline. Use a new scope/directory or explicitly migrate and validate the human-edited profile; source files were not changed.`)
    return current
  }
  async publish(reference: BeeProfileReference, expectedGeneration: number, validationId: string, context?: StoreContext): Promise<TransitionResult> {
    const { id } = profileReference(reference)
    const current = await this.resolve(reference)
    if (!current || current.head.generation !== expectedGeneration) return { status: 'conflict' }
    const validation = await this.readValidation(validationId)
    if (validation.status !== 'completed' || validation.result?.verdict !== 'pass' || validation.baselineId !== current.revision.id) return { status: 'conflict' }
    const proposal = await this.readProposal(validation.proposalId)
    if (proposal.profileId !== id || proposal.candidateId !== validation.candidateId || profileReferenceKey(reference) !== profileReferenceKey({ id, source: proposal.profileSource })) throw new Error('EVOLUTION_INVALID_VALIDATION')
    const candidate = await this.readRevision(validation.candidateId)
    if (candidate.parentId !== current.revision.id || profileReferenceKey(reference) !== profileReferenceKey({ id: candidate.profile.id, source: candidate.profileSource })) throw new Error('EVOLUTION_INVALID_REVISION')
    const head = await this.transition(reference, current.head, candidate.id, 'publish', proposal.rationale, validation.id, context)
    return head ? { status: 'committed', head } : { status: 'conflict' }
  }
  async rollback(reference: BeeProfileReference, targetRevisionId: string, expectedGeneration: number, reason: string, context?: StoreContext): Promise<TransitionResult> {
    text(reason)
    const current = await this.resolve(reference)
    if (!current || current.head.generation !== expectedGeneration) return { status: 'conflict' }
    if (!(await this.history(reference)).some(head => head.revisionId === targetRevisionId)) throw new Error('EVOLUTION_ROLLBACK_NOT_ACCEPTED')
    await this.readRevision(targetRevisionId)
    const head = await this.transition(reference, current.head, targetRevisionId, 'rollback', reason, undefined, context)
    return head ? { status: 'committed', head } : { status: 'conflict' }
  }
  private async transition(reference: BeeProfileReference, previous: Immutable<HeadTransition> | undefined, revisionId: string, kind: HeadTransition['kind'], reason: string, validationId?: string, context?: StoreContext) {
    const { id: profileId, source: profileSource } = profileReference(reference)
    const body = { schemaVersion: 1 as const, scope: this.scope, profileId, ...(profileSource ? { profileSource } : {}), generation: (previous?.generation ?? 0) + 1, revisionId, kind, reason, ...(previous ? { previousId: previous.id } : {}), ...(validationId ? { validationId } : {}) }
    const record = { ...body, id: hash(body) }
    if (!Number.isSafeInteger(record.generation)) throw new Error('EVOLUTION_INVALID_GENERATION')
    const installed = await this.atomic(join(this.headDirectory(reference), String(record.generation).padStart(16, '0') + '.json'), canonical(record), context, true)
    return installed ? snapshot(record) : undefined
  }
}
