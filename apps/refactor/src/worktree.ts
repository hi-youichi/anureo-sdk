// Materializes Git-visible source and transfers edits between independent worktrees.
import { copyFile, cp, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileFingerprint, git, gitFiles, gitProcessOptions, inspectGitPath, isSnapshotPath } from './git-tree'
import { exec } from './process'

export interface WorktreeBaseline {
  root: string
  scope: string
  head: string
  directory: string
  source: string
  hasIndex: boolean
}

export interface AgentWorktree {
  cwd: string
  root: string
  directory: string
}

/** Freeze the current source and index once so every session in a phase sees the same dirty tree. */
export async function withWorktreeBaseline<T>(cwd: string, use: (baseline: WorktreeBaseline) => Promise<T>): Promise<T> {
  const root = await realpath((await git(cwd, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, ''))
  const scope = relative(root, cwd)
  const directory = await temporary('baseline')
  const source = join(directory, 'source')
  try {
    await mkdir(join(source, scope), { recursive: true })
    const head = await baselineHead(root, directory)
    const index = (await git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).replace(/\r?\n$/, '')
    const hasIndex = await copyFile(index, join(directory, 'index')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    for (const file of await gitFiles(root)) {
      if (isSnapshotPath(file)) await copyEntry(root, source, file)
    }
    return await use({ root, scope, head, directory, source, hasIndex })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Create a detached linked checkout without running checkout hooks or transforming dirty files. */
export async function createAgentWorktree(baseline: WorktreeBaseline): Promise<AgentWorktree> {
  const directory = await temporary('agent')
  const root = join(directory, 'checkout')
  const worktree = { cwd: join(root, baseline.scope), root, directory }
  let registered = false
  try {
    await git(baseline.root, '-c', 'core.hooksPath=' + join(directory, 'hooks'),
      'worktree', 'add', '--detach', '--no-checkout', root, baseline.head)
    registered = true
    if (baseline.hasIndex) {
      const index = (await git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).replace(/\r?\n$/, '')
      await copyFile(join(baseline.directory, 'index'), index)
    }
    await cp(baseline.source, root, { recursive: true, verbatimSymlinks: true })
    return worktree
  } catch (cause) {
    if (registered) await removeAgentWorktree(baseline, worktree)
    else await rm(directory, { recursive: true, force: true })
    throw cause
  }
}

/** Remove a linked checkout through Git before deleting its scratch directory. */
export async function removeAgentWorktree(baseline: WorktreeBaseline, worktree: AgentWorktree): Promise<void> {
  try {
    await git(baseline.root, 'worktree', 'remove', '--force', worktree.root)
    await rm(worktree.directory, { recursive: true, force: true })
  } catch (cause) {
    throw Object.assign(new Error(`Could not remove refactor worktree at ${worktree.root}`, { cause }), {
      code: 'RESOURCE_RELEASE_FAILED',
    })
  }
}

/** Capture a binary-capable patch while the agent's checkout is still available. */
export async function captureWorktreePatch(
  baseline: WorktreeBaseline, worktree: AgentWorktree, files: readonly string[],
): Promise<Buffer> {
  const before = join(worktree.directory, 'before')
  const after = join(worktree.directory, 'after')
  await mkdir(before)
  await mkdir(after)
  for (const file of files) {
    await copyEntry(join(baseline.source, baseline.scope), before, file)
    await copyEntry(worktree.cwd, after, file)
  }
  const patch = await diff(worktree.directory)
  if (!patch.length) throw new Error('Git could not represent the observed worktree changes')
  return patch
}

/** Apply one patch to the target working files after comparing them with the frozen baseline. */
export async function applyWorktreePatch(
  baseline: WorktreeBaseline, files: readonly string[], patchPath: string,
): Promise<void> {
  const target = join(baseline.root, baseline.scope)
  const source = join(baseline.source, baseline.scope)
  for (const file of files) {
    if (await fileFingerprint(target, file) !== await fileFingerprint(source, file)) {
      throw new Error(`Source changed during refactor: ${file}`)
    }
  }
  const scope = baseline.scope ? ['--directory=' + baseline.scope.split(sep).join('/')] : []
  await git(baseline.root, 'apply', '-p2', ...scope, '--whitespace=nowarn', patchPath)
}

async function temporary(kind: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), `anureo-refactor-${kind}-`))
}

/** Linked worktrees need a commit even when the target has an unborn branch. */
async function baselineHead(root: string, directory: string): Promise<string> {
  try {
    return (await git(root, 'rev-parse', '--verify', '--quiet', 'HEAD')).trim()
  } catch (cause) {
    if ((cause as { code?: unknown }).code !== 1) throw cause
  }
  const empty = join(directory, 'empty')
  await writeFile(empty, '')
  const tree = (await git(root, 'hash-object', '-w', '-t', 'tree', empty)).trim()
  return (await git(root, '-c', 'user.name=Anureo', '-c', 'user.email=anureo@localhost',
    '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Empty refactor baseline')).trim()
}

/** Copy one Git path without traversing symlink ancestors or recursively copying submodules. */
async function copyEntry(from: string, to: string, file: string): Promise<void> {
  const { path, info, linkedAncestor } = await inspectGitPath(from, file)
  if (linkedAncestor) throw new Error(`Symlink ancestors are unsupported: ${file}`)
  if (!info) return
  const destination = join(to, file)
  await mkdir(dirname(destination), { recursive: true })
  if (info.isFile()) await copyFile(path, destination)
  else if (info.isSymbolicLink()) await symlink(await readlink(path), destination)
  else if (info.isDirectory()) await mkdir(destination, { recursive: true, mode: info.mode })
  else throw new Error(`Unsupported Git path: ${file}`)
}

/** Git returns status 1 for an ordinary no-index diff. Preserve the bytes for application. */
async function diff(cwd: string): Promise<Buffer> {
  try {
    const { stdout } = await exec('git', ['diff', '--no-index', '--no-renames', '--no-ext-diff',
      '--no-textconv', '--no-color', '--binary', '--src-prefix=a/', '--dst-prefix=b/', '--', 'before', 'after'],
    { ...gitProcessOptions(), cwd, encoding: 'buffer' })
    return stdout
  } catch (cause) {
    const error = cause as { code?: unknown; stdout?: unknown }
    if (error.code === 1 && Buffer.isBuffer(error.stdout)) return error.stdout
    throw cause
  }
}
