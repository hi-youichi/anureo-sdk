import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'

/** Operational directory names never reviewable as source. This list is the
 * single source of truth: the analysis prompt in src/review.ts derives its
 * exclusion wording from it, and the default storage directory below lives
 * under '.anureo' — update consumers together. */
export const OPERATIONAL_PATH_SEGMENTS = ['.git', '.anureo', 'node_modules'] as const

/** Default durable run storage, relative to the review directory. Its first
 * segment must stay in OPERATIONAL_PATH_SEGMENTS so the default storage is
 * always excluded regardless of --workflow-dir overrides. */
export const DEFAULT_WORKFLOW_DIRECTORY = '.anureo/workflows'

/** True when `path` is lexically inside `base` (both normalized absolute paths;
 * an empty relative result means they are equal). Shared by the review-scope
 * and fix-scope containment checks so the predicate has one owner. */
export function isInsideDirectory(base: string, path: string, allowSelf = true): boolean {
  const local = relative(base, path)
  if (local === '') return allowSelf
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
}

/** Exclude both conventional metadata paths and the actual configured run storage. */
export async function assertReviewablePath(cwd: string, path: string, workflowDirectory: string): Promise<void> {
  // Storage may not exist yet before the workflow store creates it (see src/fix.ts);
  // fall back to the unresolved path so the guard stays usable for pre-validation.
  const storage = await realpath(workflowDirectory).catch(() => workflowDirectory)
  if (isInsideDirectory(storage, path)) {
    throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Path is inside workflow run storage (${workflowDirectory}) and cannot be reviewed or fixed as source: ${path}`)
  }
  const metadata = relative(cwd, path).split(sep).some(part => (OPERATIONAL_PATH_SEGMENTS as readonly string[]).includes(part))
  if (metadata) throw new HarnessSdkError('REVIEW_INVALID_SOURCE', `Operational metadata cannot be reviewed or fixed as source: ${path}`)
}
