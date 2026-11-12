// Defines library caller configuration; it must not choose defaults or acquire run resources.
import type { Client } from '@anureo/sdk'
import type { GraphLoader } from './graph'

/** Configuration consumed by refactorCode; constructing it has no effects or validation.
 * The caller owns the client throughout the run and disposes it after refactorCode settles. */
export interface RefactorOptions {
  /** Caller-owned SDK client; refactorCode does not dispose it. */
  client: Client
  /** Target directory inside a Git work tree; resolved before run storage or agents are started. */
  cwd: string
  /** Agent model override; undefined leaves model selection to the supplied client. */
  model?: string
  /** Ask agents to avoid edits and suppress host checks; editing-session permissions remain unrestricted. */
  reviewOnly?: boolean
  /** Override the repograph TypeScript CLI path when using the default graph loader. */
  repographEntry?: string
  /** Export a validated graph under the run lock, bypassing the default subprocess and repographEntry. */
  graphLoader?: GraphLoader
  /** Ordered shell commands after changed steps; [] disables checks, undefined discovers target package scripts. */
  checks?: readonly string[]
  /** Synchronous observer; its errors are recorded without stopping the run. */
  onProgress?: (message: string) => void
}
