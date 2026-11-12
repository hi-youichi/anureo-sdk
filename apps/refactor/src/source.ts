import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ModulePlan } from './schema'

export const exec = promisify(execFile)
const excluded = new Set(['.git', '.anureo', '.repograph', 'node_modules', 'dist', 'build', 'coverage', 'vendor', 'generated', 'draft', 'docs'])
const sourceExtension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|sh|sql)$/i

export function isSource(file: string): boolean {
  return sourceExtension.test(file) && !file.split('/').some(part => excluded.has(part)) && !file.endsWith('.d.ts')
}

export async function gitFiles(cwd: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 << 20 })
  return [...new Set(stdout.split('\0').filter(Boolean))].sort()
}

export async function repositoryDirectory(directory: string): Promise<string> {
  const cwd = await realpath(resolve(directory))
  // Any directory inside a Git work tree is accepted; scope is that directory's Git-visible files.
  await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']).catch(() => { throw new Error(`Not inside a Git work tree: ${cwd}`) })
  return cwd
}

/** Git-visible files, including existing dirty/untracked contents and file modes.
 * Run storage is excluded even if a caller force-added it to Git. */
export async function captureTree(cwd: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const file of await gitFiles(cwd)) {
    if (file.split('/').some(part => part === '.anureo' || part === '.git')) continue
    const path = resolve(cwd, file)
    const info = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (!info) continue
    const content = info.isSymbolicLink() ? await readlink(path) : info.isFile() ? await readFile(path) : String(info.mode)
    result.set(file, createHash('sha256').update(String(info.mode)).update('\0').update(content).digest('hex'))
  }
  return result
}

export function changes(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort()
}

export function treeVersion(tree: ReadonlyMap<string, string>): string {
  return createHash('sha256').update(JSON.stringify([...tree])).digest('hex')
}

/** Reject escapes and symlinks, including existing parents of a new path. */
export async function validateSourcePath(cwd: string, file: string): Promise<void> {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..') || !isSource(file)) {
    throw new Error(`Invalid source path: ${file}`)
  }
  const local = relative(cwd, resolve(cwd, file))
  if (local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error(`Source path escapes repository: ${file}`)
  let parent = cwd
  for (const part of file.split('/')) {
    parent = resolve(parent, part)
    const info = await lstat(parent).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return null
      throw cause
    })
    if (info?.isSymbolicLink()) throw new Error(`Symlink source paths are unsupported: ${file}`)
    if (parent === resolve(cwd, file) && info && !info.isFile()) throw new Error(`Source is not a regular file: ${file}`)
  }
}

export function validatePlan(plan: ModulePlan, files: readonly string[]): void {
  const expected = new Set(files)
  const assigned = new Set<string>()
  const ids = new Set<string>()
  for (const module of plan.modules) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(module.id) || ids.has(module.id)) throw new Error(`Invalid or duplicate module id: ${module.id}`)
    ids.add(module.id)
    for (const file of module.files) {
      if (!expected.has(file) || assigned.has(file)) throw new Error(`Unlisted or duplicate module file: ${file}`)
      assigned.add(file)
    }
  }
  const missing = files.filter(file => !assigned.has(file))
  if (missing.length) throw new Error(`Module plan omitted source files: ${missing.join(', ')}`)
}
