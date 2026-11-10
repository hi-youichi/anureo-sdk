import { scanRepository, detectSourceChanges } from './inventory'
import { planAnalysis } from './planner'
import { mapSettled, positiveInteger } from './scheduler'
import { validateAnalysis, validateCandidates, validateReview } from './evidence'
import type { AnalysisDraft, AnalysisResult, AnalysisTask, AnalyzeOptions, CandidateRule, ProgressEvent, ReadabilityReport, ReadabilityRule, SourceFile, TaskFailure } from './types'

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function inventoryKey(files: SourceFile[]): string {
  return JSON.stringify(files.map(file => [file.path, file.sha256, file.packagePath, file.kind]).sort((a, b) => a[0]!.localeCompare(b[0]!)))
}

function taskKey(task: AnalysisTask): string {
  return JSON.stringify([task.packagePath, task.focus, inventoryKey(task.ownedFiles)])
}

function reusableDraft(result: AnalysisResult): AnalysisDraft {
  return { reviewedFiles: result.reviewedFiles, unreviewedFiles: result.unreviewedFiles,
    observations: result.observations.map(({ id: _, taskId: __, evidence, ...observation }) => ({ ...observation,
      evidence: evidence.map(({ sha256: ___, ...location }) => location) })) }
}

export async function analyzeReadability(options: AnalyzeOptions): Promise<ReadabilityReport> {
  const concurrency = positiveInteger(options.concurrency ?? 4, 'concurrency')
  options.signal?.throwIfAborted()
  const inventory = await scanRepository(options)
  const tasks = planAnalysis(inventory, options.packages)
  const failures: TaskFailure[] = []
  const reusedTaskIds: string[] = []
  const reusable = new Map<string, AnalysisResult>()
  const previous = options.resume
  if (previous?.schemaVersion === 1 && inventoryKey(previous.files) === inventoryKey(inventory.files)) {
    for (const task of previous.tasks) {
      const analysis = previous.analyses.find(result => result.taskId === task.id)
      if (analysis && !analysis.unreviewedFiles.length) reusable.set(taskKey(task), analysis)
    }
  }
  const context = { root: inventory.root, signal: options.signal }
  // Progress observers cannot change the outcome of analysis.
  function progress(event: ProgressEvent): void { try { options.onProgress?.(event) } catch {} }
  async function tracked<T>(phase: ProgressEvent['phase'], taskId: string, run: () => Promise<T>): Promise<T> {
    progress({ phase, taskId, state: 'started' })
    try {
      const result = await run()
      progress({ phase, taskId, state: 'completed' })
      return result
    } catch (cause) {
      failures.push({ phase, taskId, message: message(cause) })
      progress({ phase, taskId, state: 'failed' })
      throw cause
    }
  }

  const outcomes = await mapSettled(tasks, concurrency, task => tracked('analyze', task.id, async () => {
    const cached = reusable.get(taskKey(task))
    if (cached) {
      try {
        const result = await validateAnalysis(task, reusableDraft(cached), inventory)
        reusedTaskIds.push(task.id)
        return result
      } catch {
        // Invalid/stale cached evidence must be analyzed again, not silently trusted.
        options.signal?.throwIfAborted()
      }
    }
    const draft = await options.agent.analyze(structuredClone(task), context)
    return validateAnalysis(task, draft, inventory)
  }), options.signal)
  const analyses = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : [])
  const observations = analyses.flatMap(result => result.observations)
  let candidates: CandidateRule[] = []
  if (observations.length) {
    try {
      candidates = await tracked('derive', 'derive', async () => validateCandidates(
        await options.agent.derive(structuredClone(observations), context), observations))
    } catch { options.signal?.throwIfAborted() }
  }
  const reviews = await mapSettled(candidates, concurrency, candidate => tracked('verify', candidate.id, async () => {
    const cited = observations.filter(observation => candidate.observationIds.includes(observation.id))
    const review = await options.agent.verify(structuredClone({ rule: candidate, observations: cited, sourceIndex: inventory.files }), context)
    return validateReview(candidate, review, observations, inventory)
  }), options.signal)
  const rules: ReadabilityRule[] = reviews.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value : ({
    ...candidates[index]!, status: 'candidate', explanation: 'Verification failed; see task failures.', inspectedFiles: [], inspectedSources: [], counterexamples: [],
  }))
  // Keep every snapshot: differing review-time hashes must not overwrite earlier evidence.
  const sourceSnapshots = [...inventory.files, ...rules.flatMap(rule => rule.inspectedSources)]
  const changedFiles = await detectSourceChanges({ root: inventory.root, files: sourceSnapshots })
  for (const rule of rules) {
    const cited = observations.filter(observation => rule.observationIds.includes(observation.id))
    const dependencies = [...rule.inspectedFiles, ...cited.flatMap(observation => observation.evidence.map(ref => ref.path))]
    if (dependencies.some(file => changedFiles.includes(file))) rule.status = 'stale'
  }
  const reviewedFiles = analyses.flatMap(result => result.reviewedFiles).sort()
  const byTask = new Map<string, AnalysisResult>(analyses.map(result => [result.taskId, result]))
  const unreviewedFiles = tasks.flatMap(task => byTask.get(task.id)?.unreviewedFiles ??
    task.ownedFiles.map(file => ({ path: file.path, reason: 'Analysis task failed; see task failures.' })))
  options.signal?.throwIfAborted()
  return { schemaVersion: 1, createdAt: new Date().toISOString(), packages: inventory.packages,
    files: inventory.files, tasks, analyses, reusedTaskIds: reusedTaskIds.sort(), observations, rules,
    failures: failures.sort((a, b) => a.phase.localeCompare(b.phase) || a.taskId.localeCompare(b.taskId)),
    coverage: { reviewedFiles, unreviewedFiles }, changedFiles,
    complete: !failures.length && !unreviewedFiles.length && !changedFiles.length }
}
