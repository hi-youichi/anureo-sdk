// Creates a private Git checkout of the current source for one agent session.
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { HarnessSdkError } from '@anureo/sdk'
import { isInsideDirectory, OPERATIONAL_PATH_SEGMENTS } from './paths'

const exec = promisify(execFile)
const maxBuffer = 1 << 24
// Git hooks and wrappers can export these for their caller's checkout.
const repositoryEnvironment = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_PREFIX', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE']

export interface AgentWorktree {
  root: string
  scratch: string
}

export async function reviewRepositoryRoot(cwd: string): Promise<string> {
  try {
    return await realpath((await reviewGit(cwd, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, ''))
  } catch (cause) {
    throw new HarnessSdkError('REVIEW_FIX_INVALID',
      'Fix requires a usable git repository in the review directory', false, false, { cause })
  }
}

/** Run against a freshly materialized source view when root is supplied. Remove the checkout
 * after the session settles, including on validation and execution failures. */
export async function withAgentWorktree<T>(
  options: { root?: string; cwd: string; directory: string },
  use: (cwd: string, directory: string, worktree?: AgentWorktree) => Promise<T>,
): Promise<T> {
  const { root, cwd, directory } = options
  if (root === undefined) return use(cwd, directory)
  const scratch = await mkdtemp(resolve(await realpath(tmpdir()), 'anureo-review-'))
  const checkout = resolve(scratch, 'checkout')
  let registered = false
  let failed = false
  try {
    const head = await reviewGit(root, 'rev-parse', '--verify', 'HEAD').then(value => value.trim(), () => emptyCommit(root, scratch))
    await reviewGit(root, '-c', 'core.hooksPath=' + resolve(scratch, 'hooks'),
      'worktree', 'add', '--detach', '--no-checkout', checkout, head)
    registered = true
    await reviewGit(checkout, 'read-tree', head)
    await copySource(root, checkout, directory)
    const localCwd = resolve(checkout, relative(root, cwd))
    const localDirectory = isInsideDirectory(root, directory) ? resolve(checkout, relative(root, directory)) : directory
    await mkdir(localCwd, { recursive: true })
    return await use(localCwd, localDirectory, { root: checkout, scratch })
  } catch (cause) {
    failed = true
    throw cause
  } finally {
    try {
      if (registered) await reviewGit(root, 'worktree', 'remove', '--force', checkout)
      await rm(scratch, { recursive: true, force: true })
    } catch (cause) {
      if (!failed) throw new HarnessSdkError('REVIEW_FIX_CLEANUP',
        `Could not remove temporary worktree at ${checkout}`, false, false, { cause })
      // Preserve the primary agent/validation error. A failed removal leaves its checkout for inspection.
    }
  }
}

/** Git output is used for path lists and metadata. Patches are handled as bytes. */
export async function reviewGit(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env }
  for (const name of repositoryEnvironment) delete env[name]
  return (await exec('git', ['-C', cwd, ...args], { maxBuffer, env })).stdout
}

async function emptyCommit(root: string, scratch: string): Promise<string> {
  const empty = resolve(scratch, 'empty')
  await writeFile(empty, '')
  const tree = (await reviewGit(root, 'hash-object', '-w', '-t', 'tree', '--no-filters', empty)).trim()
  return (await reviewGit(root, '-c', 'user.name=Anureo', '-c', 'user.email=anureo@localhost',
    '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Empty review baseline')).trim()
}

async function copySource(root: string, checkout: string, directory: string): Promise<void> {
  const storage = await realpath(directory).catch(() => directory)
  const files = new Set((await reviewGit(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0'))
  for (const file of files) {
    if (!file || file.split('/').some(part => (OPERATIONAL_PATH_SEGMENTS as readonly string[]).includes(part))) continue
    const source = resolve(root, file)
    if (isInsideDirectory(storage, source) || isInsideDirectory(directory, source)) continue
    const parent = dirname(source)
    try {
      // Git can list old indexed children of a directory replaced by a symlink.
      if (await realpath(parent) !== parent) continue
      const info = await lstat(source)
      const target = resolve(checkout, file)
      if (info.isFile()) {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(source, target)
      } else if (info.isSymbolicLink()) {
        const link = resolve(parent, await readlink(source))
        if (!isInsideDirectory(root, link)) continue
        await mkdir(dirname(target), { recursive: true })
        const localLink = relative(dirname(target), resolve(checkout, relative(root, link))) || '.'
        const type = await lstat(link).then(value => value.isDirectory() ? 'dir' : 'file', () => 'file')
        await symlink(localLink, target, type)
      }
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'code' in cause && ['ENOENT', 'ENOTDIR'].includes(String(cause.code)))) throw cause
    }
  }
}
