import { bounded, snapshot, type HookContext, type Immutable, type SwarmHooks } from '../hooks'
import { profileReference, profileReferenceKey } from '../profiles'
import type { EvolutionController, EvolutionDiagnostic, EvolutionOptions, EvidencePayload, ProfileRevision, ProposedChange, ResolvedProfile, TransitionResult } from './types'

type Job = { run: () => Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 2000) : 'Evolution operation failed'

/** Application-composable background worker. It never receives or borrows member sessions. */
export function createEvolutionController(options: EvolutionOptions): EvolutionController {
  const { store, proposer, onError } = options
  const validator = options.validator && { identity: snapshot(options.validator.identity), validate: options.validator.validate.bind(options.validator) }
  const timeout = options.callbackTimeoutMs ?? 1000
  const concurrency = options.concurrency ?? 2
  const maxQueue = options.maxQueue ?? 64
  for (const [value, max] of [[timeout, 30_000], [concurrency, 32], [maxQueue, 10_000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('EVOLUTION_INVALID_LIMITS')
  }
  if (validator && (!validator.identity.id?.trim() || !validator.identity.version?.trim())) throw new Error('EVOLUTION_INVALID_VALIDATOR')
  const stop = new AbortController()
  const context = { signal: stop.signal }
  const queue: Job[] = []
  const pending = new Set<Promise<unknown>>()
  const diagnostics: Immutable<EvolutionDiagnostic>[] = []
  let active = 0
  let closed = false
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closed || stop.signal.aborted) throw new Error('EVOLUTION_CLOSED') }
  async function report(operation: string, error: unknown) {
    diagnostics.push(snapshot({ operation, message: message(error) }))
    if (diagnostics.length > 100) diagnostics.shift()
    if (onError) {
      try { await bounded(c => onError(diagnostics.at(-1)!, c), timeout) }
      catch (error) {
        diagnostics.push(snapshot({ operation: 'onError', message: message(error) }))
        if (diagnostics.length > 100) diagnostics.shift()
      }
    }
  }
  function pump() {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift()!
      active++
      void Promise.resolve().then(() => { assertOpen(); return job.run() }).then(job.resolve, async error => {
        await report('background', error)
        job.reject(error)
      }).finally(() => { active--; pump() })
    }
  }
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    assertOpen()
    if (queue.length >= maxQueue) throw new Error('EVOLUTION_QUEUE_FULL')
    const promise = new Promise<T>((resolve, reject) => { queue.push({ run, resolve: value => resolve(value as T), reject }) })
    pending.add(promise)
    // Always observe rejections, including fire-and-forget lifecycle evidence jobs.
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    pump()
    return promise
  }
  // Assignment resolution and administrative operations must not queue behind analysis callbacks.
  function ownedIO<T>(run: () => Promise<T>): Promise<T> {
    assertOpen()
    const promise = Promise.resolve().then(() => { assertOpen(); return run() })
    pending.add(promise)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  async function analyze(evidence: Awaited<ReturnType<typeof store.appendEvidence>>, baseline: ResolvedProfile) {
    assertOpen()
    const change = await bounded(c => proposer(snapshot({ baseline: baseline.revision, evidence }), c), timeout, stop.signal)
    assertOpen()
    if (!change) return
    const proposalValue = snapshot(change) as Immutable<ProposedChange>
    if (typeof proposalValue.instructions !== 'string' || !proposalValue.instructions.trim() || typeof proposalValue.rationale !== 'string' || !proposalValue.rationale.trim()) throw new Error('EVOLUTION_INVALID_PROPOSAL')
    const candidate = await store.saveRevision({ ...baseline.revision.profile, instructions: proposalValue.instructions }, proposalValue.experiences ?? baseline.revision.experiences, baseline.revision.id, context, baseline.revision.profileSource)
    assertOpen()
    if (profileReferenceKey({ id: candidate.profile.id, source: candidate.profileSource }) !== profileReferenceKey({ id: baseline.revision.profile.id, source: baseline.revision.profileSource })) throw new Error('EVOLUTION_PROFILE_SOURCE_MISMATCH')
    if (candidate.profile.instructions === baseline.revision.profile.instructions && JSON.stringify(candidate.experiences) === JSON.stringify(baseline.revision.experiences)) return
    const proposal = await store.saveProposal({ profileId: candidate.profile.id, profileSource: candidate.profileSource, baselineId: baseline.revision.id, candidateId: candidate.id, evidenceIds: [evidence.id], rationale: proposalValue.rationale }, context)
    if (!validator) return // Completion, acceptance and the proposer cannot authorize publication.
    const common = { proposalId: proposal.id, baselineId: baseline.revision.id, candidateId: candidate.id, validator: validator.identity }
    let validation: Awaited<ReturnType<typeof store.saveValidation>>
    try {
      const result = await bounded(c => validator.validate(snapshot({ baseline: baseline.revision, candidate, proposal }), c), timeout, stop.signal)
      assertOpen()
      validation = await store.saveValidation({ ...common, status: 'completed', result: snapshot(result) }, context)
    } catch (error) {
      // Timeout/invalid output is auditable but cannot authorize a head transition.
      if (!closed) await store.saveValidation({ ...common, status: 'error', error: message(error) }, context)
      throw error
    }
    assertOpen()
    if (validation.result?.verdict !== 'pass') return
    const reference = candidate.profileSource ? { id: candidate.profile.id, source: candidate.profileSource } : candidate.profile.id
    const transition = await store.publish(reference, baseline.head.generation, validation.id, context)
    if (transition.status === 'conflict') await report('publish', new Error('EVOLUTION_STALE_BASELINE'))
  }
  function collect(payload: EvidencePayload, hookContext?: HookContext) {
    assertOpen()
    if (hookContext?.signal.aborted) throw new Error('EVOLUTION_ABORTED')
    // Copy on admission, before returning control to the application.
    const owned = snapshot(payload)
    if (JSON.stringify(owned).length > 8 * 1024 * 1024) throw new Error('EVOLUTION_EVIDENCE_TOO_LARGE')
    enqueue(async () => {
      const evidence = await store.appendEvidence(owned, context)
      if (owned.kind !== 'turn') return
      const profiles = new Map<string, typeof owned.value.tasks[number]>()
      for (const task of owned.value.tasks) if (task.profile) profiles.set(profileReferenceKey({ id: task.profile.id, source: task.profileSource }) + ':' + (task.pin?.revisionId ?? 'source'), task)
      for (const task of profiles.values()) {
        assertOpen()
        const profile = task.profile!
        // An evolved task snapshot is never a configured source. Analyze exactly the
        // assignment's pinned revision; a newer head makes its publication CAS fail.
        const reference = task.profileSource ? { id: profile.id, source: task.profileSource } : profile.id
        const current = task.pin ? await store.resolve(reference) : await store.seed(profile, [], context, task.profileSource)
        if (!current) throw new Error('EVOLUTION_MISSING_BASELINE')
        const baseline = task.pin ? {
          revision: await store.readRevision(task.pin.revisionId),
          head: { ...current.head, id: task.pin.headId, generation: task.pin.generation, revisionId: task.pin.revisionId },
        } : current
        if (profileReferenceKey({ id: baseline.revision.profile.id, source: baseline.revision.profileSource }) !== profileReferenceKey(reference)) throw new Error('EVOLUTION_INVALID_PIN')
        await analyze(evidence, baseline)
      }
    })
  }
  const hooks: SwarmHooks = {
    afterTask: (value, c) => collect({ kind: 'task', value }, c),
    afterAssessment: (value, c) => collect({ kind: 'assessment', value }, c),
    afterTurn: (value, c) => collect({ kind: 'turn', value }, c),
  }
  async function drain() {
    while (pending.size) await Promise.allSettled([...pending])
  }
  return {
    hooks,
    get diagnostics() { return snapshot(diagnostics) },
    seed(profile, experiences, source) {
      const owned = snapshot(profile), experienceCopy = experiences && [...experiences], sourceCopy = source && snapshot(source)
      return ownedIO(async () => {
        const resolved = await store.seed(owned, experienceCopy, context, sourceCopy)
        if (profileReferenceKey({ id: resolved.revision.profile.id, source: resolved.revision.profileSource }) !== profileReferenceKey({ id: owned.id, source: sourceCopy })) throw new Error('EVOLUTION_PROFILE_SOURCE_MISMATCH')
        return resolved
      })
    },
    resolve(profileId) { const ref = typeof profileId === 'string' ? profileId : profileReference(profileId); return ownedIO(() => store.resolve(ref)) },
    rollback(profileId, targetRevisionId, expectedGeneration, reason) {
      const ref = typeof profileId === 'string' ? profileId : profileReference(profileId)
      return ownedIO(() => store.rollback(ref, targetRevisionId, expectedGeneration, reason, context))
    },
    drain,
    close() {
      if (closing) return closing
      closed = true
      stop.abort()
      for (const job of queue.splice(0)) job.reject(new Error('EVOLUTION_CLOSED'))
      return closing = drain()
    },
  }
}

/** Convenience for composing these handlers with an application's other lifecycle hooks. */
export function createEvolutionHooks(controller: EvolutionController): SwarmHooks { return controller.hooks }
