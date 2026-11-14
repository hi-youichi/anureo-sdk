/** Observe reviewCode through ReviewOptions.onProgress. Events are synchronous and concurrent
 * angle events may interleave. Verification starts after the module tasks and queued fixes settle
 * if a fix outcome records changes in the original work tree. The CLI's reviewAndPrintReport
 * registers an observer that writes to stderr. Callback returns are ignored and synchronous
 * exceptions are collected in ReviewReport.progressErrors. Await reviewCode for the final result
 * or rejection, since an interrupted run may omit terminal events. */
export type ReviewProgress =
  | {
      stage: 'workflow'
      status: 'started'
      /** Identifies the run within directory. */
      runId: string
      /** Absolute root of the durable workflow storage. */
      directory: string
    }
  | {
      stage: 'analysis'
      /** Completion follows host validation of the proposed module plan and any worktree cleanup. */
      status: 'started' | 'completed'
    }
  | {
      stage: 'review' | 'verification'
      /** Completion follows agent execution, host validation and any worktree cleanup. */
      status: 'started' | 'completed' | 'failed'
      moduleId: string
      angleId: string
    }
  | {
      stage: 'fix'
      /** 'completed' means validated edits reached the original work tree and cleanup finished.
       * 'skipped' also covers FixReport's 'not-needed'. Check the report for verification results. */
      status: 'started' | 'completed' | 'failed' | 'skipped'
      moduleId: string
    }
