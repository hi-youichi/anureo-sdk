import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Inventory, PackageSelection, SourceFile } from './types'

const ignoredDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'artifacts', 'generated', 'vendor', '.git'])
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/
const declaration = /\.d\.[cm]?ts$/
export const hashSource = (text: string): string => createHash('sha256').update(text).digest('hex')
export const sourceLines = (text: string): string[] => text.split(/\r?\n/)
const portable = (value: string): string => value.split(path.sep).join('/')

export function resolveInside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative)
  const relation = path.relative(root, resolved)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`Path escapes repository: ${relative}`)
  }
  return resolved
}

async function manifest(directory: string): Promise<{ name?: string; workspaces?: string[] | { packages: string[] } }> {
  return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
}

async function directories(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !ignoredDirectories.has(entry.name))
    .map(entry => entry.name).sort()
}

/** Deliberately support directory segments '*', '**', and literals; reject ambiguous syntax. */
async function expandWorkspace(root: string, pattern: string): Promise<string[]> {
  if (path.isAbsolute(pattern) || pattern.split('/').includes('..') || /[{}[\]?!\\]/.test(pattern)) {
    throw new Error(`Unsupported workspace pattern: ${pattern}; provide explicit packages instead`)
  }
  const segments = pattern.replace(/^\.\//, '').replace(/\/$/, '').split('/')
  if (segments.some(part => part.includes('*') && part !== '*' && part !== '**')) {
    throw new Error(`Unsupported workspace pattern: ${pattern}; provide explicit packages instead`)
  }
  async function visit(directory: string, index: number): Promise<string[]> {
    if (index === segments.length) {
      try { await stat(path.join(directory, 'package.json')); return [directory] }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause }
    }
    const segment = segments[index]!
    if (segment === '**') {
      const matches = await visit(directory, index + 1)
      for (const name of await directories(directory)) matches.push(...await visit(path.join(directory, name), index))
      return matches
    }
    if (segment === '*') {
      const matches: string[] = []
      for (const name of await directories(directory)) matches.push(...await visit(path.join(directory, name), index + 1))
      return matches
    }
    const child = path.join(directory, segment)
    // Only descend real directories, never directory symlinks.
    if (!(await directories(directory)).includes(segment)) return []
    return visit(child, index + 1)
  }
  return visit(root, 0)
}

export async function scanRepository(options: {
  root: string
  packages?: PackageSelection[]
  includeTests?: boolean
  signal?: AbortSignal
}): Promise<Inventory> {
  const root = await realpath(options.root)
  options.signal?.throwIfAborted()
  let packageRoots: string[]
  if (options.packages) {
    if (!options.packages.length) throw new Error('packages must not be empty')
    packageRoots = []
    for (const selection of options.packages) {
      const selected = resolveInside(root, selection.path)
      const directory = await realpath(selected)
      resolveInside(root, path.relative(root, directory))
      if (directory !== selected) throw new Error(`Use the real package path instead of a symlink: ${selection.path}`)
      packageRoots.push(directory)
    }
    if (new Set(packageRoots).size !== packageRoots.length) throw new Error('Duplicate package selection')
  } else {
    const config = await manifest(root)
    const patterns = Array.isArray(config.workspaces) ? config.workspaces : config.workspaces?.packages
    packageRoots = patterns ? [...new Set((await Promise.all(patterns.map(pattern => expandWorkspace(root, pattern)))).flat())] : [root]
  }
  if (!packageRoots.length) throw new Error('No workspace packages found')
  const inventory: Inventory = { root, packages: [], files: [] }
  for (const directory of packageRoots.sort()) {
    const config = await manifest(directory)
    const packagePath = portable(path.relative(root, directory)) || '.'
    inventory.packages.push({ path: packagePath, name: config.name ?? packagePath })
    async function walk(current: string): Promise<void> {
      options.signal?.throwIfAborted()
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue
          // Nested packages own their files, whether or not selected for this run.
          try { await stat(path.join(absolute, 'package.json')); continue }
          catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
          await walk(absolute)
        } else if (entry.isFile() && sourceExtension.test(entry.name) && !declaration.test(entry.name)) {
          const relative = portable(path.relative(directory, absolute))
          const isTest = /(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__)(?:\/|$)|\.(?:test|spec)\./.test(relative)
          if (isTest && !options.includeTests) continue
          const text = await readFile(absolute, 'utf8')
          inventory.files.push({ path: portable(path.relative(root, absolute)), packagePath,
            sha256: hashSource(text), lines: sourceLines(text).length, kind: isTest ? 'test' : 'source' })
        }
      }
    }
    await walk(directory)
  }
  return inventory
}

export async function detectSourceChanges(inventory: { root: string; files: ReadonlyArray<Pick<SourceFile, 'path' | 'sha256'>> }): Promise<string[]> {
  const changed: string[] = []
  for (const file of inventory.files) {
    try {
      // Recheck real paths in case a file was replaced by a symlink during the run.
      const absolute = await realpath(resolveInside(inventory.root, file.path))
      resolveInside(inventory.root, path.relative(inventory.root, absolute))
      if (hashSource(await readFile(absolute, 'utf8')) !== file.sha256) changed.push(file.path)
    } catch { changed.push(file.path) }
  }
  return [...new Set(changed)]
}
