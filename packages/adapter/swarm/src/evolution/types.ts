import type { BeeProfile, BeeProfileReference, BeeProfileSource } from '../profiles'
import type { AssessmentSnapshot, HookContext, Immutable, SwarmHooks, TaskSnapshot, TurnSnapshot } from '../hooks'

export type EvidencePayload =
  | { kind: 'task'; value: Immutable<TaskSnapshot> }
  | { kind: 'assessment'; value: Immutable<AssessmentSnapshot> }
  | { kind: 'turn'; value: Immutable<TurnSnapshot> }
export type EvolutionEvidence = EvidencePayload & { id: string; schemaVersion: 1; scope: string }
export interface ProfileRevision {
  id: string; schemaVersion: 1; scope: string; profile: Immutable<BeeProfile>
  profileSource?: Immutable<BeeProfileSource>
  experiences: readonly string[]; parentId?: string
}
export interface EvolutionProposal {
  id: string; schemaVersion: 1; scope: string; profileId: string; baselineId: string
  profileSource?: Immutable<BeeProfileSource>
  candidateId: string; evidenceIds: readonly string[]; rationale: string
}
/** Application-authored proposal content; no sessions or permission configuration are exposed. */
export interface ProposedChange { instructions: string; experiences?: readonly string[]; rationale: string }
export interface ProposalInput { baseline: Immutable<ProfileRevision>; evidence: Immutable<EvolutionEvidence> }
export type EvolutionProposer = (input: ProposalInput, context: HookContext) => ProposedChange | undefined | Promise<ProposedChange | undefined>
export interface ValidationResult {
  verdict: 'pass' | 'fail' | 'inconclusive'
  baselineId: string; candidateId: string; suiteId: string
  evidence: readonly { check: string; baseline: string; candidate: string; outcome: 'pass' | 'fail' | 'inconclusive' }[]
}
/** Trust is supplied by the application, never inferred from task completion or agent acceptance. */
export interface TrustedValidator {
  identity: { id: string; version: string }
  validate(input: { baseline: Immutable<ProfileRevision>; candidate: Immutable<ProfileRevision>; proposal: Immutable<EvolutionProposal> }, context: HookContext): ValidationResult | Promise<ValidationResult>
}
export interface ValidationRecord {
  id: string; schemaVersion: 1; scope: string; proposalId: string; baselineId: string; candidateId: string
  validator: { id: string; version: string }
  status: 'completed' | 'error'; result?: Immutable<ValidationResult>; error?: string
}
export interface HeadTransition {
  id: string; schemaVersion: 1; scope: string; profileId: string; generation: number
  profileSource?: Immutable<BeeProfileSource>
  revisionId: string; previousId?: string; kind: 'seed' | 'publish' | 'rollback'
  reason: string; validationId?: string
}
export interface ResolvedProfile { head: Immutable<HeadTransition>; revision: Immutable<ProfileRevision> }
export type TransitionResult = { status: 'committed'; head: Immutable<HeadTransition> } | { status: 'conflict' }
export interface StoreContext { signal?: AbortSignal }
export interface EvolutionStore {
  readonly scope: string
  readRevision(id: string): Promise<Immutable<ProfileRevision>>
  appendEvidence(payload: EvidencePayload, context?: StoreContext): Promise<Immutable<EvolutionEvidence>>
  saveRevision(profile: BeeProfile, experiences?: readonly string[], parentId?: string, context?: StoreContext, source?: BeeProfileSource): Promise<Immutable<ProfileRevision>>
  saveProposal(value: Omit<EvolutionProposal, 'id' | 'scope' | 'schemaVersion'>, context?: StoreContext): Promise<Immutable<EvolutionProposal>>
  saveValidation(value: Omit<ValidationRecord, 'id' | 'scope' | 'schemaVersion'>, context?: StoreContext): Promise<Immutable<ValidationRecord>>
  seed(profile: BeeProfile, experiences?: readonly string[], context?: StoreContext, source?: BeeProfileSource): Promise<ResolvedProfile>
  resolve(profileId: BeeProfileReference): Promise<ResolvedProfile | undefined>
  publish(profileId: BeeProfileReference, expectedGeneration: number, validationId: string, context?: StoreContext): Promise<TransitionResult>
  rollback(profileId: BeeProfileReference, targetRevisionId: string, expectedGeneration: number, reason: string, context?: StoreContext): Promise<TransitionResult>
}
export interface EvolutionDiagnostic { operation: string; message: string }
export interface EvolutionOptions {
  store: EvolutionStore; proposer: EvolutionProposer; validator?: TrustedValidator
  concurrency?: number; maxQueue?: number; callbackTimeoutMs?: number
  onError?(value: Immutable<EvolutionDiagnostic>, context: HookContext): void | Promise<void>
}
export interface EvolutionController {
  readonly hooks: SwarmHooks
  readonly diagnostics: readonly Immutable<EvolutionDiagnostic>[]
  seed(profile: BeeProfile, experiences?: readonly string[], source?: BeeProfileSource): Promise<ResolvedProfile>
  resolve(profileId: BeeProfileReference): Promise<ResolvedProfile | undefined>
  rollback(profileId: BeeProfileReference, targetRevisionId: string, expectedGeneration: number, reason: string): Promise<TransitionResult>
  /** Await admitted work; does not stop admission. */
  drain(): Promise<void>
  /** Stop admission, cancel callbacks, discard queued work and await owned cleanup. Idempotent. */
  close(): Promise<void>
}
