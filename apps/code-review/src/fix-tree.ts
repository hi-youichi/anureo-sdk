// Reconciles fix edits against the isolated checkout's pre-agent state.
import { fileState, type TreeState } from './file-state'
import { reviewGit } from './git'

/** Capture selected files and existing Git-visible changes in the isolated checkout before
 * agent dispatch. captureFixBaseline retains this snapshot for the post-agent comparison.
 * root is the Git root and allowed paths are relative to it. Git and file-read failures reject.
 */
export async function captureWorkingTreeBaseline(root: string, allowed: readonly string[]): Promise<WorkingTreeBaseline> {
  const files = new Set([...allowed, ...(await treeEntries(root)).keys()])
  const states = new Map(await Promise.all([...files].map(async file => [file, await fileState(root, file)] as const)))
  return { root, allowed, states }
}

/** Compare baseline paths and current Git-visible changes after agent settlement. Including
 * baseline paths detects edits that restore a dirty file to its committed contents. Return
 * sorted Git-root-relative paths for selected files that were and remain regular, plus
 * diagnostics for other detected changes. checkFixChanges rejects those diagnostics before
 * integration. Git and file-read failures reject here.
 */
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

/** Isolated checkout snapshot from before agent execution. All paths except root are
 * Git-root-relative. states includes the allowed paths even when Git status is clean.
 */
interface WorkingTreeBaseline {
  root: string
  allowed: readonly string[]
  states: ReadonlyMap<string, TreeState>
}

/** Map changed Git paths to status codes for scope discovery and diagnostics. Disable rename
 * detection so additions and removals can be compared independently. Git failures reject.
 */
async function treeEntries(root: string): Promise<Map<string, string>> {
  const entries = await reviewGit(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')
  return new Map(entries.split('\0').filter(Boolean).map(entry => [entry.slice(3), entry.slice(0, 2)]))
}
