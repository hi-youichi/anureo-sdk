// Captures fix baselines and reconciles allowed edits, including pre-existing changes and storage exclusions.
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { reviewGit } from './worktree'

/** Baseline of the isolated worktree. Files and diagnostics use Git-root-relative paths. */
interface WorkingTreeBaseline {
  root: string
  allowed: readonly string[]
  states: ReadonlyMap<string, TreeState>
}

/** Include selected files and preexisting Git-visible changes in the isolated checkout. */
export async function captureWorkingTreeBaseline(root: string, allowed: readonly string[]): Promise<WorkingTreeBaseline> {
  const files = new Set([...allowed, ...(await treeEntries(root)).keys()])
  const states = new Map(await Promise.all([...files].map(async file => [file, await fileState(root, file)] as const)))
  return { root, allowed, states }
}

/** Only existing selected files that remain regular files can become an applied edit. */
export async function inspectWorkingTreeChanges(baseline: WorkingTreeBaseline): Promise<{ changedFiles: string[]; violations: string[] }> {
  const { root, allowed, states: before } = baseline
  const scope = new Set(allowed)
  const changedFiles: string[] = []
  const violations: string[] = []
  const entries = await treeEntries(root)
  for (const file of new Set([...before.keys(), ...entries.keys()])) {
    const previous = before.get(file)
    const current = await fileState(root, file)
    if (current.fingerprint === (previous?.fingerprint ?? null)) continue
    if (scope.has(file) && previous?.regular && current.regular) changedFiles.push(file)
    else violations.push(`${entries.get(file)?.trim() || 'modified'} ${file}`)
  }
  return { changedFiles: changedFiles.sort(), violations }
}

interface TreeState {
  fingerprint: string | null
  regular: boolean
}

/** Disable rename detection so additions and removals are compared independently. */
async function treeEntries(root: string): Promise<Map<string, string>> {
  const entries = await reviewGit(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')
  return new Map(entries.split('\0').filter(Boolean).map(entry => [entry.slice(3), entry.slice(0, 2)]))
}

/** Fingerprint mode plus regular-file bytes or symlink text for scope comparison. Missing paths
 * return a null fingerprint; other filesystem failures reject rather than silently omit an edit.
 * Git change discovery supplies individual file paths. */
export async function fileState(cwd: string, file: string): Promise<TreeState> {
  const path = resolve(cwd, file)
  try {
    const info = await lstat(path)
    const content = info.isFile() ? await readFile(path) : info.isSymbolicLink() ? await readlink(path) : ''
    const fingerprint = createHash('sha256').update(String(info.mode)).update('\0').update(content).digest('hex')
    return { fingerprint, regular: info.isFile() }
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return { fingerprint: null, regular: false }
    }
    throw cause
  }
}
