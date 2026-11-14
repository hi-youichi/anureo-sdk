// Materializes Git-visible source and transfers edits between independent worktrees.
import { copyFile, cp, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { inspectGitPath, isSnapshotPath } from './git-path'
import { fileFingerprint } from './git-tree'
import { git, gitFiles, gitProcessOptions } from './git'
import { exec } from './process'

/** Phase-owned snapshot shared by planning, agent checkouts and patch integration. */
export interface WorktreeBaseline {
  /** Canonical Git repository root, used for registry updates and patch application. */
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
  /** Scratch parent containing the checkout and any patch staging files. */
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

/** Release a checkout after the session and any patch capture settle. Unregister it through Git
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

/** Compare only the supplied scope-relative paths against the frozen baseline and return Git patch bytes.
 * For observed edits in edit mode, runAgentWork persists those bytes before removing the checkout,
 * even if the agent failed.
 * Requires a fresh checkout scratch directory for the before/after trees. Copy/diff failures and
 * empty output reject. The caller owns scratch cleanup through removeAgentWorktree. */
export async function captureWorktreePatch(
  baseline: WorktreeBaseline, worktree: AgentWorktree, files: readonly string[],
): Promise<Buffer> {
  const before = join(worktree.directory, 'before')
  const after = join(worktree.directory, 'after')
  const source = join(baseline.source, baseline.scope)
  await mkdir(before)
  await mkdir(after)
  for (const file of files) {
    await copyEntry(source, before, file)
    await copyEntry(worktree.cwd, after, file)
  }
  const patch = await diffPatchTrees(worktree.directory)
  if (!patch.length) throw new Error('Git could not represent the observed worktree changes')
  return patch
}

/** Apply a saved patch to the scoped working files after checking the supplied paths against the
 * baseline, including ignored local paths. The caller must pair the patch with its observed path
 * list and coordinate writers through the check and apply. Fingerprint errors, mismatches and
 * Git failures reject. integrateAgentWork records failures on the step and only runs checks after
 * a successful apply to a successful step. */
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

/** Diff the before/after trees for captureWorktreePatch. Git status 1 denotes a difference and
 * returns the buffered patch bytes. Other process failures propagate. */
async function diffPatchTrees(cwd: string): Promise<Buffer> {
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
