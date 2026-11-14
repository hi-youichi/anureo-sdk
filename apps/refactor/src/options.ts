// Defines library caller configuration; it must not choose defaults or acquire run resources.
import type { Client } from '@anureo/sdk'
import type { GraphLoader } from './graph'

/** Configuration consumed by refactorCode; constructing it has no effects or validation.
 * The caller owns the client throughout the run and is responsible for eventually awaiting disposal. */
export interface RefactorOptions {
  /** Caller-owned SDK client; keep it usable until the run settles. */
  client: Client
  /** Target directory inside a Git work tree, relative to process.cwd() or absolute. Canonicalized
   * before run storage or agents start; a subdirectory target retains its own scope. */
  cwd: string
  /** Agent model override; undefined leaves model selection to the supplied client's backend.
   * Only the CLI reads CODEX_MODEL as a fallback. */
  model?: string
  /** Defaults to false. Ask agents to avoid edits and suppress host checks; design/module session
   * permissions remain unrestricted, so this is a prompt instruction rather than edit prevention. */
  reviewOnly?: boolean
  /** Override the installed @youichi/repograph CLI. Supply an absolute JS/TS entry path because the
   * exporter starts in a temporary directory. Ignored when graphLoader is supplied. */
  repographEntry?: string
  /** Export a validated graph for the canonical target under the run lock, bypassing the default
   * subprocess and repographEntry. The loader owns temporary resources and must clean them up before settling. */
  graphLoader?: GraphLoader
  /** Ordered shell commands after each changed design/module step; [] disables checks. Omission
   * discovers typecheck then test in the target's own package.json, without searching parents.
   * Blank commands reject before the run, even in reviewOnly mode; reviewOnly skips execution. */
  checks?: readonly string[]
  /** Synchronous progress observer; thrown errors are recorded in report.progressErrors without
   * stopping the run. Returned promises are not awaited. */
  onProgress?: (message: string) => void
}
