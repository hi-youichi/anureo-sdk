// Reconciles fix edits against the isolated checkout's pre-agent state.
import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { fileState, type TreeState } from './file-state'

/** Capture the checkout before agent dispatch, including files that Git ignores. */
export async function captureWorkingTreeBaseline(root: string, allowed: readonly string[]): Promise<WorkingTreeBaseline> {
  const states = await snapshotTree(root)
  for (const file of allowed) {
    if (!states.get(file)?.regular) {
      throw new HarnessSdkError('REVIEW_FIX_SCOPE', `Fix source must be an existing regular file: ${file}`)
    }
  }
  return { root, allowed, states }
}

/** Report eligible edits to existing selected regular files and all other changed paths. */
export async function inspectWorkingTreeChanges(baseline: WorkingTreeBaseline): Promise<{
  changedFiles: Map<string, TreeState>; violations: string[]
}> {
  const { root, allowed, states: before } = baseline
  const scope = new Set(allowed)
  const changedFiles = new Map<string, TreeState>()
  const violations: string[] = []
  const after = await snapshotTree(root)
  for (const file of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(file)
    const current = after.get(file)
    if (current?.fingerprint === previous?.fingerprint) continue
    if (scope.has(file) && previous?.regular && current?.regular) changedFiles.set(file, current)
    else violations.push(file)
  }
  return { changedFiles, violations }
}

interface WorkingTreeBaseline {
  root: string
  allowed: readonly string[]
  states: ReadonlyMap<string, TreeState>
}

/** Read one entry at a time and recurse into real directories. Git metadata is checked separately. */
async function snapshotTree(root: string): Promise<Map<string, TreeState>> {
  const states = new Map<string, TreeState>()
  async function visit(parent: string): Promise<void> {
    for (const name of await readdir(resolve(root, parent))) {
      if (parent === '' && name === '.git') continue
      const file = parent ? parent + '/' + name : name
      const info = await lstat(resolve(root, file))
      states.set(file, await fileState(root, file, info))
      if (info.isDirectory()) await visit(file)
    }
  }
  await visit('')
  return states
}
