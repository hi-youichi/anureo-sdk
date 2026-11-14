import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'

/** Operational directory names never reviewable as source. This list is the
 * single source of truth: the analysis prompt in src/prompts.ts derives its
 * exclusion wording from it, and the default storage directory below lives
 * under '.anureo' — update consumers together. */
export const OPERATIONAL_PATH_SEGMENTS = ['.git', '.anureo', 'node_modules'] as const

/** Default durable run storage, relative to the review directory. Its first
 * segment must stay in OPERATIONAL_PATH_SEGMENTS so the default storage is
 * always excluded regardless of --workflow-dir overrides. */
export const DEFAULT_WORKFLOW_DIRECTORY = '.anureo/workflows'

/** Test lexical containment of normalized absolute paths, including equality by default.
 * Pass allowSelf=false to require a descendant, as fix-tree's storagePrefixes does when
 * collecting storage exclusions. Does not access the filesystem or resolve symlinks;
 * resolveReviewableSourcePath supplies canonical paths for source containment checks. */
export function isInsideDirectory(base: string, path: string, allowSelf = true): boolean {
  const local = relative(base, path)
  if (local === '') return allowSelf
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
}

/** Reject canonical source paths inside configured workflow storage or with an operational
 * segment relative to canonical cwd, using REVIEW_INVALID_SOURCE. All inputs must be absolute;
 * the caller resolves source symlinks and separately checks containment and file type.
 * resolveReviewableSourcePath awaits this before accepting plan or finding paths. */
export async function assertReviewablePath(cwd: string, path: string, workflowDirectory: string): Promise<void> {
  // Storage may be unavailable; retain the configured path as a lexical exclusion
  // even when its canonical path cannot be read.
  const storage = await realpath(workflowDirectory).catch(() => workflowDirectory)
  if (isInsideDirectory(storage, path)) {
    throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Path is inside workflow run storage (${workflowDirectory}) and cannot be reviewed or fixed as source: ${path}`)
  }
  const metadata = relative(cwd, path).split(sep).some(part => (OPERATIONAL_PATH_SEGMENTS as readonly string[]).includes(part))
  if (metadata) throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Operational metadata cannot be reviewed or fixed as source: ${path}`)
}
