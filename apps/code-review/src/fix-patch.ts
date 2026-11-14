// Transfers a validated fix from its checkout to the original work tree.
import { execFile } from 'node:child_process'
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { HarnessSdkError } from '@anureo/sdk'
import { fileState } from './fix-tree'
import { reviewGit, type AgentWorktree } from './worktree'

const exec = promisify(execFile)

export async function capturePatchBaseline(checkout: AgentWorktree, files: readonly string[]): Promise<void> {
  for (const file of files) {
    await copySource(checkout.root, resolve(checkout.scratch, 'before'), file)
  }
}

/** Check original file bytes and mode before applying one Git patch to the work tree.
 * Git applies the patch as a unit on a context conflict and leaves the index alone. */
export async function applyFixPatch(root: string, checkout: AgentWorktree, files: readonly string[]): Promise<void> {
  const { scratch } = checkout
  for (const file of files) {
    await copySource(checkout.root, resolve(scratch, 'after'), file)
  }
  const patches: Buffer[] = []
  for (const file of files) patches.push(await diffFile(scratch, file))
  const patchPath = resolve(scratch, 'fix.patch')
  await writeFile(patchPath, Buffer.concat(patches))
  for (const file of files) {
    const path = resolve(root, file)
    const originalPath = await realpath(path).catch(() => null)
    const current = originalPath === path ? await fileState(root, file) : null
    const prior = await fileState(resolve(scratch, 'before'), file)
    if (!current?.regular || current.fingerprint !== prior.fingerprint) {
      throw new HarnessSdkError('REVIEW_FIX_CONFLICT', `Source changed during the fix: ${file}`)
    }
  }
  try {
    await reviewGit(root, 'apply', '-p1', '--whitespace=nowarn', patchPath)
  } catch (cause) {
    throw new HarnessSdkError('REVIEW_FIX_CONFLICT', cause instanceof Error ? cause.message : String(cause))
  }
}

async function copySource(from: string, to: string, file: string): Promise<void> {
  const source = resolve(from, file)
  const destination = resolve(to, file)
  if (await realpath(source) !== source) {
    throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix source traverses a symlink: ${file}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

async function diffFile(cwd: string, file: string): Promise<Buffer> {
  try {
    const { stdout } = await exec('git', ['diff', '--no-index', '--no-prefix', '--no-ext-diff', '--no-textconv',
      '--binary', '--', 'before/' + file, 'after/' + file], { cwd, encoding: 'buffer', maxBuffer: 1 << 24 })
    return stdout
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 1
      && 'stdout' in cause && Buffer.isBuffer(cause.stdout)) return cause.stdout
    throw cause
  }
}
