import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AnalysisTask, ReadabilityAgent, RuleDraft } from '../src'

export async function fixture(files: Record<string, string>, workspace: unknown = ['packages/*']): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'anureo-readability-test-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', ...(workspace === null ? {} : { workspaces: workspace }) }))
  for (const [filename, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true })
    await writeFile(path.join(root, filename), contents)
  }
  return root
}

export const sources = {
  'packages/a/package.json': '{"name":"a"}',
  'packages/a/src/main.ts': 'export function start() { return 1 }\n',
  'packages/a/src/stop.ts': 'export function stop() { return 0 }\n',
  'packages/b/package.json': '{"name":"b"}',
  'packages/b/src/main.ts': 'export function start() { return 2 }\n',
}

export function draftRule(observationIds: string[]): RuleDraft {
  return { title: 'Make lifecycle transitions locally visible', guidance: 'Group related state transitions.',
    rationale: 'Readers need to track the state owner.', appliesWhen: ['Multiple branches change the same lifecycle state'],
    exceptions: ['Independent lifecycles should remain separate'], observationIds, checkMethod: 'human' }
}

export function scriptedAgent(overrides: Partial<ReadabilityAgent> = {}): ReadabilityAgent {
  return {
    async analyze(task: AnalysisTask) {
      const file = task.ownedFiles[0]!
      return { reviewedFiles: task.ownedFiles.map(file => file.path), unreviewedFiles: [], observations: [{
        evidence: [{ path: file.path, startLine: 1, endLine: 1, quote: sources[file.path as keyof typeof sources]!.split('\n')[0]! }],
        readingTask: 'Understand when execution stops', obstacle: 'Termination conditions are dispersed',
        consequence: 'Readers must reconcile branches', suggestion: 'Name the terminal transition', invariants: ['Preserve ordering'],
      }] }
    },
    async derive(observations) { return [draftRule(observations.map(observation => observation.id))] },
    async verify(input) {
      const { id: _, ...rule } = input.rule
      return { rule, verdict: 'supported', explanation: 'Inspected the cited paths and scoped the rule.',
        inspectedFiles: [...new Set(input.observations.flatMap(observation => observation.evidence.map(ref => ref.path)))], counterexamples: [] }
    },
    ...overrides,
  }
}
