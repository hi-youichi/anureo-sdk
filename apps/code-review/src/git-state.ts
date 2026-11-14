// Reads Git provenance for analysis, review, fix and verification prompts.
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileState } from './file-state'
import { reviewGit } from './git'
import { hasOperationalPathSegment, isInsideDirectory } from './paths'

/** Hash Git HEAD and the current contents of tracked and non-ignored untracked source paths.
 * Exclude workflow storage and operational paths as in the agent checkout. Reads run without
 * locking the tree. Git and filesystem failures return null, including on an unborn branch.
 *
 * prepareReview also persists this value in workflow input. reviewModuleLifecycle, the queued
 * task in createFixRunner and verifyFinalTree refresh it for their prompts, which omit the
 * fingerprint when it is null. */
export async function readGitStateFingerprint(cwd: string, directory: string): Promise<string | null> {
  try {
    const root = await realpath((await reviewGit(cwd, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, ''))
    const head = await reviewGit(root, 'rev-parse', 'HEAD')
    const files = await reviewGit(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    const storage = await realpath(directory).catch(() => directory)
    const hash = createHash('sha256').update(head).update('\0')
    for (const file of [...new Set(files.split('\0'))].sort()) {
      if (!file || hasOperationalPathSegment(file.split('/'))) continue
      const path = resolve(root, file)
      if (isInsideDirectory(directory, path) || isInsideDirectory(storage, path)) continue
      const parent = dirname(path)
      if (!await hasCanonicalParent(parent)) continue
      const { fingerprint } = await fileState(root, file)
      if (fingerprint !== null) hash.update(file).update('\0').update(fingerprint).update('\0')
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

/** Indexed paths can have missing parents or parents replaced by symlinks. */
async function hasCanonicalParent(parent: string): Promise<boolean> {
  try { return await realpath(parent) === parent }
  catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause
      && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')) return false
    throw cause
  }
}
