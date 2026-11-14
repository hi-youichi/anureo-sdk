// Transfers a validated fix from its checkout to the original work tree.
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { fileState } from './file-state'
import { execGit, GIT_MAX_BUFFER, reviewGit } from './git'
import type { AgentWorktree } from './worktree'

/** Save regular, Git-root-relative source files under the worktree's scratch directory.
 * captureFixBaseline awaits these copies before agent dispatch. applyFixPatch uses them for the
 * diff and original-tree comparison. Copy failures and symlink paths reject.
 */
export function capturePatchBaseline(checkout: AgentWorktree, files: readonly string[]): Promise<void> {
  return copyPatchFiles(checkout, 'before', files)
}

/** Apply one binary-capable Git patch for the nonempty list of validated, Git-root-relative
 * edits supplied by applyFix. Uses the saved baseline to compare original bytes and mode
 * before applying. Git leaves the original index alone and rejects the patch as a
 * unit on a context conflict. A mismatched source or Git apply failure rejects as
 * REVIEW_FIX_CONFLICT. withAgentWorktree owns scratch cleanup.
 */
export async function applyFixPatch(root: string, checkout: AgentWorktree, files: readonly string[]): Promise<void> {
  await copyPatchFiles(checkout, 'after', files)
  const patchPath = await writeFixPatch(checkout.scratch, files)
  await checkOriginalSources(root, resolve(checkout.scratch, 'before'), files)
  try {
    await reviewGit(root, 'apply', '-p1', '--whitespace=nowarn', patchPath)
  } catch (cause) {
    throw new HarnessSdkError('REVIEW_FIX_CONFLICT', cause instanceof Error ? cause.message : String(cause))
  }
}

/** Copy Git-relative sources to the requested side of the patch, rejecting symlink paths
 * before copying each file. Partial copies stay in scratch for withAgentWorktree's cleanup.
 */
async function copyPatchFiles(checkout: AgentWorktree, phase: 'before' | 'after', files: readonly string[]): Promise<void> {
  const destinationRoot = resolve(checkout.scratch, phase)
  for (const file of files) {
    const source = resolve(checkout.root, file)
    if (await realpath(source) !== source) {
      throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix source traverses a symlink: ${file}`)
    }
    const destination = resolve(destinationRoot, file)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
}

/** Write the combined patch from staged before and after files. Read, diff and write
 * failures reject before applyFixPatch checks or writes original source files.
 */
async function writeFixPatch(scratch: string, files: readonly string[]): Promise<string> {
  const patches: Buffer[] = []
  for (const file of files) patches.push(await diffFile(scratch, file))
  const patchPath = resolve(scratch, 'fix.patch')
  await writeFile(patchPath, Buffer.concat(patches))
  return patchPath
}

/** Check every original target before applying any part of the patch. Reject missing paths,
 * symlink resolution, nonregular targets and fingerprint mismatches against the scratch baseline.
 */
async function checkOriginalSources(root: string, before: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const path = resolve(root, file)
    const originalPath = await realpath(path).catch(() => null)
    const current = originalPath === path ? await fileState(root, file) : null
    const prior = await fileState(before, file)
    if (!current?.regular || current.fingerprint !== prior.fingerprint) {
      throw new HarnessSdkError('REVIEW_FIX_CONFLICT', `Source changed during the fix: ${file}`)
    }
  }
}

/** Return the binary-capable patch bytes for one file. Git diff status 1 also carries a
 * successful patch on stdout. Other process failures reject.
 */
async function diffFile(cwd: string, file: string): Promise<Buffer> {
  try {
    const { stdout } = await execGit('git', ['diff', '--no-index', '--no-prefix', '--no-ext-diff', '--no-textconv',
      '--binary', '--', 'before/' + file, 'after/' + file], { cwd, encoding: 'buffer', maxBuffer: GIT_MAX_BUFFER })
    return stdout
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 1
      && 'stdout' in cause && Buffer.isBuffer(cause.stdout)) return cause.stdout
    throw cause
  }
}
