// Materializes Git-visible source and transfers edits between independent worktrees.
import { constants } from 'node:fs'
import { copyFile, cp, link, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { inspectGitPath, isSnapshotPath } from './git-path'
import { fileFingerprint } from './git-tree'
import { git, gitFiles } from './git'

/** Phase-owned snapshot shared by planning, agent checkouts and integration. */
export interface WorktreeBaseline {
  /** Canonical Git repository root, used for registry updates and integration. */
  root: string
  /** Target directory relative to the root, empty when the target is the root. */
  scope: string
  /** Commit used to register detached worktrees, including a synthetic commit for an unborn branch. */
  head: string
  /** Scratch directory owned and removed by withWorktreeBaseline. */
  directory: string
  /** Root of the copied working files, before applying the target scope. */
  source: string
  /** Whether the scratch directory contains a copy of the repository's index. */
  hasIndex: boolean
  /** Enqueue a Git registry mutation for this baseline and return its result or rejection.
   * A rejected update still releases the next queued update. */
  updateWorktreeRegistry: (update: () => Promise<string>) => Promise<string>
}

/** Linked checkout and scratch paths owned by the caller of createAgentWorktree. */
export interface AgentWorktree {
  /** Scoped directory supplied to the agent session. */
  cwd: string
  /** Full checkout root used to detect changes outside the scope and unregister the checkout. */
  root: string
  /** Scratch parent containing the checkout. */
  directory: string
}

/** Snapshot the index and Git-visible working files once before invoking a phase callback.
 * runDesign uses its snapshot for the design session and integration. refactorCode takes a new
 * one for planning, module work and ordered integration. The callback must await all worktree
 * use and removal before settling. Capture is sequential and assumes a stable source tree.
 * Returns the callback's result after scratch removal. Setup and callback failures reject, and
 * a scratch removal failure takes precedence. */
export async function withWorktreeBaseline<T>(cwd: string, use: (baseline: WorktreeBaseline) => Promise<T>): Promise<T> {
  const root = await realpath((await git(cwd, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, ''))
  const scope = relative(root, cwd)
  const directory = await temporary('baseline')
  try {
    const baseline = await snapshotBaseline({ root, scope, directory })
    return await use(baseline)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Register a detached checkout, restore the frozen index if present and copy the frozen working files.
 * Git skips checkout so hooks and filters cannot transform the copied files. inAgentWorktree passes
 * the scoped cwd to planning, and runAgentWork fingerprints the full root before starting the agent.
 * Both await removeAgentWorktree after use. Setup failures reject after attempting cleanup, and a
 * cleanup failure takes precedence. */
export async function createAgentWorktree(baseline: WorktreeBaseline): Promise<AgentWorktree> {
  const directory = await temporary('agent')
  const root = join(directory, 'checkout')
  const worktree = { cwd: join(root, baseline.scope), root, directory }
  try {
    await baseline.updateWorktreeRegistry(() => git(baseline.root, '-c', 'core.hooksPath=' + join(directory, 'hooks'),
      'worktree', 'add', '--detach', '--no-checkout', root, baseline.head))
  } catch (cause) {
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
  try {
    if (baseline.hasIndex) {
      const index = await gitIndexPath(root)
      await copyFile(join(baseline.directory, 'index'), index)
    }
    await cp(baseline.source, root, { recursive: true, verbatimSymlinks: true })
    return worktree
  } catch (cause) {
    await removeAgentWorktree(baseline, worktree)
    throw cause
  }
}

/** Release a checkout after the session and any integration settle. Unregister it through Git
 * before deleting its scratch directory. Failures reject with RESOURCE_RELEASE_FAILED and the
 * original cause. runAgentWork records the cleanup failure on the step, while inAgentWorktree
 * propagates it to planning. */
export async function removeAgentWorktree(baseline: WorktreeBaseline, worktree: AgentWorktree): Promise<void> {
  try {
    await baseline.updateWorktreeRegistry(() => git(baseline.root, 'worktree', 'remove', '--force', worktree.root))
    await rm(worktree.directory, { recursive: true, force: true })
  } catch (cause) {
    throw Object.assign(new Error(`Could not remove refactor worktree at ${worktree.root}`, { cause }), {
      code: 'RESOURCE_RELEASE_FAILED',
    })
  }
}

/** Copy installed dependencies for validation. Preserve local workspace links within the checkout. */
export async function prepareCheckDependencies(baseline: WorktreeBaseline, worktree: AgentWorktree): Promise<void> {
  const directories = ['']
  for (const directory of directories) {
    for (const entry of await readdir(join(baseline.source, directory), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') directories.push(join(directory, entry.name))
    }
    const modulePath = join(directory, 'node_modules')
    const from = join(baseline.root, modulePath)
    const to = join(worktree.root, modulePath)
    const installed = await lstat(from).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== 'ENOENT') throw cause
    })
    if (!installed) continue
    if (installed.isSymbolicLink()) {
      await mkdir(dirname(to), { recursive: true })
      await symlink(rebaseDependencyLink(await realpath(from), baseline.root, worktree.root), to, 'junction')
    } else if (installed.isDirectory()) {
      await cp(from, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      await rebaseDependencyLinks(to, baseline.root, worktree.root)
    }
  }
}

async function rebaseDependencyLinks(directory: string, source: string, target: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await rebaseDependencyLinks(path, source, target)
    else if (entry.isSymbolicLink()) {
      const link = await readlink(path)
      if (!isAbsolute(link)) continue
      const absolute = await realpath(path).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT' && cause.code !== 'ELOOP') throw cause
        return link
      })
      const rebased = rebaseDependencyLink(absolute, source, target)
      if (rebased === absolute) continue
      await rm(path)
      await symlink(rebased, path)
    }
  }
}

function rebaseDependencyLink(link: string, source: string, target: string): string {
  const inside = relative(source, link)
  return inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) ? link : join(target, inside)
}

/** Transfer verified files directly from a live checkout. The caller serializes integration.
 * Check every destination against its baseline before writing. Stage replacement contents on
 * the target filesystem and back up originals so a failed transfer can roll back. */
export async function mergeWorktree(
  baseline: WorktreeBaseline, worktree: AgentWorktree, files: readonly string[],
): Promise<void> {
  const target = join(baseline.root, baseline.scope)
  const original = join(baseline.source, baseline.scope)
  const entries = await Promise.all(files.map(async file => {
    const before = await inspectGitPath(target, file)
    if (await fileFingerprint(target, file) !== await fileFingerprint(original, file)) {
      throw new Error(`Source changed during refactor: ${file}`)
    }
    const after = await inspectGitPath(worktree.cwd, file)
    if (after.linkedAncestor || (after.info && !after.info.isFile()) || (before.info && !before.info.isFile())) {
      throw new Error(`Refactor merge requires regular files: ${file}`)
    }
    return { file, path: before.path, existed: !!before.info, replacement: !!after.info }
  }))

  const directory = await mkdtemp(join(target, '.anureo', 'refactor', 'merge-'))
  const staged = join(directory, 'staged')
  const applied: { path: string; backup?: string; installed: boolean }[] = []
  const createdDirectories: string[] = []
  let keepRecovery = false
  try {
    for (const entry of entries) {
      if (entry.replacement) await copyEntry(worktree.cwd, staged, entry.file)
    }
    for (const [index, entry] of entries.entries()) {
      if (await fileFingerprint(target, entry.file) !== await fileFingerprint(original, entry.file)) {
        throw new Error(`Source changed during refactor: ${entry.file}`)
      }
      const backup = entry.existed ? join(directory, String(index)) : undefined
      if (backup) await rename(entry.path, backup)
      const write = { path: entry.path, backup, installed: false }
      applied.push(write)
      if (entry.replacement) {
        const parent = dirname(entry.path)
        const firstCreated = await mkdir(parent, { recursive: true })
        if (firstCreated) {
          for (let path = parent; path !== dirname(firstCreated); path = dirname(path)) createdDirectories.push(path)
        }
        await link(join(staged, entry.file), entry.path)
        write.installed = true
      }
    }
  } catch (cause) {
    try {
      for (let index = applied.length - 1; index >= 0; index--) {
        const entry = applied[index]!
        if (entry.backup) await rename(entry.backup, entry.path)
        else if (entry.installed) await rm(entry.path, { force: true })
      }
      for (const path of [...new Set(createdDirectories)].sort((a, b) => b.length - a.length)) {
        await rmdir(path)
      }
    } catch (rollbackError) {
      keepRecovery = true
      throw Object.assign(new AggregateError([cause, rollbackError], `Could not roll back refactor merge. Recovery files: ${directory}`), {
        code: 'RESOURCE_RELEASE_FAILED',
      })
    }
    throw cause
  } finally {
    if (!keepRecovery) await rm(directory, { recursive: true, force: true })
  }
}

/** Allocate a scratch directory under the canonical temporary root. Callers own removal. */
async function temporary(kind: 'baseline' | 'agent'): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), `anureo-refactor-${kind}-`))
}

/** Populate the caller-owned scratch directory before exposing the baseline. Capture the index
 * before walking the working files, preserving Git's tracked and unignored untracked view.
 * Filesystem and Git failures reject so withWorktreeBaseline can remove partial snapshots. */
async function snapshotBaseline({ root, scope, directory }: Pick<WorktreeBaseline, 'root' | 'scope' | 'directory'>): Promise<WorktreeBaseline> {
  const source = join(directory, 'source')
  await mkdir(join(source, scope), { recursive: true })
  const head = await baselineHead(root, directory)
  const index = await gitIndexPath(root)
  const hasIndex = await copyFile(index, join(directory, 'index')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  for (const file of await gitFiles(root)) {
    if (isSnapshotPath(file)) await copyEntry(root, source, file)
  }
  return { root, scope, head, directory, source, hasIndex, updateWorktreeRegistry: createRegistryQueue() }
}

/** Resolve the index for the specific checkout, since linked worktrees have their own index paths.
 * Git failures reject. */
async function gitIndexPath(cwd: string): Promise<string> {
  return (await git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).replace(/\r?\n$/, '')
}

/** Serialize worktree add and remove callbacks within one baseline. Give each caller its own
 * outcome while allowing later registry operations to proceed after a rejection. */
function createRegistryQueue(): WorktreeBaseline['updateWorktreeRegistry'] {
  let registryReady = Promise.resolve()
  return update => {
    const result = registryReady.then(update)
    registryReady = result.then(() => {}, () => {})
    return result
  }
}

/** Resolve HEAD for snapshotBaseline. If Git reports it missing, write an empty tree and a
 * synthetic commit to the repository object store so linked checkouts can detach at a commit.
 * Ref pointers stay in place. Other Git and filesystem failures reject. */
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

/** Copy a Git path into a caller-owned staging tree, skipping missing entries so deletions stay
 * visible. Preserve final symlink text and represent directory entries without recursing into
 * submodules. Linked ancestors, unsupported entry types and filesystem failures reject. */
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
