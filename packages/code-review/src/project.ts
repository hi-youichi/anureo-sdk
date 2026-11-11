import { readFile } from 'node:fs/promises'
import { z } from 'zod'

/** A marker locates an ownership boundary; it does not establish dependency or runtime semantics. */
export const projectMarkers = ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile', 'mix.exs', 'Package.swift', 'CMakeLists.txt']
export function isProjectMarker(name: string) { return projectMarkers.includes(name) || /\.(csproj|fsproj|vbproj)$/.test(name) }
export function isEntryContract(path: string) {
  const name = path.split('/').at(-1)!
  return isProjectMarker(name) || /^(README(?:\.[\w-]+)*|AGENTS\.md)$/i.test(name)
}
const pathSchema = z.string().min(1).refine(path => path !== '..' && !path.startsWith('/') && !path.includes('\\')
  && path.split('/').every(part => part !== '..' && part !== '') && (path === '.' || !path.split('/').includes('.')), 'Use a canonical repository-relative path')
const flowSchema = z.strictObject({
  id: z.string().min(1), purpose: z.string().min(1), paths: z.array(pathSchema), symbols: z.array(z.string().min(1)),
})
export const designConfigSchema = z.strictObject({
  version: z.literal(1),
  groups: z.array(z.strictObject({ path: pathSchema, name: z.string().min(1) })).default([]),
  flows: z.array(flowSchema).optional(),
  contracts: z.array(pathSchema).default([]),
  writeGroups: z.array(z.array(pathSchema).min(1)).default([]),
})
export type DesignConfig = z.output<typeof designConfigSchema>
/** Configuration describes this review target; it never changes the reusable design rules. */
export async function readDesignConfig(path: string): Promise<DesignConfig> {
  const config = designConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  if (new Set(config.groups.map(g => g.path)).size !== config.groups.length) throw new Error('Duplicate review group paths')
  if (config.flows && new Set(config.flows.map(f => f.id)).size !== config.flows.length) throw new Error('Duplicate flow IDs')
  const writePaths = config.writeGroups.flat()
  if (new Set(writePaths).size !== writePaths.length) throw new Error('Write groups must not contain duplicate or overlapping paths')
  return config
}
