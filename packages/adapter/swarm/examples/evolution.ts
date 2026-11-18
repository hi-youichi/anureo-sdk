/** Run: bun packages/adapter/swarm/examples/evolution.ts
 * Requires authenticated Codex on PATH. Uses a temporary store and real backend
 * sessions. This tiny demonstration suite is NOT general proof of improvement.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@anureo/sdk'
import { createCodexAdapter } from '@anureo/adapter-codex'
import { createSwarmAdapter, type BeeProfile } from '../src'
import { FileEvolutionStore, createEvolutionController } from '../src/evolution'

const directory = await mkdtemp(join(tmpdir(), 'swarm-evolution-demo-'))
const backend = await createClient({ adapter: createCodexAdapter({ command: 'codex' }), identity: { adapterId: 'codex', runtimeConfigId: 'evolution-demo' } })
const profile: BeeProfile = { id: 'reviewer', name: 'Reviewer', description: 'Explain code and report evidence', instructions: 'Explain the supplied code concisely.' }
const store = new FileEvolutionStore({ directory, scope: 'demo' })
const controller = createEvolutionController({
  store, callbackTimeoutMs: 30_000,
  // Application-supplied proposer. Real applications derive changes from evidence.
  proposer: ({ baseline }) => baseline.profile.instructions.includes('empty input') ? undefined : {
    instructions: baseline.profile.instructions + '\nAlways discuss empty input behavior.', rationale: 'Demo proposal: make boundary behavior explicit',
  },
  validator: {
    identity: { id: 'demo-held-out-code-suite', version: '1' },
    async validate({ baseline, candidate }, { signal }) {
      async function evaluate(instructions: string) {
        const session = await backend.sessions.create({ cwd: process.cwd(), permissionMode: 'read-only', instructions }, { signal })
        try {
          const turn = await session.submit({ input: 'Explain: const first = (xs: number[]) => xs[0]' })
          const result = await turn.result({ timeoutMs: 20_000, signal })
          return result.status === 'completed' ? /undefined/.test(result.text) : undefined
        } finally { await session.close() }
      }
      const before = await evaluate(baseline.profile.instructions)
      const after = await evaluate(candidate.profile.instructions)
      // Strict improvement on this ONE demo case; missing measurements are inconclusive.
      const verdict = before === undefined || after === undefined ? 'inconclusive' : !before && after ? 'pass' : 'fail'
      return { verdict, baselineId: baseline.id, candidateId: candidate.id, suiteId: 'demo-first-empty-v1',
        evidence: [{ check: 'Mentions undefined on empty input', baseline: String(before), candidate: String(after), outcome: verdict }] }
    },
  },
  onError: diagnostic => { console.error(diagnostic) },
})
const baseline = await controller.seed(profile)
const client = await createClient({ adapter: createSwarmAdapter({ backend, profiles: [profile], evolution: { controller } }), identity: { adapterId: 'swarm', runtimeConfigId: 'demo' } })
try {
  const session = await client.sessions.create({ cwd: process.cwd(), permissionMode: 'read-only' })
  for (const input of ['@reviewer Explain Array.prototype.map. Use bee_assess after inspecting the report.', '@reviewer Explain Array.prototype.filter. Use bee_assess after inspecting the report.']) {
    const result = await (await session.submit({ input })).result({ timeoutMs: null })
    console.log(result.status, result.text)
    await controller.drain() // foreground turns do not wait for background validation
    console.log('Current revision:', (await controller.resolve(profile.id))!.head)
  }
  const current = (await controller.resolve(profile.id))!
  if (current.revision.id !== baseline.revision.id) {
    console.log('Rollback:', await controller.rollback(profile.id, baseline.revision.id, current.head.generation, 'Demo complete'))
  }
  console.log('Proposals:', await store.listIds('proposals'), 'History:', await store.history(profile.id))
} finally {
  await client.dispose()
  await controller.close()
  await backend.dispose()
  await rm(directory, { recursive: true, force: true })
}
