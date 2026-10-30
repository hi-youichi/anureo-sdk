import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { distributableDependencies } from './harness-sdk/dependencies'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const leaves = ['protocol', 'core', 'conformance', 'codex', 'claude', 'acp', 'ahp']
type Manifest = { name: string; version: string; private?: boolean; description?: string; license?: string; repository?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
const manifests = await Promise.all(leaves.map(async leaf => JSON.parse(await readFile(path.join(root, 'packages', leaf, 'package.json'), 'utf8')) as Manifest))
const versions = new Map(manifests.map(manifest => [manifest.name, manifest.version]))
if (versions.size !== leaves.length) throw new Error('SDK package names must be unique')
for (const manifest of manifests) {
  if (!manifest.name.startsWith('@anureo/')) throw new Error(`Unexpected package boundary: ${manifest.name}`)
  if (manifest.private === true) throw new Error(`Package must not be private for publication: ${manifest.name}`)
  for (const field of ['description', 'license', 'repository'] as const) if (!manifest[field]) throw new Error(`Missing npm metadata field ${field} on ${manifest.name}`)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    distributableDependencies(manifest[field], versions)
  }
}
async function inspect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'protocol'].includes(entry.name)) await inspect(filename)
    } else if (/\.(?:ts|mjs)$/.test(entry.name)) {
      const text = await readFile(filename, 'utf8')
      for (const match of text.matchAll(/(?:from\s*|import\s*\()\s*['"](@[^'"/]+\/[^'"/]+)(?:\/[^'"]*)?['"]/g)) {
        const name = match[1]!
        if (name.startsWith('@cowork/') || (name.startsWith('@anureo/') && !versions.has(name))) throw new Error(`Unexpected SDK import ${name} in ${path.relative(root, filename)}`)
      }
    }
  }
}
for (const leaf of leaves) await inspect(path.join(root, 'packages', leaf))
console.log(`SDK boundary check passed: ${manifests.length} independent packages`)
