import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { resolve } from 'node:path'

/** Observed state used to detect changes and test regular-file eligibility. */
export interface TreeState {
  /** Identity of mode and captured content. Null denotes a missing path. */
  fingerprint: string | null
  regular: boolean
}

/** Fingerprint mode plus regular-file bytes or symlink text. ENOENT returns a null fingerprint.
 * Other filesystem failures reject. captureWorkingTreeBaseline and inspectWorkingTreeChanges
 * use these states to detect edits, and checkOriginalSources compares the target with its patch
 * baseline before applying. Callers supply an absolute checkout or scratch root and a
 * Git-root-relative path. They check parent path resolution where required.
 */
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
