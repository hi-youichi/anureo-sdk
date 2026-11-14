// Progress events delivered by review and fix execution to caller-supplied observers.
/** Synchronous observer events from reviewCode. Angle events may interleave; verification starts
 * after all fixes settle if any fix was applied. Applications supply onProgress; the CLI registers
 * a callback that writes these events to stderr. Callback returns are ignored and synchronous
 * exceptions are retained in ReviewReport.progressErrors. A rejected run may omit terminal events;
 * consume reviewCode's result or rejection to determine completion. */
export type ReviewProgress =
  /** The durable workflow has started; directory is its storage root and runId identifies this run. */
  | { stage: 'workflow'; status: 'started'; runId: string; directory: string }
  /** Analysis completes only after the proposed module plan passes host validation. */
  | { stage: 'analysis'; status: 'started' | 'completed' }
  /** Angle completion includes host validation of its findings, not just the agent response. */
  | { stage: 'review' | 'verification'; status: 'started' | 'completed' | 'failed'; moduleId: string; angleId: string }
  /** Fix 'completed' means allowed edits were observed, not that verification passed. 'skipped'
   * also covers FixReport's 'not-needed'; inspect the report for the distinction. */
  | { stage: 'fix'; status: 'started' | 'completed' | 'failed' | 'skipped'; moduleId: string }
