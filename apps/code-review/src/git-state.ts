// Reads Git provenance for analysis, review, fix and verification prompts.
import { createHash } from 'node:crypto'
import { execGit, GIT_MAX_BUFFER } from './git'

/** Capture prompt provenance as a SHA-256 hash of Git HEAD and porcelain status, including
 * untracked paths. The hash covers command output only. Git inherits the process environment,
 * and the commands run sequentially without locking the source tree. Git failures return null,
 * including on an unborn branch.
 *
 * prepareReview also persists this value in workflow input. reviewModuleLifecycle, the queued
 * task in createFixRunner and verifyFinalTree refresh it for their prompts, which omit the
 * fingerprint when it is null. */
export async function readGitStateFingerprint(cwd: string): Promise<string | null> {
  try {
    const gitDirectory = ['-C', cwd]
    const options = { maxBuffer: GIT_MAX_BUFFER }
    const head = await execGit('git', [...gitDirectory, 'rev-parse', 'HEAD'], options)
    const status = await execGit('git', [...gitDirectory, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], options)
    return createHash('sha256').update(head.stdout).update('\0').update(status.stdout).digest('hex')
  } catch {
    return null
  }
}
