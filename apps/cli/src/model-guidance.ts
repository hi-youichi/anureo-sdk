import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseModelCatalog, parseModelGuidance, type ModelGuidance, type SwarmModelCatalog } from '@anureo/adapter-swarm'

type GuidanceEntries = Map<string, ModelGuidance | null>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

/** Validate every backend, including inactive ones, before selecting an overlay. */
function parseFile(value: unknown): Map<string, GuidanceEntries> {
  const document = object(value)
  if (document.version !== 1 || Object.keys(document).some(key => !['version', 'backends'].includes(key))) throw new Error('Expected version: 1 and backends')
  const backends = Object.entries(object(document.backends))
  if (backends.length > 64) throw new Error('Too many guidance backends')
  return new Map(backends.map(([backend, value]) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(backend)) throw new Error('Invalid backend ID')
    const entries = Object.entries(object(value))
    if (entries.length > 10_000) throw new Error('Too many guidance models')
    return [backend, new Map(entries.map(([id, guidance]) => {
      if (!id.trim() || id !== id.trim() || id.length > 512) throw new Error('Expected an exact model ID')
      return [id, guidance === null ? null : parseModelGuidance(guidance)]
    }))]
  }))
}

/** CLI-owned overlays. Whole project entries replace user entries; null removes inherited advice. */
export async function applyModelGuidance(catalog: SwarmModelCatalog, backend: string, project: string, homeDirectory = homedir()): Promise<SwarmModelCatalog> {
  const entries: GuidanceEntries = new Map()
  const files = [...new Set([homeDirectory, project].map(root => resolve(join(root, '.anureo', 'model-guidance.json'))))]
  for (const file of files) {
    try {
      const bytes = await readFile(file)
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Guidance file exceeds 2 MiB')
      const parsed = parseFile(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')))
      for (const [id, guidance] of parsed.get(backend) ?? []) entries.set(id, guidance)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw new Error(`Cannot load model guidance ${file}: ${(cause as Error).message}`, { cause })
    }
  }
  // Advice is never discovery: absent/unavailable IDs do not become selectable catalog entries.
  if (catalog.default?.status !== 'available') return catalog
  const models = catalog.default.models.map(model => {
    if (!entries.has(model.id)) return model
    const { guidance: _previous, ...native } = model
    const guidance = entries.get(model.id)
    return { ...native, ...(guidance ? { guidance } : {}) }
  })
  return { ...catalog, default: parseModelCatalog({ default: { ...catalog.default, models } }).default! }
}
