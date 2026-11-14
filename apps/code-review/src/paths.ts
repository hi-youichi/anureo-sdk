import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'

/** Exact path segments excluded from review source. The analysis prompt uses these names,
 * source validation checks canonical paths, and copySource skips matching Git paths. */
export const OPERATIONAL_PATH_SEGMENTS = ['.git', '.anureo', 'node_modules'] as const

/** Default durable run storage relative to the canonical review directory. Its first segment
 * stays in OPERATIONAL_PATH_SEGMENTS so old default records stay excluded when storage is overridden. */
export const DEFAULT_WORKFLOW_DIRECTORY = '.anureo/workflows'

/** Return an existing directory's canonical absolute path. Relative paths resolve from the
 * process working directory. Filesystem errors and non-directories reject. executeReviewCommand
 * awaits this before acquiring a client, and prepareReview uses the result for Git and agent work. */
export async function resolveReviewDirectory(directory: string): Promise<string> {
  const cwd = await realpath(resolve(directory))
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Review directory is not a directory: ${cwd}`)
  return cwd
}

/** Test lexical containment of absolute paths, including equality by default.
 * Pass false for allowSelf to require a descendant. Callers resolve symlinks when
 * containment must follow filesystem targets. */
export function isInsideDirectory(base: string, path: string, allowSelf = true): boolean {
  const local = relative(base, path)
  if (local === '') return allowSelf
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
}

/** Reject with REVIEW_INVALID_SOURCE when a canonical source path falls inside workflow storage
 * or has an excluded segment relative to cwd. Pass absolute paths and canonicalize cwd and path
 * first. If storage resolution fails, use its configured path. resolveReviewableSourcePath
 * awaits these exclusions before checking containment and file type. */
export async function assertReviewablePath(cwd: string, path: string, workflowDirectory: string): Promise<void> {
  // Storage may be unavailable; retain the configured path as a lexical exclusion
  // even when its canonical path cannot be read.
  const storage = await realpath(workflowDirectory).catch(() => workflowDirectory)
  if (isInsideDirectory(storage, path)) {
    throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Path is inside workflow run storage (${workflowDirectory}) and cannot be reviewed or fixed as source: ${path}`)
  }
  if (hasOperationalPathSegment(relative(cwd, path).split(sep))) throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Operational metadata cannot be reviewed or fixed as source: ${path}`)
}

/** Match any exact excluded segment. assertReviewablePath splits canonical relative paths using
 * the filesystem separator, and copySource splits Git paths on '/' before copying files. */
export function hasOperationalPathSegment(segments: readonly string[]): boolean {
  return segments.some(part => (OPERATIONAL_PATH_SEGMENTS as readonly string[]).includes(part))
}
