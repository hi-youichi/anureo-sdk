// Validates Git-relative paths and defines which paths belong in host snapshots.
import type { Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolve a Git-relative slash path under cwd and inspect it one component at a time.
 * A missing component or linked ancestor leaves info null. linkedAncestor distinguishes those
 * cases so fileFingerprint and copyEntry can reject traversal while allowing a final symlink.
 * Invalid paths and stat failures other than ENOENT reject. The result describes the inspection,
 * so callers that read or copy the path afterwards need a stable tree. */
export async function inspectGitPath(cwd: string, file: string): Promise<{ path: string; info: Stats | null; linkedAncestor: boolean }> {
  const parts = file.split('/')
  const target = resolveGitPath(cwd, file, parts)
  let entry = cwd
  let info: Stats | null = null
  for (const part of parts) {
    entry = resolve(entry, part)
    info = await lstat(entry).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (!info || info.isSymbolicLink()) break
  }
  if (entry === target) return { path: target, info, linkedAncestor: false }
  return { path: target, info: null, linkedAncestor: info?.isSymbolicLink() ?? false }
}

/** Decide whether a Git-relative path belongs in host snapshots, without filesystem access.
 * Run storage must never count as an agent edit, even when force-added; Git metadata is also omitted.
 * Other non-source files remain visible so host diffing can detect edits outside agent scope. */
export function isSnapshotPath(file: string): boolean {
  return !file.split('/').some(part => ['.anureo', '.git'].includes(part.toLowerCase()))
}

/** Reject noncanonical Git path components before host path resolution, then check containment
 * using the platform's path rules. This lexical check performs no filesystem access. */
function resolveGitPath(cwd: string, file: string, parts: readonly string[]): string {
  if (isAbsolute(file) || file.includes('\\') || file.includes('\0')
    || (process.platform === 'win32' && file.includes(':'))
    || parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid source path: ${file}`)
  const target = resolve(cwd, file)
  const local = relative(cwd, target)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Source path escapes repository: ${file}`)
  }
  return target
}
