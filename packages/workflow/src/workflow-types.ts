/** Identify a new durable run and optionally supply a compatible source journal for replay. */
export interface WorkflowOptions<Input> {
  /** Nonempty workflow identity; must match the source when resuming. */
  name: string
  /** Nonempty, application-managed compatibility revision; must match the source when resuming. */
  revision: string
  /** Parent of run directories, resolved relative to the process working directory. */
  directory: string
  /** New target directory name; defaults to a random UUID. Must be a nonblank single path
   * component of at most 255 UTF-8 bytes, without control characters. Existing runs reject. */
  runId?: string
  /** Strict JSON data copied and deeply frozen before the body runs; the caller's value is untouched. */
  input: Input
  /** Omit for a fresh journal. A string selects a source run in directory; an object selects
   * a run under another parent directory. The inactive source is read, never modified;
   * the body reruns with this run's input and reuses eligible agent results. */
  resumeFrom?: string | { directory: string; runId: string }
}

/** Body inputs available after the initial manifest has been published. */
export interface WorkflowContext<Input> {
  /** Identity of the new run, including when replaying a source journal. */
  readonly runId: string
  /** Isolated, deeply frozen JSON copy of WorkflowOptions.input. */
  readonly input: Input
}

/** Published body result returned after registered agent work settles and the writer lock is released. */
export interface WorkflowResult<Result> {
  /** Identity of the run that published this result. */
  runId: string
  /** Incomplete if any registered agent work rejected or was dropped, even if the body recovered.
   * Fatal failures reject workflow instead of returning a result. */
  status: 'completed' | 'incomplete'
  /** JSON copy of the awaited body return value. */
  result: Result
}
