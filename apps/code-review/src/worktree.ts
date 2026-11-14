// Creates a private Git checkout of the current source for one agent session.
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { reviewGit } from './git'
import { hasOperationalPathSegment, isInsideDirectory } from './paths'

/** Internal checkout paths valid during the withAgentWorktree callback. */
export interface AgentWorktree {
  /** Absolute Git root of the detached checkout. */
  root: string
}

/** Run one agent operation and await its result and any checkout cleanup.
 * Supply cwd and the workflow storage directory as absolute paths. If supplied, root must be
 * the canonical Git root containing cwd.
 * With a root, the callback receives a checkout-local cwd and any in-repository storage path
 * is remapped for validation. Without a root, the callback receives the original paths and
 * no checkout handle. Await all checkout access inside the callback.
 *
 * analyzeModules uses the returned plan before dispatching reviews. reviewAngle and applyFix
 * report checkout rejections as failed angle or fix results, respectively.
 * Setup or callback failures propagate even if cleanup also fails. Cleanup alone rejects with
 * REVIEW_FIX_CLEANUP and can leave files behind, even after applyFix updates the original tree. */
export async function withAgentWorktree<T>(
  options: { root?: string; cwd: string; directory: string },
  use: (cwd: string, directory: string, worktree?: AgentWorktree) => Promise<T>,
): Promise<T> {
  const { root, cwd, directory } = options
  if (root === undefined) return use(cwd, directory)
  const scratch = await mkdtemp(resolve(await realpath(tmpdir()), 'anureo-review-'))
  const checkout = resolve(scratch, 'checkout')
  const worktree = { root: checkout }
  let failed = false
  try {
    const head = await initializeCheckout(root, checkout, scratch)
    await reviewGit(checkout, 'read-tree', head)
    await copySource(root, checkout, directory)
    const localCwd = resolve(checkout, relative(root, cwd))
    const localDirectory = isInsideDirectory(root, directory) ? resolve(checkout, relative(root, directory)) : directory
    await mkdir(localCwd, { recursive: true })
    return await use(localCwd, localDirectory, worktree)
  } catch (cause) {
    failed = true
    throw cause
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true })
    } catch (cause) {
      if (!failed) throw new HarnessSdkError('REVIEW_FIX_CLEANUP',
        `Could not remove temporary worktree at ${checkout}`, false, false, { cause })
      // A secondary cleanup failure must not hide a setup or callback failure.
    }
  }
}

/** Import the baseline into a standalone repository with its own objects, refs and configuration. */
async function initializeCheckout(root: string, checkout: string, scratch: string): Promise<string> {
  const format = (await reviewGit(root, 'rev-parse', '--show-object-format')).trim()
  await mkdir(checkout)
  await reviewGit(checkout, 'init', '--quiet', '--template=', '--object-format=' + format)
  await reviewGit(checkout, 'config', '--local', 'core.hooksPath', resolve(scratch, 'hooks'))
  const originalHead = await reviewGit(root, 'rev-parse', '--verify', 'HEAD').then(value => value.trim(), () => null)
  if (originalHead) {
    await reviewGit(checkout, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules',
      '--no-write-fetch-head', '--update-shallow', '--', root, originalHead)
  }
  const head = originalHead ?? await emptyCommit(checkout, scratch)
  await reviewGit(checkout, 'update-ref', '--no-deref', 'HEAD', head)
  return head
}

/** Create the empty baseline commit in the scratch repository for an unborn source branch. */
async function emptyCommit(root: string, scratch: string): Promise<string> {
  const empty = resolve(scratch, 'empty')
  await writeFile(empty, '')
  const tree = (await reviewGit(root, 'hash-object', '-w', '-t', 'tree', '--no-filters', empty)).trim()
  return (await reviewGit(root, '-c', 'user.name=Anureo', '-c', 'user.email=anureo@localhost',
    '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Empty review baseline')).trim()
}

/** Copy current tracked and non-ignored untracked files before withAgentWorktree invokes its
 * callback. Exclude operational paths and both the configured and resolved workflow storage
 * paths. Reads are sequential and acquire no lock. Git or unexpected copy failures reject. */
async function copySource(root: string, checkout: string, directory: string): Promise<void> {
  const storage = await realpath(directory).catch(() => directory)
  const files = new Set((await reviewGit(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0'))
  for (const file of files) {
    if (!file || hasOperationalPathSegment(file.split('/'))) continue
    const source = resolve(root, file)
    if (isInsideDirectory(storage, source) || isInsideDirectory(directory, source)) continue
    await copySourceEntry({ root, checkout, file, source })
  }
}

/** Materialize regular files and symlinks with targets inside root, rebasing links to
 * the checkout. Treat ENOENT and ENOTDIR as absent entries because the index can still list
 * deleted paths. Other copy failures propagate to copySource. */
async function copySourceEntry({ root, checkout, file, source }: {
  root: string; checkout: string; file: string; source: string
}): Promise<void> {
  const parent = dirname(source)
  try {
    // Git can list old indexed children of a directory replaced by a symlink.
    if (await realpath(parent) !== parent) return
    const info = await lstat(source)
    const target = resolve(checkout, file)
    const targetParent = dirname(target)
    if (info.isFile()) {
      await mkdir(targetParent, { recursive: true })
      await copyFile(source, target)
      await chmod(target, info.mode & 0o7777)
    } else if (info.isSymbolicLink()) {
      const link = await realpath(source).catch(async (cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT' && cause.code !== 'ENOTDIR' && cause.code !== 'ELOOP') throw cause
        return resolve(parent, await readlink(source))
      })
      if (!isInsideDirectory(root, link)) return
      await mkdir(targetParent, { recursive: true })
      const localLink = relative(targetParent, resolve(checkout, relative(root, link))) || '.'
      const type = await lstat(link).then(value => value.isDirectory() ? 'dir' : 'file', () => 'file')
      await symlink(localLink, target, type)
    }
  } catch (cause) {
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause
  }
}
