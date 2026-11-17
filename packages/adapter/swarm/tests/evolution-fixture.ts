import { FileEvolutionStore, type ResolvedProfile, type TrustedValidator } from '../src/evolution'
import type { BeeProfile, HookContext, TurnSnapshot } from '../src'

export const profile: BeeProfile = { id: 'tester', name: 'Tester', description: 'Tests', instructions: 'Original', model: 'model' }
export const hookContext = (): HookContext => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 1000 })
export const turn = (id = 'turn'): TurnSnapshot => ({ sessionId: 'session', turnId: id, status: 'completed', assessments: [], tasks: [{ sessionId: 'session', turnId: id, taskId: 'task', beeId: 'bee', name: 'Tester', role: 'tester', profile, assignment: { task: 'Inspect', context: 'Repo', constraints: 'Read only', expectedOutput: 'Report' }, result: { status: 'completed', text: 'Report', items: [] } }] })
export const passing: TrustedValidator = { identity: { id: 'application-suite', version: '1' }, validate({ baseline, candidate }) { return { verdict: 'pass', baselineId: baseline.id, candidateId: candidate.id, suiteId: 'regressions-v1', evidence: [{ check: 'assertions', baseline: '2 passed', candidate: '3 passed', outcome: 'pass' }] } } }

export async function prepareValidation(store: FileEvolutionStore, baseline: ResolvedProfile, instructions = 'Improved', experiences: string[] = ['Cite test locations']) {
  const evidence = await store.appendEvidence({ kind: 'turn', value: turn() })
  const candidate = await store.saveRevision({ ...baseline.revision.profile, instructions }, experiences, baseline.revision.id)
  const proposal = await store.saveProposal({ profileId: profile.id, baselineId: baseline.revision.id, candidateId: candidate.id, evidenceIds: [evidence.id], rationale: 'Observed improvement' })
  const result = await passing.validate({ baseline: baseline.revision, candidate, proposal }, hookContext())
  const validation = await store.saveValidation({ proposalId: proposal.id, baselineId: baseline.revision.id, candidateId: candidate.id, validator: passing.identity, status: 'completed', result })
  return validation
}

export async function publish(store: FileEvolutionStore, baseline: ResolvedProfile, instructions = 'Improved', experiences: string[] = ['Cite test locations']) {
  const validation = await prepareValidation(store, baseline, instructions, experiences)
  return store.publish(profile.id, baseline.head.generation, validation.id)
}

