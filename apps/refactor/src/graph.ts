import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { exec } from './source'

/** Shape of the repograph `--kind all` export that this package relies on. Unknown extra fields
 * are dropped by zod, so every field an agent should see in the graph artifact is listed here. */
const graphSchema = z.object({
  schemaVersion: z.literal(1), repositoryPath: z.string(), kind: z.literal('all'),
  indexReport: z.record(z.string(), z.unknown()),
  nodes: z.array(z.object({
    id: z.string(), name: z.string(), filePath: z.string(), labels: z.array(z.string()),
    startLine: z.number().nullable(), endLine: z.number().nullable(),
    // Upstream metrics (lines, complexity, cognitive, param_count, is_test...). Agents read them
    // from the artifact to find large or tightly connected functions; do not drop them.
    properties: z.record(z.string(), z.unknown()).optional(),
  })),
  edges: z.array(z.object({
    id: z.string(), source: z.string(), target: z.string(), type: z.string(),
    // CALLS: call line. IMPORTS: imported name (local_name). Both are used to locate evidence.
    properties: z.record(z.string(), z.unknown()).optional(),
  })),
})
export type RepositoryGraph = z.infer<typeof graphSchema>
export type GraphLoader = (cwd: string) => Promise<RepositoryGraph>
/** The sibling repograph checkout (../repograph); override with `--repograph`. */
export const defaultRepographEntry = fileURLToPath(new URL('../../../../repograph/src/cli.ts', import.meta.url))

/** Run the repograph CLI on `cwd` and return its validated graph.
 *
 * The JSON is written to a temporary directory outside `cwd` so a later indexing run never treats
 * the export as source. The upstream index name is derived from `cwd`, so repeated exports of the
 * same directory reuse one index; this is safe because callers hold the repository-wide refactor
 * lock. Throws if the graph describes a different repository, has duplicate node IDs, or has an
 * edge whose endpoint is missing, since agents would otherwise trust a corrupt artifact. */
export async function loadGraph(cwd: string, entry = defaultRepographEntry): Promise<RepositoryGraph> {
  const temporary = await mkdtemp(join(tmpdir(), 'anureo-refactor-graph-'))
  try {
    const output = join(temporary, 'graph.json')
    const project = `anureo-refactor-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`
    await exec(process.execPath, [entry, 'export', cwd, '--kind', 'all', '--project', project, '--out', output],
      { cwd: temporary, maxBuffer: 8 << 20, timeout: 300_000 })
    const graph = graphSchema.parse(JSON.parse(await readFile(output, 'utf8')))
    if (await realpath(graph.repositoryPath) !== await realpath(cwd)) throw new Error('repograph returned a different repository')
    const ids = new Set(graph.nodes.map(node => node.id))
    if (ids.size !== graph.nodes.length || graph.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) {
      throw new Error('repograph returned duplicate nodes or missing edge endpoints')
    }
    return graph
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
