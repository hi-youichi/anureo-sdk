import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { analyzeReadability, writeReport } from '@anureo/readability'

const root = await mkdtemp(path.join(tmpdir(), 'anureo-readability-packed-'))
try {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  await mkdir(path.join(root, 'src'))
  const source = 'export function finish() { return true }'
  await writeFile(path.join(root, 'src/index.ts'), source + '\n')
  const agent = {
    async analyze(task) {
      return { reviewedFiles: task.ownedFiles.map(file => file.path), unreviewedFiles: [], observations: [{
        readingTask: 'Understand termination', obstacle: 'Fixture observation', consequence: 'Additional tracing',
        suggestion: 'Name the terminal transition', invariants: ['Preserve ordering'],
        evidence: [{ path: 'src/index.ts', startLine: 1, endLine: 1, quote: source }],
      }] }
    },
    async derive(observations) {
      return [{ title: 'Keep termination visible', guidance: 'Show terminal state ownership', rationale: 'Reduce tracing',
        appliesWhen: ['Shared lifecycle state'], exceptions: [], observationIds: observations.map(value => value.id), checkMethod: 'human' }]
    },
    async verify({ rule: { id, ...rule } }) {
      return { rule, verdict: 'supported', explanation: 'Scripted packaging verification', inspectedFiles: ['src/index.ts'], counterexamples: [] }
    },
  }
  const report = await analyzeReadability({ root, agent })
  if (!report.complete || report.rules.length !== 1 || report.rules[0].status !== 'supported') throw new Error('Readability pipeline failed')
  await writeReport(report, path.join(root, 'report'))
  const saved = JSON.parse(await readFile(path.join(root, 'report/rules.json'), 'utf8'))
  if (saved.observations[0].evidence[0].sha256.length !== 64) throw new Error('Missing evidence hash')
  console.log(JSON.stringify({ result: 'passed', rules: saved.rules.length, coverage: saved.coverage.reviewedFiles.length }))
} finally {
  await rm(root, { recursive: true, force: true })
}
