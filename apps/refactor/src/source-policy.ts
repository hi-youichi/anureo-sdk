// Defines eligible source paths and filesystem safety; it must not snapshot Git or validate agent plans.
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Test a repository-relative slash path against inventory policy without accessing the filesystem.
 * inventory supplies this predicate to its snapshot-path filter, then awaits validateSourcePath
 * for each retained path before dispatch. This predicate alone does not validate syntax or safety. */
export function isSource(file: string): boolean {
  return sourceExtension.test(file) && !file.split('/').some(part => excluded.has(part)) && !file.endsWith('.d.ts')
}

/** Check a source path beneath inventory's already-resolved cwd, reading each existing ancestor in order.
 * Rejects invalid syntax, excluded files, escapes, symlinks and existing non-file targets; missing paths
 * are allowed. inventory awaits this check; rejection prevents dispatch from that inventory.
 * No files are changed; other lstat failures propagate. Checking every ancestor prevents
 * a symlink hiding an escape, but does not protect against concurrent replacement after inspection. */
export async function validateSourcePath(cwd: string, file: string): Promise<void> {
  const target = resolveSourcePath(cwd, file)
  let parent = cwd
  for (const part of file.split('/')) {
    parent = resolve(parent, part)
    const info = await lstat(parent).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (info?.isSymbolicLink()) throw new Error(`Symlink source paths are unsupported: ${file}`)
    if (parent === target && info && !info.isFile()) throw new Error(`Source is not a regular file: ${file}`)
  }
}

/** Exclude non-source trees so indexing and agent scope do not absorb dependencies or their own output. */
const excluded = new Set(['.git', '.anureo', '.repograph', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'generated', 'draft', 'docs'])
/** Supported source suffixes; .d.ts paths are excluded separately because they are not edit targets. */
const sourceExtension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|sh|sql)$/i

/** Resolve an eligible, syntactically safe slash path beneath cwd for validateSourcePath.
 * Rejects invalid source paths and lexical escapes before any filesystem access; does not follow
 * symlinks. The caller must still inspect existing ancestors before trusting the returned path. */
function resolveSourcePath(cwd: string, file: string): string {
  if (!hasSafePathSyntax(file) || !isSource(file)) {
    throw new Error(`Invalid source path: ${file}`)
  }
  const target = resolve(cwd, file)
  const local = relative(cwd, target)
  if (local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Source path escapes repository: ${file}`)
  return target
}

/** Require a relative slash path with no empty or dot segments before resolving it beneath cwd.
 * Keep syntax separate from source eligibility so malformed paths are rejected before filesystem I/O. */
function hasSafePathSyntax(file: string): boolean {
  return !isAbsolute(file)
    && !file.includes('\\')
    && !file.split('/').some(part => !part || part === '.' || part === '..')
}
