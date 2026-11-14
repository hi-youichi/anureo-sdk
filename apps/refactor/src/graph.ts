// Owns repograph CLI exports, graph validation and temporary export cleanup.
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { exec } from './process'

/** Shape of a Repograph `--kind all` export. Node and edge properties can carry exporter metadata
 * such as symbol metrics, call lines and imported names. startLine and endLine allow null for
 * nodes without a source range. loadGraph validates repository identity, node IDs and endpoints
 * in addition to parsing this shape. */
export type RepositoryGraph = z.infer<typeof graphSchema>

/** Supply a validated graph for the canonical, absolute target directory as RefactorOptions.graphLoader.
 * exportGraph awaits the callback under the run lock and writes its result to the phase artifact.
 * A rejection blocks the pending design or module work and is recorded as an incomplete run.
 * Implementations own validation and any processes, indexes or temporary resources they use.
 * Finish temporary cleanup before the returned promise settles. */
export type GraphLoader = (cwd: string) => Promise<RepositoryGraph>

/** Resolve the optional Repograph package's CLI entry for loadGraph's default and live tests.
 * Throws if the package cannot be resolved. Deferring resolution allows source-only runs. */
export function resolveRepographEntry(): string {
  return join(dirname(createRequire(import.meta.url).resolve('@youichi/repograph')), 'cli.js')
}

/** Export a validated graph for an absolute target directory. Supply an absolute CLI entry to
 * override the installed Repograph package. Both paths go unchanged to a subprocess started in
 * an OS temporary directory. The promise settles after temporary-directory cleanup, retaining the
 * external index for reuse. Serialize calls that share that index, whose key derives from the
 * supplied target path. exportGraph does this under the run lock before writing the phase artifact.
 * Package resolution, subprocess, filesystem, parse and validation errors reject. A cleanup
 * failure takes precedence over an earlier error. */
export async function loadGraph(cwd: string, entry = resolveRepographEntry()): Promise<RepositoryGraph> {
  const temporary = await mkdtemp(join(tmpdir(), 'anureo-refactor-graph-'))
  try {
    const graph = await exportRepositoryGraph({ cwd, entry, temporary })
    await validateRepositoryGraph(graph, cwd)
    return graph
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Validate the core export fields and retain language-specific node metadata. */
const graphSchema = z.object({
  schemaVersion: z.literal(1), repositoryPath: z.string(), kind: z.literal('all'),
  indexReport: z.record(z.string(), z.unknown()),
  nodes: z.array(z.looseObject({
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

/** Return the parsed CLI payload for loadGraph to validate. Await the subprocess before reading
 * graph.json from loadGraph's temporary directory. The subprocess has a five-minute timeout and
 * an 8 MiB output buffer limit. Process, filesystem, JSON and schema errors reject to loadGraph,
 * which removes the directory in either case. */
async function exportRepositoryGraph(input: { cwd: string; entry: string; temporary: string }): Promise<RepositoryGraph> {
  const { cwd, entry, temporary } = input
  const output = join(temporary, 'graph.json')
  // Keep the supplied path as the index key so repeated exports reuse the same project.
  const project = `anureo-refactor-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`
  await exec(process.execPath, [entry, 'export', cwd, '--kind', 'all', '--project', project, '--out', output],
    { cwd: temporary, maxBuffer: 8 << 20, timeout: 300_000 })
  return graphSchema.parse(JSON.parse(await readFile(output, 'utf8')))
}

/** Require a parsed graph to describe the same real directory and have unique node IDs and valid
 * edge references. loadGraph awaits this read-only check before returning the graph. Filesystem,
 * repository identity and graph integrity failures reject through loadGraph's cleanup. */
async function validateRepositoryGraph(graph: RepositoryGraph, cwd: string): Promise<void> {
  if (await realpath(graph.repositoryPath) !== await realpath(cwd)) throw new Error('repograph returned a different repository')
  const ids = new Set(graph.nodes.map(node => node.id))
  if (ids.size !== graph.nodes.length || graph.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new Error('repograph returned duplicate nodes or missing edge endpoints')
  }
}
