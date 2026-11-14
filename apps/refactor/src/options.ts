// Defines caller configuration and preflight shared by refactorCode and the CLI.
import type { Client } from '@anureo/sdk'
import type { CheckCommand } from './checks'
import type { GraphLoader } from './graph'

/** Configure a refactorCode run. Keep the supplied client usable until the call settles and await
 * its disposal separately. Invalid concurrency, checks or graph combinations reject before run setup. */
export interface RefactorOptions {
  /** Initialized SDK client used for all agent sessions. */
  client: Client
  /** Target directory inside a Git work tree, relative to process.cwd() or absolute. Canonicalized
   * before run storage or agents start; a subdirectory target retains its own scope. */
  cwd: string
  /** Agent model override for all phases. Omit to use the supplied client's backend default. */
  model?: string
  /** Maximum module tasks active at once, as a positive safe integer. Omit to run all concurrently. */
  concurrency?: number
  /** Ask agents to avoid edits and skip patch integration and host checks. Backend enforcement
   * depends on readPermissionMode. The host fails steps that modify their review worktree. */
  reviewOnly?: boolean
  /** Backend-specific permission mode for planning and review-only sessions. Omit for the backend default. */
  readPermissionMode?: string
  /** Backend-specific permission mode for design/module edits. Omit for the backend default. */
  editPermissionMode?: string
  /** Skip graph export and inspect source directly. Defaults to false. An explicit graph loader
   * or nonempty repograph entry is incompatible with true. */
  noGraph?: boolean
  /** Override the installed @youichi/repograph CLI. Supply an absolute JS/TS entry path because the
   * exporter starts in a temporary directory. Omit the field to use the installed exporter.
   * When graphLoader is supplied, it takes precedence. */
  repographEntry?: string
  /** Export a validated graph for the canonical target under the run lock, bypassing the default
   * subprocess and repographEntry. A rejection is recorded as a run failure. The loader owns
   * temporary resources and must clean them up before settling. */
  graphLoader?: GraphLoader
  /** Commands run serially in the target after successful patch integration. The first failure
   * stops later checks. An empty list disables checks. Omission discovers typecheck then test in
   * the target's own package.json. Blank executables or NUL bytes reject before the run, including
   * in reviewOnly mode, which skips execution. */
  checks?: readonly CheckCommand[]
  /** Target-relative slash globs selecting eligible Git-visible text. Omission or an empty list
   * uses default discovery across languages and skips common metadata and prose. */
  include?: readonly string[]
  /** Target-relative slash globs excluded from the editable scope, including explicit includes. */
  exclude?: readonly string[]
  /** Synchronous progress observer; thrown errors are recorded in report.progressErrors without
   * stopping the run. Returned promises are not awaited. */
  onProgress?: (message: string) => void
}

/** Accept an omitted limit or a positive safe integer. Throw synchronously with the caller's
 * label otherwise. CLI admission checks this before creating a client and refactorCode checks
 * it before opening a run. */
export function validateConcurrency(value: number | undefined, label = 'concurrency'): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${label} must be a positive integer`)
  }
}

/** Throw synchronously if graph export is disabled and the caller detected an explicit exporter.
 * The CLI treats presence of --repograph as explicit even when its argument is empty. refactorCode
 * tests the supplied entry or loader for truthiness. Both check before starting their run. */
export function validateGraphOptions(noGraph: boolean | undefined, hasExporter: boolean, label = 'noGraph'): void {
  if (noGraph && hasExporter) throw new Error(`${label} cannot be combined with a graph exporter`)
}
