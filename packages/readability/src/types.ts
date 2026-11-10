export interface SourceFile {
  /** All persisted paths are relative to the repository root, with '/' separators. */
  path: string
  packagePath: string
  sha256: string
  lines: number
  kind: 'source' | 'test'
}

export interface SourceLocation {
  path: string
  startLine: number
  endLine: number
  /** Exact complete lines from the source; CRLF is normalized to LF. */
  quote: string
}

export interface SourceRef extends SourceLocation {
  sha256: string
}

export interface SourceSnapshot {
  path: string
  sha256: string
}

export interface ObservationDraft {
  evidence: SourceLocation[]
  readingTask: string
  obstacle: string
  consequence: string
  suggestion: string
  invariants: string[]
}

export interface Observation extends Omit<ObservationDraft, 'evidence'> {
  id: string
  taskId: string
  evidence: SourceRef[]
}

export interface AnalysisTask {
  id: string
  packagePath: string
  focus: string
  ownedFiles: SourceFile[]
}

export interface AnalysisDraft {
  reviewedFiles: string[]
  unreviewedFiles: Array<{ path: string; reason: string }>
  observations: ObservationDraft[]
}

export interface AnalysisResult extends Omit<AnalysisDraft, 'observations'> {
  taskId: string
  observations: Observation[]
}

export interface RuleDraft {
  title: string
  guidance: string
  rationale: string
  appliesWhen: string[]
  exceptions: string[]
  observationIds: string[]
  checkMethod: 'human' | 'static' | 'agent'
}

export interface CandidateRule extends RuleDraft {
  id: string
}

export interface RuleReview {
  rule: RuleDraft
  verdict: 'supported' | 'candidate' | 'rejected'
  explanation: string
  /** Files actually inspected when checking the rule and seeking exceptions. */
  inspectedFiles: string[]
  counterexamples: SourceLocation[]
}

export interface ReadabilityRule extends CandidateRule {
  status: RuleReview['verdict'] | 'stale'
  explanation: string
  inspectedFiles: string[]
  /** Context outside the analysis inventory is hashed when the review is validated. */
  inspectedSources: SourceSnapshot[]
  counterexamples: SourceRef[]
}

export interface Inventory {
  root: string
  packages: Array<{ path: string; name: string }>
  files: SourceFile[]
}

export interface AgentContext {
  root: string
  signal?: AbortSignal
}

export interface ReadabilityAgent {
  analyze(task: AnalysisTask, context: AgentContext): Promise<AnalysisDraft>
  derive(observations: Observation[], context: AgentContext): Promise<RuleDraft[]>
  verify(input: {
    rule: CandidateRule
    observations: Observation[]
    sourceIndex: SourceFile[]
  }, context: AgentContext): Promise<RuleReview>
}

export interface PackageSelection {
  path: string
  agents?: number
  /** Optional explicit responsibility groups. Each source file must occur exactly once. */
  groups?: Array<{ focus: string; files: string[] }>
}

export type ProgressEvent = {
  phase: 'analyze' | 'derive' | 'verify'
  taskId: string
  state: 'started' | 'completed' | 'failed'
}

export interface AnalyzeOptions {
  root: string
  agent: ReadabilityAgent
  /** Omit to discover the root manifest's workspaces (or the root package). */
  packages?: PackageSelection[]
  concurrency?: number
  includeTests?: boolean
  /** Reuse complete package-task results on the exact same source inventory. Rules are re-derived and reviewed. */
  resume?: ReadabilityReport
  signal?: AbortSignal
  onProgress?: (event: ProgressEvent) => void
}

export interface TaskFailure {
  phase: ProgressEvent['phase']
  taskId: string
  message: string
}

export interface ReadabilityReport {
  schemaVersion: 1
  createdAt: string
  packages: Inventory['packages']
  files: SourceFile[]
  tasks: AnalysisTask[]
  analyses: AnalysisResult[]
  reusedTaskIds: string[]
  observations: Observation[]
  rules: ReadabilityRule[]
  failures: TaskFailure[]
  coverage: {
    reviewedFiles: string[]
    unreviewedFiles: Array<{ path: string; reason: string }>
  }
  changedFiles: string[]
  /** Execution/coverage completeness; not a claim that rules are objectively correct. */
  complete: boolean
}
