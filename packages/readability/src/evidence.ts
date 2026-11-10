import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { hashSource, resolveInside, sourceLines } from './inventory'
import { parseAnalysis, parseDerivation, parseReview } from './schemas'
import type {
  AnalysisResult, AnalysisTask, CandidateRule, Inventory, Observation, ReadabilityRule, SourceLocation, SourceRef, SourceSnapshot,
} from './types'

export async function validateLocations(locations: SourceLocation[], inventory: Inventory): Promise<SourceRef[]> {
  const evidence: SourceRef[] = []
  for (const location of locations) {
    const file = inventory.files.find(file => file.path === location.path)
    if (!file) throw new Error(`Evidence references an uninventoried file: ${location.path}`)
    const absolute = await realpath(resolveInside(inventory.root, file.path))
    resolveInside(inventory.root, path.relative(inventory.root, absolute))
    const text = await readFile(absolute, 'utf8')
    if (hashSource(text) !== file.sha256) throw new Error(`Source changed: ${file.path}`)
    if (location.endLine < location.startLine || location.endLine > file.lines) throw new Error(`Invalid source range: ${file.path}`)
    const quote = sourceLines(text).slice(location.startLine - 1, location.endLine).join('\n')
    if (quote !== location.quote) throw new Error(`Evidence quote does not match source: ${file.path}:${location.startLine}`)
    evidence.push({ ...location, sha256: file.sha256 })
  }
  return evidence
}

export async function validateAnalysis(task: AnalysisTask, value: unknown, inventory: Inventory): Promise<AnalysisResult> {
  const draft = parseAnalysis(value)
  const owned = new Set(task.ownedFiles.map(file => file.path))
  const declared = [...draft.reviewedFiles, ...draft.unreviewedFiles.map(file => file.path)]
  if (declared.length !== owned.size || new Set(declared).size !== owned.size || declared.some(file => !owned.has(file))) {
    throw new Error(`Analysis must account for every assigned file exactly once: ${task.id}`)
  }
  const observations: Observation[] = []
  for (const [index, observation] of draft.observations.entries()) {
    if (!observation.evidence.some(ref => owned.has(ref.path) && draft.reviewedFiles.includes(ref.path))) {
      throw new Error(`Observation requires evidence from a reviewed owned file: ${task.id}`)
    }
    if (observation.evidence.some(ref => owned.has(ref.path) && !draft.reviewedFiles.includes(ref.path))) {
      throw new Error(`Observation cites an unreviewed owned file: ${task.id}`)
    }
    observations.push({ ...observation, id: `${task.id}/observation-${index + 1}`, taskId: task.id,
      evidence: await validateLocations(observation.evidence, inventory) })
  }
  return { ...draft, taskId: task.id, observations }
}

function assertObservationIds(ids: string[], observations: Observation[]): void {
  const known = new Set(observations.map(observation => observation.id))
  if (ids.some(id => !known.has(id))) throw new Error('Rule references an unknown observation')
}

export function validateCandidates(value: unknown, observations: Observation[]): CandidateRule[] {
  const { rules } = parseDerivation({ rules: value })
  return rules.map((rule, index) => {
    assertObservationIds(rule.observationIds, observations)
    return { ...rule, id: `rule-${index + 1}` }
  })
}

export async function validateReview(
  candidate: CandidateRule,
  value: unknown,
  observations: Observation[],
  inventory: Inventory,
): Promise<ReadabilityRule> {
  const review = parseReview(value)
  const available = observations.filter(observation => candidate.observationIds.includes(observation.id))
  assertObservationIds(review.rule.observationIds, available)
  const inspected = new Set(review.inspectedFiles)
  const inspectedSources: SourceSnapshot[] = []
  for (const filename of review.inspectedFiles) {
    const requested = resolveInside(inventory.root, filename)
    if (path.isAbsolute(filename) || path.relative(inventory.root, requested).split(path.sep).join('/') !== filename) {
      throw new Error(`Inspected file must use a canonical repository-relative path: ${filename}`)
    }
    const absolute = await realpath(requested)
    resolveInside(inventory.root, path.relative(inventory.root, absolute))
    const sha256 = hashSource(await readFile(absolute, 'utf8'))
    const baseline = inventory.files.find(file => file.path === filename)
    if (baseline && sha256 !== baseline.sha256) throw new Error(`Source changed: ${filename}`)
    inspectedSources.push({ path: filename, sha256 })
  }
  const cited = available.filter(observation => review.rule.observationIds.includes(observation.id))
  if (cited.some(observation => observation.evidence.some(ref => !inspected.has(ref.path)))) {
    throw new Error('Review must inspect every cited evidence file')
  }
  if (review.counterexamples.some(ref => !inspected.has(ref.path))) throw new Error('Counterexample file must be inspected')
  return { ...review.rule, id: candidate.id, status: review.verdict, explanation: review.explanation,
    inspectedFiles: review.inspectedFiles, inspectedSources, counterexamples: await validateLocations(review.counterexamples, inventory) }
}
