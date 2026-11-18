import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { FileEvolutionStore, createEvolutionController, type ValidationResult, type TransitionResult } from '../src/evolution'

import { profile, hookContext, turn, passing, publish, prepareValidation } from './evolution-fixture'

async function temporary(run: (directory: string, store: FileEvolutionStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-evolution-'))
  try { await run(directory, new FileEvolutionStore({ directory, scope: 'project' })) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('same-ID origins and project namespaces publish and roll back independently across restart', () => temporary(async (directory, store) => {
  const sources = [
    { scope: 'user' as const, namespace: '/home' },
    { scope: 'project' as const, namespace: '/repo-a' },
    { scope: 'project' as const, namespace: '/repo-b' },
  ]
  const controller = createEvolutionController({ store, proposer: ({ baseline }) => ({ instructions: `Improved ${baseline.profileSource!.namespace}`, rationale: 'Compared suite' }), validator: passing })
  try {
    const baselines = await Promise.all(sources.map(source => controller.seed(profile, [], source)))
    expect(new Set(baselines.map(value => value.revision.id)).size).toBe(3)
    const baseTask = turn().tasks[0]
    const tasks = sources.map((source, i) => ({ ...baseTask, taskId: `task-${i}`, profileSource: source,
      pin: { revisionId: baselines[i].revision.id, headId: baselines[i].head.id, generation: baselines[i].head.generation },
    }))
    controller.hooks.afterTurn!({ ...turn(), tasks }, hookContext())
    await controller.drain()
    expect(controller.diagnostics).toEqual([])
    expect(await store.listIds('proposals')).toHaveLength(3)
    const restarted = new FileEvolutionStore({ directory, scope: 'project' })
    for (const source of sources) {
      const ref = { id: profile.id, source }
      const value = (await restarted.resolve(ref))!
      expect(value.head.generation).toBe(2)
      expect(value.revision.profile.instructions).toBe(`Improved ${source.namespace}`)
      expect(value.revision.profileSource).toEqual(source)
      expect((await restarted.seed(profile, [], undefined, source)).revision.id).toBe(value.revision.id)
    }
    const ref = { id: profile.id, source: sources[0] }
    await expect(store.rollback(ref, baselines[1].revision.id, 2, 'Wrong origin')).rejects.toThrow('EVOLUTION_ROLLBACK_NOT_ACCEPTED')
    expect((await controller.rollback(ref, baselines[0].revision.id, 2, 'Restore user only')).status).toBe('committed')
    expect((await controller.resolve(ref))!.head.generation).toBe(3)
    expect((await controller.resolve({ id: profile.id, source: sources[1] }))!.head.generation).toBe(2)
    expect((await controller.resolve({ id: profile.id, source: sources[2] }))!.head.generation).toBe(2)
    await expect(store.saveRevision(profile, [], baselines[0].revision.id, undefined, sources[1])).rejects.toThrow('EVOLUTION_INVALID_REVISION')
  } finally { await controller.close() }
}))

test('scoped seed rejects ambiguous legacy history while legacy callers remain compatible', () => temporary(async (_directory, store) => {
  const legacy = await store.seed(profile)
  await expect(store.seed(profile, [], undefined, { scope: 'user' })).rejects.toThrow('EVOLUTION_LEGACY_PROFILE_REQUIRES_MIGRATION')
  expect((await store.seed(profile)).revision.id).toBe(legacy.revision.id)
  expect(await store.resolve({ id: profile.id, source: { scope: 'user' } })).toBeUndefined()
}))

test('controller rejects custom stores that silently discard requested origin metadata', () => temporary(async (_directory, store) => {
  const seed = store.seed.bind(store)
  store.seed = (value, experiences, context) => seed(value, experiences, context)
  const controller = createEvolutionController({ store, proposer: () => undefined })
  try {
    await expect(controller.seed(profile, [], { scope: 'project' })).rejects.toThrow('EVOLUTION_PROFILE_SOURCE_MISMATCH')
  } finally { await controller.close() }
}))

test('legacy string-based custom stores keep receiving string references', () => temporary(async (_directory, store) => {
  const legacy = new Proxy(store, { get(target, property) {
    const member = Reflect.get(target, property)
    if (typeof member !== 'function') return member
    return (...args: unknown[]) => {
      if (['resolve', 'publish', 'rollback'].includes(String(property))) expect(typeof args[0]).toBe('string')
      return member.apply(target, args)
    }
  } })
  const controller = createEvolutionController({ store: legacy, proposer: () => ({ instructions: 'Improved', rationale: 'Compared suite' }), validator: passing })
  try {
    const baseline = await controller.seed(profile)
    controller.hooks.afterTurn!(turn(), hookContext())
    await controller.drain()
    expect(controller.diagnostics).toEqual([])
    expect((await controller.resolve(profile.id))!.head.generation).toBe(2)
    expect((await controller.rollback(profile.id, baseline.revision.id, 2, 'Restore')).status).toBe('committed')
  } finally { await controller.close() }
}))

test('proposal-only hooks persist immutable evidence and proposals without accepting completion', () => temporary(async (_directory, store) => {
  const controller = createEvolutionController({ store, proposer({ baseline, evidence }) {
    expect(Object.isFrozen(evidence)).toBe(true)
    return { instructions: baseline.profile.instructions + '\nImproved', rationale: 'Evidence' }
  } })
  try {
    const value = { ...turn(), tasks: [...turn().tasks] }
    controller.hooks.afterTask!(value.tasks[0], hookContext())
    controller.hooks.afterTurn!(value, hookContext())
    value.tasks.length = 0
    await controller.drain()
    expect(await store.listIds('evidence')).toHaveLength(2)
    expect(await store.listIds('proposals')).toHaveLength(1)
    expect(await store.listIds('validations')).toHaveLength(0)
    expect((await store.resolve(profile.id))?.head.generation).toBe(1)
    expect((await store.readEvidence((await store.listIds('evidence'))[0])).scope).toBe('project')
  } finally { await controller.close() }
}))

test('passing validator auto-publishes; restart and rollback preserve monotonic history', () => temporary(async (directory, store) => {
  const source = join(directory, 'source.json')
  await writeFile(source, JSON.stringify(profile))
  const controller = createEvolutionController({ store, proposer: () => ({ instructions: 'Improved', rationale: 'Compared suite', experiences: ['Lesson'] }), validator: passing })
  const baseline = await controller.seed(profile)
  controller.hooks.afterTurn!(turn(), hookContext())
  await controller.drain()
  const accepted = (await controller.resolve(profile.id))!
  expect(accepted.head.generation).toBe(2)
  expect(accepted.revision.experiences).toEqual(['Lesson'])
  await controller.close()
  const restarted = new FileEvolutionStore({ directory, scope: 'project' })
  expect((await restarted.seed(profile)).revision.id).toBe(accepted.revision.id)
  expect((await restarted.rollback(profile.id, baseline.revision.id, 2, 'Regression found')).status).toBe('committed')
  expect((await restarted.resolve(profile.id))?.head.generation).toBe(3)
  expect((await restarted.rollback(profile.id, accepted.revision.id, 2, 'Stale')).status).toBe('conflict')
  expect((await restarted.history(profile.id)).map(h => h.kind)).toEqual(['seed', 'publish', 'rollback'])
  expect(await Bun.file(source).json()).toEqual(profile)
}))

test('fail, inconclusive and incorrectly bound validator results never publish', () => temporary(async (_directory, store) => {
  for (const verdict of ['fail', 'inconclusive', 'mismatch'] as const) {
    const controller = createEvolutionController({ store, proposer: () => ({ instructions: 'Candidate ' + verdict, rationale: verdict }), validator: { identity: passing.identity, async validate(input, context) {
      const result = await passing.validate(input, context)
      return { ...result, verdict: verdict === 'mismatch' ? 'pass' : verdict, candidateId: verdict === 'mismatch' ? '0'.repeat(64) : input.candidate.id, evidence: result.evidence.map(e => ({ ...e, outcome: verdict === 'mismatch' ? 'pass' : verdict })) }
    } } })
    controller.hooks.afterTurn!(turn(verdict), hookContext())
    await controller.drain()
    expect((await store.resolve(profile.id))?.head.generation).toBe(1)
    if (verdict === 'mismatch') expect(controller.diagnostics.length).toBeGreaterThan(0)
    await controller.close()
  }
  expect(await store.listIds('validations')).toHaveLength(3)
}))

test('competing publishers use CAS; a rollback cannot revive stale generation', () => temporary(async (_directory, store) => {
  const baseline = await store.seed(profile)
  const results = await Promise.all([publish(store, baseline, 'Candidate A'), publish(new FileEvolutionStore({ directory: join(store.directory, '..'), scope: 'project' }), baseline, 'Candidate B')])
  expect(results.map(r => r.status).sort()).toEqual(['committed', 'conflict'])
  const head = (await store.resolve(profile.id))!
  await store.rollback(profile.id, baseline.revision.id, head.head.generation, 'Restore baseline')
  expect((await publish(store, baseline, 'Stale')).status).toBe('conflict')
  expect((await store.resolve(profile.id))?.head.generation).toBe(3)
}))

test('source edits fail closed; record hashes do not call localeCompare', () => temporary(async (_directory, store) => {
  await store.seed(profile)
  for (const changes of [{ instructions: 'Human edit' }, { name: 'Human name' }, { model: 'Human model' }]) {
    await expect(store.seed({ ...profile, ...changes })).rejects.toThrow('EVOLUTION_SOURCE_PROFILE_MISMATCH')
  }
  expect((await store.resolve(profile.id))?.head.generation).toBe(1)
  const original = String.prototype.localeCompare
  String.prototype.localeCompare = () => { throw new Error('Locale-dependent hash') }
  try {
    expect((await store.seed(profile)).head.generation).toBe(1)
    const a = await store.appendEvidence({ kind: 'turn', value: { ...turn(), ...{ '\u00e4': 1, Z: 2 } } })
    const reordered = { Z: 2, '\u00e4': 1, ...turn() }
    const b = await store.appendEvidence({ kind: 'turn', value: reordered })
    expect(a.id).toBe(b.id)
  } finally { String.prototype.localeCompare = original }
}))

test('closing cancels validator and suppresses its late passing result', () => temporary(async (_directory, store) => {
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let release!: (value: ValidationResult) => void
  let pass!: ValidationResult
  const gate = new Promise<ValidationResult>(resolve => { release = resolve })
  const controller = createEvolutionController({ store, proposer: () => ({ instructions: 'Late', rationale: 'Late' }), validator: { identity: passing.identity, async validate(input, context) { pass = await passing.validate(input, context); entered(); return gate } } })
  controller.hooks.afterTurn!(turn(), hookContext())
  await ready
  await controller.close()
  release(pass)
  await Promise.resolve()
  expect((await store.resolve(profile.id))?.head.generation).toBe(1)
  expect(() => controller.hooks.afterTurn!(turn(), hookContext())).toThrow('EVOLUTION_CLOSED')
}))

test('background proposer may resolve with concurrency one without deadlock', () => temporary(async (_directory, store) => {
  const controller = createEvolutionController({ store, concurrency: 1, proposer: async () => {
    expect((await controller.resolve(profile.id))?.head.generation).toBe(1)
    return undefined
  } })
  controller.hooks.afterTurn!(turn(), hookContext())
  await controller.drain()
  expect(controller.diagnostics).toEqual([])
  await controller.close()
}))

test('pinned evidence uses its revision after publication and never reseeds evolved instructions', () => temporary(async (_directory, store) => {
  const original = await store.seed(profile)
  await publish(store, original)
  const evolved = (await store.resolve(profile.id))!
  const analyzed: string[] = []
  const controller = createEvolutionController({ store, validator: passing, proposer({ baseline }) {
    analyzed.push(baseline.id)
    return { instructions: baseline.profile.instructions + ' next', rationale: 'Pinned comparison' }
  } })
  for (const baseline of [evolved, original]) {
    const value = turn(baseline.revision.id)
    const task = value.tasks[0]
    controller.hooks.afterTurn!({ ...value, tasks: [{ ...task, profile: baseline.revision.profile, pin: {
      revisionId: baseline.revision.id, generation: baseline.head.generation, headId: baseline.head.id,
    } }] }, hookContext())
    await controller.drain()
  }
  expect(analyzed).toEqual([evolved.revision.id, original.revision.id])
  expect((await store.resolve(profile.id))!.head.generation).toBe(3)
  expect(controller.diagnostics.some(d => d.message === 'EVOLUTION_STALE_BASELINE')).toBe(true)
  await controller.close()
}))

test('slow analysis cannot starve seed/resolve; overflow and callback failures are observable', () => temporary(async (_directory, store) => {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  const controller = createEvolutionController({ store, concurrency: 1, maxQueue: 1, callbackTimeoutMs: 500,
    proposer: async () => { entered(); await gate; throw new Error('Proposer failed') },
    onError: () => { throw new Error('Diagnostic callback failed') },
  })
  controller.hooks.afterTurn!(turn(), hookContext())
  await ready
  const baseline = await controller.seed(profile)
  expect((await controller.resolve(profile.id))!.revision.id).toBe(baseline.revision.id)
  controller.hooks.afterTask!(turn().tasks[0], hookContext())
  expect(() => controller.hooks.afterTask!(turn().tasks[0], hookContext())).toThrow('EVOLUTION_QUEUE_FULL')
  release()
  await controller.drain()
  expect(controller.diagnostics.map(d => d.operation)).toEqual(['background', 'onError'])
  await controller.close()
}))

test('corrupt revision fails closed', () => temporary(async (_directory, store) => {
  const baseline = await store.seed(profile)
  await writeFile(join(store.directory, 'revisions', baseline.revision.id + '.json'), '{}')
  await expect(store.resolve(profile.id)).rejects.toThrow('EVOLUTION_CORRUPT_RECORD')
}))

test('validator errors and deadlines persist audit records without publication', () => temporary(async (_directory, store) => {
  for (const mode of ['throw', 'timeout']) {
    const controller = createEvolutionController({ store, callbackTimeoutMs: 30,
      proposer: () => ({ instructions: 'Candidate ' + mode, rationale: mode }),
      validator: { identity: passing.identity, validate() {
        if (mode === 'throw') throw new Error('Suite unavailable')
        return new Promise<ValidationResult>(() => {})
      } },
    })
    controller.hooks.afterTurn!(turn(mode), hookContext())
    await controller.drain()
    expect((await store.resolve(profile.id))!.head.generation).toBe(1)
    expect(controller.diagnostics).toHaveLength(1)
    await controller.close()
  }
  const validations = await Promise.all((await store.listIds('validations')).map(id => store.readValidation(id)))
  expect(validations).toHaveLength(2)
  expect(validations.every(v => v.status === 'error')).toBe(true)
}))

test('legacy markers and orphan temporary records never block seed, publication or restart', () => temporary(async (directory, store) => {
  await mkdir(join(store.directory, '.lock'), { recursive: true })
  await writeFile(join(store.directory, '.lock', 'owner.json'), 'malformed legacy owner')
  await mkdir(join(store.directory, '.recovery'))
  await writeFile(join(store.directory, '.recovery', 'orphan'), 'legacy recovery marker')
  const heads = join(store.directory, 'heads', profile.id)
  await mkdir(heads, { recursive: true })
  await writeFile(join(heads, '0000000000000001.json.crashed.tmp'), 'partial')
  const baseline = await store.seed(profile)
  const orphan = await store.saveRevision({ ...profile, instructions: 'Unpublished orphan' })
  await writeFile(join(store.directory, 'revisions', orphan.id + '.json.crashed.tmp'), 'partial')
  expect((await publish(store, baseline)).status).toBe('committed')
  const restarted = new FileEvolutionStore({ directory, scope: 'project' })
  expect((await restarted.seed(profile)).head.generation).toBe(2)
  expect(await restarted.history(profile.id)).toHaveLength(2)
  expect(await readFile(join(store.directory, '.lock', 'owner.json'), 'utf8')).toBe('malformed legacy owner')
  expect(await readFile(join(store.directory, '.recovery', 'orphan'), 'utf8')).toBe('legacy recovery marker')
  expect((await restarted.rollback(profile.id, baseline.revision.id, 2, 'Restore')).status).toBe('committed')
  const fileMarkers = new FileEvolutionStore({ directory, scope: 'file-markers' })
  await mkdir(fileMarkers.directory)
  for (const marker of ['.lock', '.recovery']) await writeFile(join(fileMarkers.directory, marker), 'legacy file')
  expect((await publish(fileMarkers, await fileMarkers.seed(profile))).status).toBe('committed')
  for (const marker of ['.lock', '.recovery']) expect(await readFile(join(fileMarkers.directory, marker), 'utf8')).toBe('legacy file')
}))

test('concurrent seeds reload the winner and reject changed source profiles', () => temporary(async (directory) => {
  for (const changed of [false, true]) {
    let arrivals = 0, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    class SeedRace extends FileEvolutionStore {
      private observed = false
      override async resolve(id: string) {
        const value = await super.resolve(id)
        if (!this.observed) {
          this.observed = true
          if (++arrivals === 2) release()
          await gate
        }
        return value
      }
    }
    const options = { directory, scope: 'seed-' + changed }
    const a = new SeedRace(options), b = new SeedRace(options)
    const results = await Promise.allSettled([a.seed(profile), b.seed(changed ? { ...profile, instructions: 'Human source edit' } : profile)])
    const winner = (await new FileEvolutionStore(options).resolve(profile.id))!
    expect(await a.history(profile.id)).toHaveLength(1)
    if (!changed) {
      expect(results.every(r => r.status === 'fulfilled' && r.value.revision.id === winner.revision.id)).toBe(true)
    } else {
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult
      expect(loser.reason.message).toContain('EVOLUTION_SOURCE_PROFILE_MISMATCH')
    }
  }
}))

async function processRace(directory: string, generation: number, operations: { mode: 'publish' | 'rollback'; targetId: string }[]) {
  const worker = fileURLToPath(new URL('./journal-race-worker.ts', import.meta.url))
  const children = operations.map(({ mode, targetId }) => {
    const child = spawn(process.execPath, [worker, directory, mode, profile.id, String(generation), targetId], { stdio: ['pipe', 'pipe', 'pipe'] })
    let result: TransitionResult | undefined, stderr = ''
    let admit!: (value: number) => void, rejectReady!: (error: Error) => void
    const ready = new Promise<number>((resolve, reject) => { admit = resolve; rejectReady = reject })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      const value = JSON.parse(line)
      if (value.ready) admit(value.generation)
      if (value.result) result = value.result
    })
    child.stderr.on('data', chunk => { stderr += chunk })
    const done = new Promise<TransitionResult>((resolve, reject) => {
      child.once('error', error => { rejectReady(error); reject(error) })
      child.once('close', code => {
        if (code === 0 && result) resolve(result)
        else {
          const error = new Error(`CAS child exited ${code}: ${stderr}`)
          rejectReady(error); reject(error)
        }
      })
    })
    // Observe failures even before the parent has finished waiting for readiness.
    void done.catch(() => {})
    const timer = setTimeout(() => child.kill(), 10_000)
    return { child, ready, done, timer, lines }
  })
  try {
    expect(await Promise.all(children.map(c => c.ready))).toEqual(operations.map(() => generation))
    for (const { child } of children) child.stdin.end('go\n')
    return await Promise.all(children.map(c => c.done))
  } finally {
    for (const c of children) { clearTimeout(c.timer); c.child.kill(); c.lines.close() }
    await Promise.allSettled(children.map(c => c.done))
  }
}

test('independent processes enforce strict CAS for identical publishes and publish versus rollback', () => temporary(async (directory, store) => {
  const baseline = await store.seed(profile)
  const validation = await prepareValidation(store, baseline)
  const identical = await processRace(directory, 1, [
    { mode: 'publish', targetId: validation.id }, { mode: 'publish', targetId: validation.id },
  ])
  expect(identical.map(r => r.status).sort()).toEqual(['committed', 'conflict'])
  const evolved = (await store.resolve(profile.id))!
  expect(evolved.head.generation).toBe(2)
  const next = await prepareValidation(store, evolved, 'Next version')
  const mixed = await processRace(directory, 2, [
    { mode: 'publish', targetId: next.id }, { mode: 'rollback', targetId: baseline.revision.id },
  ])
  expect(mixed.map(r => r.status).sort()).toEqual(['committed', 'conflict'])
  const history = await store.history(profile.id)
  expect(history).toHaveLength(3)
  const winner = mixed.find(r => r.status === 'committed')!
  if (winner.status !== 'committed') throw new Error('Missing winner')
  expect(history[2]).toEqual(winner.head)
  expect(history[2].previousId).toBe(evolved.head.id)
  expect((await store.resolve(profile.id))!.revision.id).toBe(winner.head.revisionId)
  expect((await store.publish(profile.id, 2, next.id)).status).toBe('conflict')
  expect((await store.rollback(profile.id, baseline.revision.id, 2, 'Stale')).status).toBe('conflict')
  const restarted = new FileEvolutionStore({ directory, scope: 'project' })
  expect((await restarted.seed(profile)).head.generation).toBe(3)
}), 25_000)

test('restart rejects missing, misnamed and modified journal generations', () => temporary(async (directory, store) => {
  const baseline = await store.seed(profile)
  await publish(store, baseline)
  const heads = join(store.directory, 'heads', profile.id)
  const first = join(heads, '0000000000000001.json')
  const second = join(heads, '0000000000000002.json')
  const original = await readFile(first, 'utf8')
  const restarted = new FileEvolutionStore({ directory, scope: 'project' })
  await rm(first)
  await expect(restarted.resolve(profile.id)).rejects.toThrow('EVOLUTION_CORRUPT_HISTORY')
  await writeFile(first, original)
  await rename(second, join(heads, '0000000000000003.json'))
  await expect(restarted.history(profile.id)).rejects.toThrow('EVOLUTION_CORRUPT_HISTORY')
  await rename(join(heads, '0000000000000003.json'), second)
  await writeFile(first, original.replace('Application baseline', 'Tampered baseline'))
  await expect(restarted.seed(profile)).rejects.toThrow('EVOLUTION_CORRUPT_HISTORY')
}))

test('close waits for owned publication cleanup and aborts a gated storage commit', () => temporary(async (directory) => {
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(r => { entered = r })
  const gate = new Promise<void>(r => { release = r })
  class GatedStore extends FileEvolutionStore {
    override async publish(...args: Parameters<FileEvolutionStore['publish']>) {
      entered(); await gate
      return super.publish(...args)
    }
  }
  const store = new GatedStore({ directory, scope: 'gated' })
  const controller = createEvolutionController({ store, validator: passing, proposer: () => ({ instructions: 'Candidate', rationale: 'Test' }) })
  controller.hooks.afterTurn!(turn(), hookContext())
  await ready
  let closed = false
  const closing = controller.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  release()
  await closing
  expect((await store.resolve(profile.id))!.head.generation).toBe(1)
  expect(closed).toBe(true)
}))
