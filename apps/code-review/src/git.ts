// Runs Git commands used to resolve and operate on review checkouts.
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { HarnessSdkError } from '@anureo/sdk'

/** Buffered execFile for internal Git calls that choose their own cwd, encoding or environment.
 * diffFile uses buffered bytes and accepts exit status 1 for a nonempty patch. Fingerprint reads
 * inherit the environment and map command failures to null. */
export const execGit = promisify(execFile)

/** Maximum buffered bytes per stdout or stderr stream for review Git commands. */
export const GIT_MAX_BUFFER = 1 << 24

/** Resolve the canonical Git worktree root from a review directory. prepareReview awaits this
 * before starting a fix-enabled workflow, and applyFix resolves it if none was supplied. Git or
 * realpath failures reject with REVIEW_FIX_INVALID and retain the original cause. */
export async function reviewRepositoryRoot(cwd: string): Promise<string> {
  try {
    const topLevel = await reviewGit(cwd, 'rev-parse', '--show-toplevel')
    return await realpath(topLevel.replace(/\r?\n$/, ''))
  } catch (cause) {
    throw new HarnessSdkError('REVIEW_FIX_INVALID',
      'Fix requires a usable git repository in the review directory', false, false, { cause })
  }
}

/** Run Git with cwd as its starting directory and return stdout as text. Clear the Git directory,
 * index and related overrides that hooks can inherit from another checkout. Process failures,
 * including output limit errors, reject. */
export async function reviewGit(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env }
  for (const name of repositoryEnvironment) delete env[name]
  return (await execGit('git', ['-C', cwd, ...args], { maxBuffer: GIT_MAX_BUFFER, env })).stdout
}

// Git hooks and wrappers can export these for their caller's checkout.
const repositoryEnvironment = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_PREFIX', 'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE']
