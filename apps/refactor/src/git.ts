// Runs Git with checkout-local environment overrides removed.
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exec } from './process'

/** List sorted, unique tracked and unignored untracked paths under cwd via Git.
 * Snapshot callers supply an in-repository directory; paths are relative to it, including when
 * it is a subdirectory. Launches a read-only Git command; process/buffer failures reject. */
export async function gitFiles(cwd: string): Promise<string[]> {
  const stdout = await git(cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
  return [...new Set(stdout.split('\0').filter(Boolean))].sort()
}

/** Run Git with cwd as its starting directory and resolve buffered text stdout on success.
 * The command determines filesystem effects. Launch, nonzero exit and buffer failures reject
 * with the child-process error. Repository-local environment overrides from hooks are removed. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], gitProcessOptions())).stdout
}

/** Build a fresh environment without inherited repository selectors so Git discovers the caller's
 * checkout. git and diffPatchTrees use the same 64 MiB buffer limit for text and binary output. */
export function gitProcessOptions() {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE']) delete env[key]
  return { env, maxBuffer: 64 << 20 }
}

/** Resolve a preflight target to its real absolute path and require Git's work-tree probe to return true.
 * refactorCode uses the returned path before opening run storage, retaining any subdirectory
 * scope. Filesystem resolution failures propagate. A false probe or process failure rejects
 * with a repository diagnostic. */
export async function repositoryDirectory(directory: string): Promise<string> {
  const cwd = await realpath(resolve(directory))
  // Keep the target directory rather than the Git root so subdirectory runs retain their scope.
  const stdout = await git(cwd, 'rev-parse', '--is-inside-work-tree')
    .catch(() => { throw new Error(`Not inside a Git work tree: ${cwd}`) })
  if (stdout.trim() !== 'true') throw new Error(`Not inside a Git work tree: ${cwd}`)
  return cwd
}
