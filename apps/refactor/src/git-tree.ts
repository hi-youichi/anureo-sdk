// Captures Git-visible repository state; it must not decide source eligibility or module assignments.
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { exec } from './process'

/** List sorted, unique tracked and unignored untracked paths under cwd via Git.
 * Snapshot callers supply an in-repository directory; paths are relative to it, including when
 * it is a subdirectory. Launches a read-only Git command; process/buffer failures reject. */
export async function gitFiles(cwd: string): Promise<string[]> {
  const stdout = await git(cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
  return [...new Set(stdout.split('\0').filter(Boolean))].sort()
}

/** Run Git against cwd even when invoked from a hook with repository-local environment overrides. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], gitProcessOptions())).stdout
}

/** Shared subprocess options for Git commands that read text or binary patches. */
export function gitProcessOptions() {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE', 'GIT_SHALLOW_FILE']) delete env[key]
  return { env, maxBuffer: 64 << 20 }
}

/** Resolve a preflight target to its real absolute path and require Git's work-tree probe to return true.
 * Accepts subdirectories.
 * refactorCode awaits this before opening run storage; filesystem failures propagate,
 * while process failures reject with the repository diagnostic below. Nothing is written. */
export async function repositoryDirectory(directory: string): Promise<string> {
  const cwd = await realpath(resolve(directory))
  // Keep the target directory rather than the Git root so subdirectory runs retain their scope.
  const stdout = await git(cwd, 'rev-parse', '--is-inside-work-tree')
    .catch(() => { throw new Error(`Not inside a Git work tree: ${cwd}`) })
  if (stdout.trim() !== 'true') throw new Error(`Not inside a Git work tree: ${cwd}`)
  return cwd
}

/** Read Git-visible modes and contents into a path/fingerprint map for host diffing and provenance.
 * inventory retains the whole tree for provenance before filtering eligible sources; runAgentWork compares
 * whole trees so edits outside source scope remain observable. Launches Git, then reads entries
 * serially in sorted path order without writing. Missing entries at lstat time are skipped; other
 * process/read errors reject. Run storage and Git metadata are excluded by isSnapshotPath.
 * Callers needing a stable baseline must coordinate writers; this is not atomic. */
export async function captureTree(cwd: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const file of await gitFiles(cwd)) {
    if (!isSnapshotPath(file)) continue
    const fingerprint = await fileFingerprint(cwd, file)
    if (fingerprint !== undefined) result.set(file, fingerprint)
  }
  return result
}

/** Read a fingerprint even for an ignored path, so integration detects local files in its way. */
export async function fileFingerprint(cwd: string, file: string): Promise<string | undefined> {
  const { path, info, linkedAncestor } = await inspectGitPath(cwd, file)
  if (linkedAncestor) throw new Error(`Symlink ancestors are unsupported: ${file}`)
  if (info) return captureFingerprint(path, info)
}

/** Inspect a Git-relative slash path without following symlinks in its ancestors. */
export async function inspectGitPath(cwd: string, file: string): Promise<{ path: string; info: Stats | null; linkedAncestor: boolean }> {
  const parts = file.split('/')
  if (isAbsolute(file) || file.includes('\\') || file.includes('\0')
    || (process.platform === 'win32' && file.includes(':'))
    || parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid source path: ${file}`)
  const target = resolve(cwd, file)
  const local = relative(cwd, target)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Source path escapes repository: ${file}`)
  }
  let path = cwd
  let info = null
  for (const part of parts) {
    path = resolve(path, part)
    info = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (!info || info.isSymbolicLink()) break
  }
  return { path: target, info: path === target ? info : null, linkedAncestor: path !== target && !!info?.isSymbolicLink() }
}

/** Return sorted added, removed or modified paths between two snapshots.
 * Compares supplied fingerprints without filesystem access or mutation; has no expected errors. */
export function changes(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort()
}

/** Hash supplied snapshot entries in iteration order for orchestration's prompt provenance.
 * Callers use captureTree's sorted insertion order: identical entries in a different order produce
 * a different version. Pure and non-mutating, with no expected errors; modes are included via fingerprints. */
export function treeVersion(tree: ReadonlyMap<string, string>): string {
  return createHash('sha256').update(JSON.stringify([...tree])).digest('hex')
}

/** Decide whether a Git-relative path belongs in host snapshots, without filesystem access.
 * Run storage must never count as an agent edit, even when force-added; Git metadata is also omitted.
 * Other non-source files remain visible so host diffing can detect edits outside agent scope. */
export function isSnapshotPath(file: string): boolean {
  return !file.split('/').some(part => ['.anureo', '.git'].includes(part.toLowerCase()))
}

/** Read one inspected path's mode/content fingerprint for captureTree.
 * Reads symlink text rather than its destination so broken/external links can be compared safely;
 * non-file entries use their mode as content. Read failures propagate. */
async function captureFingerprint(path: string, info: Stats): Promise<string> {
  let content: string | Buffer
  if (info.isSymbolicLink()) content = await readlink(path)
  else if (info.isFile()) content = await readFile(path)
  else content = String(info.mode)
  return createHash('sha256').update(String(info.mode)).update('\0').update(content).digest('hex')
}
