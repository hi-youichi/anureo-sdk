import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseBeeProfile, type BeeProfile } from '@anureo/adapter-swarm'

const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === 'ENOENT'

export async function findProjectRoot(cwd: string): Promise<string> {
  const start = resolve(cwd)
  for (let directory = start; ; directory = dirname(directory)) {
    const marker = await stat(join(directory, '.git')).catch(cause => {
      if (!missing(cause)) throw cause
    })
    if (marker && (marker.isDirectory() || marker.isFile())) return directory
    if (dirname(directory) === directory) return start
  }
}

async function profileFiles(root: string): Promise<Array<[string, string]>> {
  const directory = join(root, '.anureo', 'bees')
  const entries = await readdir(directory, { withFileTypes: true }).catch(cause => {
    if (!missing(cause)) throw cause
    return []
  })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => [entry.name.slice(0, -5), join(directory, entry.name)])
}

/** Discover effective profiles in the user and project directories. Project files replace the same ID. */
export async function loadBeeProfiles(cwd: string, homeDirectory = homedir()): Promise<Array<{ profile: BeeProfile; file: string }>> {
  const [userFiles, projectFiles] = await Promise.all([
    profileFiles(homeDirectory),
    findProjectRoot(cwd).then(profileFiles),
  ])
  const effective = new Map([...userFiles, ...projectFiles])
  const files = [...effective].sort(([left], [right]) => left.localeCompare(right))
  return Promise.all(files.map(async ([id, file]) => {
    try {
      const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
      let value: unknown
      try { value = JSON.parse(text) } catch { throw new Error('Expected valid JSON') }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
      if ('id' in value && value.id !== id) throw new Error(`Profile id must match the filename "${id}"`)
      return { profile: parseBeeProfile({ ...value, id }), file }
    } catch (cause) {
      throw new Error(`Cannot load bee profile ${file}: ${(cause as Error).message}`, { cause })
    }
  }))
}
