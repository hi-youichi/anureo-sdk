// Selects the paths and text eligible for review and editing.
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { inspectGitPath } from './git-path'

/** Match a Git-relative path against source scope rules without reading the filesystem.
 * Built-in path exclusions and explicit exclude globs take precedence over include globs.
 * With no includes, conventional supporting files are skipped. inventory and runAgentWork
 * follow a successful match with isTextSource before accepting a source path. */
export function isSource(file: string, include: readonly string[] = [], exclude: readonly string[] = []): boolean {
  if (isExcluded(file)) return false
  if (exclude.some(pattern => posix.matchesGlob(file, pattern))) return false
  if (include.length) return include.some(pattern => posix.matchesGlob(file, pattern))
  return !supportingFile.test(posix.basename(file))
}

/** Check a Git-relative regular file for UTF-8 or BOM-marked UTF-16 text. inventory skips false
 * results, and runAgentWork treats them as assignment violations for new unassigned paths.
 * Missing paths, nonfiles, undecodable data and disallowed control characters return false.
 * Invalid paths, built-in exclusions, symlinks and filesystem failures other than missing
 * entries during inspection reject. Callers apply include and exclude globs through isSource. */
export async function isTextSource(cwd: string, file: string): Promise<boolean> {
  if (isExcluded(file)) throw new Error(`Invalid source path: ${file}`)
  const { path, info, linkedAncestor } = await inspectGitPath(cwd, file)
  if (linkedAncestor || info?.isSymbolicLink()) throw new Error(`Symlink source paths are unsupported: ${file}`)
  if (!info?.isFile()) return false
  return isSupportedText(await readFile(path))
}

/** Exclude dependency, build, documentation and run artifacts from the editable scope. */
const excluded = new Set(['.git', '.anureo', '.repograph', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'generated', 'draft', 'docs'])
/** Repository metadata and conventional standalone prose. Explicit includes can select these files. */
const supportingFile = /^(?:\.(?:gitignore|gitattributes|gitmodules|editorconfig)|package(?:-lock)?\.json|(?:bun|yarn|Cargo|uv|poetry)\.lockb?|pnpm-lock\.ya?ml|(?:README|LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|CONTRIBUTING|AGENTS)(?:\.(?:md|txt|rst|adoc))?)$/i

/** Match hard exclusions against any path component, regardless of case or glob settings. */
function isExcluded(file: string): boolean {
  return file.split('/').some(part => excluded.has(part.toLowerCase()))
}

/** Default to UTF-8 unless a UTF-16 byte-order mark is present. Decode strictly so invalid
 * byte sequences cannot pass through as replacement characters. */
function isSupportedText(content: Buffer): boolean {
  let encoding = 'utf-8'
  if (content[0] === 0xff && content[1] === 0xfe) encoding = 'utf-16le'
  if (content[0] === 0xfe && content[1] === 0xff) encoding = 'utf-16be'
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(content)
    return !/[\x00-\x08\x0b\x0e-\x1f]/.test(text)
  } catch { return false }
}
