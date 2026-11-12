// Defines eligible source paths and filesystem safety; it must not snapshot Git or validate agent plans.
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Exclude non-source trees so indexing and agent scope do not absorb dependencies or their own output. */
const excluded = new Set(['.git', '.anureo', '.repograph', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'generated', 'draft', 'docs'])
/** Supported source suffixes; .d.ts paths are excluded separately because they are not edit targets. */
const sourceExtension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|sh|sql)$/i

/** Test a repository-relative slash path against inventory policy without accessing the filesystem.
 * Inventory discovery and path validation share eligibility rules. This pure predicate does not
 * validate path syntax or filesystem safety; inventory must call validateSourcePath before dispatch. */
export function isSource(file: string): boolean {
  return sourceExtension.test(file) && !file.split('/').some(part => excluded.has(part)) && !file.endsWith('.d.ts')
}

/** Resolve an eligible, syntactically safe slash path beneath cwd for validateSourcePath.
 * Rejects invalid source paths and lexical escapes before any filesystem access; does not follow
 * symlinks. The caller must still inspect existing ancestors before trusting the returned path. */
function resolveSourcePath(cwd: string, file: string): string {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..') || !isSource(file)) {
    throw new Error(`Invalid source path: ${file}`)
  }
  const target = resolve(cwd, file)
  const local = relative(cwd, target)
  if (local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Source path escapes repository: ${file}`)
  return target
}

/** Check a source path beneath inventory's already-resolved cwd, reading each existing ancestor in order.
 * Rejects invalid syntax, excluded files, escapes, symlinks and existing non-file targets; missing paths
 * are allowed. No files are changed; other lstat failures propagate. Checking every ancestor prevents
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
