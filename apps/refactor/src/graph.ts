// Adapts and validates repograph CLI exports; it must not schedule agent work or persist run reports.
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { exec } from './process'

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
/** Repograph payload consumed by orchestration and embedders after schema, repository identity
 * and endpoint validation. This type alone does not validate externally constructed values. */
export type RepositoryGraph = z.infer<typeof graphSchema>
/** Injectable graph exporter: resolve a validated graph for cwd or reject export/validation failures.
 * Orchestration awaits it under the run lock; implementations may launch processes or maintain an
 * index and must finish temporary-resource cleanup before settling the promise. */
export type GraphLoader = (cwd: string) => Promise<RepositoryGraph>
/** Installed @youichi/repograph CLI used by loadGraph and CLI help, resolved relative to this package
 * so target/caller cwd and PATH cannot select another installation. The pinned release places its
 * CLI beside its exported library entry. Consumers may override it; resolution starts no process. */
export const defaultRepographEntry = join(dirname(createRequire(import.meta.url).resolve('@youichi/repograph')), 'cli.js')

/** Export and parse the CLI payload for loadGraph using its caller-owned temporary directory.
 * Launches repograph, writes graph.json and retains the external index; process, filesystem,
 * JSON and schema failures reject. Repository identity and endpoint checks must follow parsing. */
async function exportRepositoryGraph(input: { cwd: string; entry: string; temporary: string }): Promise<RepositoryGraph> {
  const { cwd, entry, temporary } = input
  const output = join(temporary, 'graph.json')
  // Hash the supplied path, not its realpath: changing this would select a different reusable index.
  const project = `anureo-refactor-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`
  await exec(process.execPath, [entry, 'export', cwd, '--kind', 'all', '--project', project, '--out', output],
    { cwd: temporary, maxBuffer: 8 << 20, timeout: 300_000 })
  return graphSchema.parse(JSON.parse(await readFile(output, 'utf8')))
}

/** Check a parsed payload before loadGraph exposes it to callers; does not mutate the graph.
 * Resolves repository paths on disk, rejecting filesystem errors, a different repository,
 * duplicate node IDs or dangling edges so downstream agents cannot trust a corrupt artifact. */
async function validateRepositoryGraph(graph: RepositoryGraph, cwd: string): Promise<void> {
  if (await realpath(graph.repositoryPath) !== await realpath(cwd)) throw new Error('repograph returned a different repository')
  const ids = new Set(graph.nodes.map(node => node.id))
  if (ids.size !== graph.nodes.length || graph.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new Error('repograph returned duplicate nodes or missing edge endpoints')
  }
}

/** Export cwd through the supplied CLI entry (or the installed npm package) and return a validated graph
 * to orchestration or embedders. Callers must serialize exports sharing the same path/index;
 * orchestration does so with its repository-wide run lock, which this adapter does not acquire.
 * Creates and removes temporary export files outside cwd so later indexing cannot treat them as
 * source, while retaining the path-derived external index for reuse. Process, parse, schema,
 * repository identity, endpoint and filesystem failures reject. Cleanup is awaited on success
 * and failure; a cleanup failure takes precedence over an earlier error. */
export async function loadGraph(cwd: string, entry = defaultRepographEntry): Promise<RepositoryGraph> {
  const temporary = await mkdtemp(join(tmpdir(), 'anureo-refactor-graph-'))
  try {
    const graph = await exportRepositoryGraph({ cwd, entry, temporary })
    await validateRepositoryGraph(graph, cwd)
    return graph
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
