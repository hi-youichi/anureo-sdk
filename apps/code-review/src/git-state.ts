// Reads Git provenance for analysis, review, fix and verification prompts.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

/** Internal prompt provenance captured before analysis, module review, each fix and final verification.
 * Hash HEAD and porcelain status, not file contents; reads are sequential and do not freeze sources.
 * Any Git failure returns null, including directories outside a repository or without a HEAD commit. */
export async function readGitStateFingerprint(cwd: string): Promise<string | null> {
  try {
    const head = await execReview('git', ['-C', cwd, 'rev-parse', 'HEAD'], { maxBuffer: 1 << 24 })
    const status = await execReview('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 1 << 24 })
    return createHash('sha256').update(head.stdout).update('\0').update(status.stdout).digest('hex')
  } catch {
    return null
  }
}

const execReview = promisify(execFile)
