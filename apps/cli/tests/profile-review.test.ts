import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BeeProfileReview } from '@anureo/adapter-swarm'
import { saveProfileProposal } from '../src/profile-review'

test('review proposals retain their exact source and separate same-ID origins', async () => {
  const project = await mkdtemp(join(tmpdir(), 'anureo-review-origins-'))
  try {
    const baseline: Extract<BeeProfileReview, { status: 'proposed' }> = {
      profileId: 'tester', cwd: project, sourceTurnId: 'turn', baseInstructionsHash: 'baseline',
      status: 'proposed', reason: 'Observed omission', evidence: ['Assertion missing'],
      patch: { op: 'append', anchor: null, text: 'Check rollback' }, check: 'Rollback test passes', instructions: 'Check rollback',
    }
    for (const scope of ['user', 'project'] as const) {
      const review = { ...baseline, profileSource: { scope, namespace: `/${scope}` }, sourceFile: `/${scope}/tester.json` }
      const file = await saveProfileProposal(project, review)
      expect(file.startsWith(join(project, '.anureo', 'evolution', scope, 'tester', 'proposals'))).toBe(true)
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ sourceFile: review.sourceFile, profileSource: review.profileSource })
    }
    const legacy = await saveProfileProposal(project, baseline, '/legacy/tester.json')
    expect(legacy.startsWith(join(project, '.anureo', 'evolution', 'tester', 'proposals'))).toBe(true)
  } finally { await rm(project, { recursive: true, force: true }) }
})
