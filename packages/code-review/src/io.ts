import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isProjectMarker, type DesignConfig } from './project'

export type Package = { path: string; name: string; files: string[] }
export const reportRoots = ['.anureo/reviews', '.anureo/fixes', 'draft/docs/readability-review', 'draft/docs/readability-fix', 'draft/docs/design-review']
export function isReviewOutput(path: string, exclusions: readonly string[] = []) {
  return [...reportRoots, ...exclusions].some(root => path === root || path.startsWith(`${root}/`))
}

/** Git-visible scope, including untracked sources, excluding every review artifact root. */
export async function discoverPackages(cwd: string, groups: DesignConfig['groups'] = [], exclusions: readonly string[] = []): Promise<Package[]> {
  cwd = await realpath(cwd)
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], {
    cwd, maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8').split('\0').filter(Boolean)
  const files = [...new Set(listed)].sort().filter(path => {
    const inside = relative(cwd, resolve(cwd, path))
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error(`Invalid project path: ${path}`)
    return !isReviewOutput(path, exclusions)
  })
  for (const group of groups) {
    if (group.path !== '.' && (!group.path || group.path.split('/').some(p => !p || p === '.' || p === '..') || group.path.startsWith('/') || group.path.includes('\\'))) throw new Error(`Invalid review group path: ${group.path}`)
    if (!files.some(path => group.path === '.' || path.startsWith(`${group.path}/`))) throw new Error(`Empty review group: ${group.path}`)
  }
  if (new Set(groups.map(g => g.path)).size !== groups.length) throw new Error('Duplicate review group paths')
  const directories = new Set(['.', ...files.filter(path => isProjectMarker(path.split('/').at(-1)!)).map(dirname), ...groups.map(g => g.path)])
  const packages = new Map<string, Package>()
  for (const path of directories) {
    let name = path === '.' ? 'project-root' : path
    try {
      const manifestPath = join(cwd, path, 'package.json')
      const relativeManifest = path === '.' ? 'package.json' : `${path}/package.json`
      if (!files.includes(relativeManifest) || await realpath(dirname(manifestPath)) !== dirname(manifestPath)
        || !(await lstat(manifestPath)).isFile()) throw new Error('No inventory-owned regular manifest')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (typeof manifest.name === 'string') name = manifest.name
    } catch { /* A missing/invalid manifest still owns files by directory. */ }
    packages.set(path, { path, name: groups.find(g => g.path === path)?.name ?? name, files: [] })
  }
  for (const file of files) {
    let directory = dirname(file)
    while (!packages.has(directory)) directory = dirname(directory)
    packages.get(directory)!.files.push(file)
  }
  return [...packages.values()].filter(pkg => pkg.files.length > 0).sort((a, b) => a.path.localeCompare(b.path))
}

export function createGate(concurrency: number) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be an integer from 1 to 16')
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve))
    else active++
    try { return await run() } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/** Unique temp paths avoid torn records; each logical artifact has one writer. */
export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, path)
}
export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
