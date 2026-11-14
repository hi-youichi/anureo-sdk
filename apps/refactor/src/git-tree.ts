// Captures Git-visible repository state; it must not decide source eligibility or module assignments.
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exec } from './process'

/** List sorted, unique tracked and unignored untracked paths under cwd via Git.
 * Snapshot callers supply an in-repository directory; paths are relative to it, including when
 * it is a subdirectory. Launches a read-only Git command; process/buffer failures reject. */
export async function gitFiles(cwd: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 << 20 })
  return [...new Set(stdout.split('\0').filter(Boolean))].sort()
}

/** Resolve a preflight target to its real absolute path and require Git's work-tree probe to succeed.
 * Accepts subdirectories; only the probe's exit status is checked, not its printed boolean.
 * refactorCode awaits this before opening run storage; filesystem failures propagate,
 * while process failures reject with the repository diagnostic below. Nothing is written. */
export async function repositoryDirectory(directory: string): Promise<string> {
  const cwd = await realpath(resolve(directory))
  // Keep the target directory rather than the Git root so subdirectory runs retain their scope.
  await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']).catch(() => { throw new Error(`Not inside a Git work tree: ${cwd}`) })
  return cwd
}

/** Read Git-visible modes and contents into a path/fingerprint map for host diffing and provenance.
 * inventory retains the whole tree for provenance before filtering eligible sources; runStep compares
 * whole trees so edits outside source scope remain observable. Launches Git, then reads entries
 * serially in sorted path order without writing. Missing entries at lstat time are skipped; other
 * process/read errors reject. Run storage and Git metadata are excluded by isSnapshotPath.
 * Callers needing a stable baseline must coordinate writers; this is not atomic. */
export async function captureTree(cwd: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const file of await gitFiles(cwd)) {
    if (!isSnapshotPath(file)) continue
    const fingerprint = await captureFingerprint(resolve(cwd, file))
    if (fingerprint !== null) result.set(file, fingerprint)
  }
  return result
}

/** Return sorted added, removed or modified paths between runStep's before/after snapshots.
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
function isSnapshotPath(file: string): boolean {
  return !file.split('/').some(part => part === '.anureo' || part === '.git')
}

/** Read one absolute path's mode/content fingerprint for captureTree, or null if lstat finds it missing.
 * Reads symlink text rather than its destination so broken/external links can be compared safely;
 * non-file entries use their mode as content. Only lstat ENOENT is ignored: a later read failure
 * must reject rather than silently publish a partial snapshot. Does not write files. */
async function captureFingerprint(path: string): Promise<string | null> {
  const info = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null
    throw cause
  })
  if (!info) return null

  let content: string | Buffer
  if (info.isSymbolicLink()) content = await readlink(path)
  else if (info.isFile()) content = await readFile(path)
  else content = String(info.mode)
  return createHash('sha256').update(String(info.mode)).update('\0').update(content).digest('hex')
}
