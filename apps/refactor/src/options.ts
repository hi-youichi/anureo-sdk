// Defines library caller configuration; it must not choose defaults or acquire run resources.
import type { Client } from '@anureo/sdk'
import type { CheckCommand } from './checks'
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
   * The CLI reads CODEX_MODEL for the Codex backend. */
  model?: string
  /** Ask agents to avoid edits and suppress host checks. Enforcement depends on readPermissionMode. */
  reviewOnly?: boolean
  /** Backend-specific permission mode for planning and review-only sessions. Omit for the backend default. */
  readPermissionMode?: string
  /** Backend-specific permission mode for design/module edits. Omit for the backend default. */
  editPermissionMode?: string
  /** Skip graph export and inspect source directly. Defaults to false. */
  noGraph?: boolean
  /** Override the installed @youichi/repograph CLI. Supply an absolute JS/TS entry path because the
   * exporter starts in a temporary directory. Ignored when graphLoader is supplied. */
  repographEntry?: string
  /** Export a validated graph for the canonical target under the run lock, bypassing the default
   * subprocess and repographEntry. The loader owns temporary resources and must clean them up before settling. */
  graphLoader?: GraphLoader
  /** Ordered validation commands run in the target after each integrated patch; [] disables checks. Omission
   * discovers typecheck then test in the target's own package.json, without searching parents.
   * Blank commands reject before the run, even in reviewOnly mode; reviewOnly skips execution. */
  checks?: readonly CheckCommand[]
  /** Git-relative slash globs selecting editable text. Omit to discover source across languages. */
  include?: readonly string[]
  /** Git-relative slash globs excluded from the editable scope, including explicit includes. */
  exclude?: readonly string[]
  /** Synchronous progress observer; thrown errors are recorded in report.progressErrors without
   * stopping the run. Returned promises are not awaited. */
  onProgress?: (message: string) => void
}
