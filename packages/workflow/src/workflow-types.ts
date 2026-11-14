/** Identify a new durable run and optionally supply a compatible source journal for replay. */
export interface WorkflowOptions<Input> {
  /** Nonempty workflow name. Resume requires the same name in the source manifest. */
  name: string
  /** Nonempty application-managed revision. A changed revision prevents resuming older runs. */
  revision: string
  /** Nonempty storage root. Relative paths are resolved against the process working directory. */
  directory: string
  /** New target directory name, defaulting to a random UUID. Use a nonblank single path
   * component of at most 255 UTF-8 bytes. Control characters, separators, `.` and `..` are
   * invalid. A locked or nonempty target directory rejects. */
  runId?: string
  /** Strict JSON input. The body receives a deeply frozen copy. */
  input: Input
  /** Omit for a fresh journal. A string selects a run under `directory`. An object supplies the
   * source's storage root and ID explicitly. The source must be inactive, compatible by name and
   * revision, and separate from the target tree. The new run copies its journal before invoking the body. */
  resumeFrom?: string | { directory: string; runId: string }
}

/** Body inputs available after the initial manifest has been published. */
export interface WorkflowContext<Input> {
  /** Identity of the new run, including when replaying a source journal. */
  readonly runId: string
  /** Isolated, deeply frozen JSON copy of the input supplied for this invocation. */
  readonly input: Input
}

/** Published body result returned after registered agent work settles and the writer lock is released. */
export interface WorkflowResult<Result> {
  /** Identity of the run that published this result. */
  runId: string
  /** Incomplete if registered agent work rejected or was dropped and the workflow could still
   * publish a result. Fatal agent failures reject the workflow promise. */
  status: 'completed' | 'incomplete'
  /** JSON copy of the awaited body return value. */
  result: Result
}
