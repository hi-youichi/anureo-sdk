// Captures and compares Git-visible tree fingerprints for provenance and edit detection.
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import { inspectGitPath, isSnapshotPath } from './git-path'
import { gitFiles } from './git'

/** Read Git-visible modes and contents into a path/fingerprint map for host diffing and provenance.
 * inventory retains the whole tree for provenance before filtering eligible sources; runAgentWork compares
 * whole trees so edits outside source scope remain observable. Launches Git, then reads entries
 * serially in sorted path order without writing. Missing entries at inspection time are skipped.
 * Process, inspection and read failures reject. Run storage and Git metadata are excluded by
 * isSnapshotPath. Callers needing a stable baseline must coordinate writers during capture. */
export async function captureTree(cwd: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const file of await gitFiles(cwd)) {
    if (!isSnapshotPath(file)) continue
    const fingerprint = await fileFingerprint(cwd, file)
    if (fingerprint !== undefined) result.set(file, fingerprint)
  }
  return result
}

/** Fingerprint one Git-relative path or return undefined if it is missing at inspection time.
 * mergeWorktree also probes ignored paths directly to detect local files in its way.
 * Linked ancestors, invalid paths and inspection or content read failures reject. */
export async function fileFingerprint(cwd: string, file: string): Promise<string | undefined> {
  const { path, info, linkedAncestor } = await inspectGitPath(cwd, file)
  if (linkedAncestor) throw new Error(`Symlink ancestors are unsupported: ${file}`)
  if (info) return captureFingerprint(path, info)
}

/** Return sorted added, removed or modified paths between two snapshots.
 * Compares supplied fingerprints without filesystem access or mutation; has no expected errors. */
export function changes(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort()
}

/** Hash snapshot entries in iteration order for the source version in agent prompts.
 * runDesign and prepareModules use inventory's sorted insertion order, so callers constructing
 * equivalent snapshots must use the same order. Modes are included via fingerprints. */
export function treeVersion(tree: ReadonlyMap<string, string>): string {
  return createHash('sha256').update(JSON.stringify([...tree])).digest('hex')
}

/** Read one inspected path's mode/content fingerprint for fileFingerprint.
 * Reads symlink text rather than its destination so broken/external links can be compared safely;
 * non-file entries use their mode as content. Read failures propagate. */
async function captureFingerprint(path: string, info: Stats): Promise<string> {
  let content: string | Buffer
  if (info.isSymbolicLink()) content = await readlink(path)
  else if (info.isFile()) content = await readFile(path)
  else content = String(info.mode)
  return createHash('sha256').update(String(info.mode)).update('\0').update(content).digest('hex')
}
