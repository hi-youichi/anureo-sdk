// Owns repograph CLI exports, graph validation and temporary export cleanup.
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { exec } from './process'

/** Parsed shape of a repograph `--kind all` payload. loadGraph additionally checks repository
 * identity, unique node IDs and edge endpoints; this type alone performs no runtime validation. */
export type RepositoryGraph = z.infer<typeof graphSchema>

/** Supply a validated graph for the canonical, absolute target directory as RefactorOptions.graphLoader.
 * exportGraph awaits this instead of loadGraph, then writes the result as the phase's graph artifact.
 * A rejection prevents agent dispatch and is recorded as an incomplete run. Implementations own
 * validation and any processes, indexes or temporary resources they use; temporary cleanup must
 * finish before settling. Orchestration serializes calls under its run lock. */
export type GraphLoader = (cwd: string) => Promise<RepositoryGraph>

/** Resolve the optional exporter only when requested. */
export function resolveRepographEntry(): string {
  return join(dirname(createRequire(import.meta.url).resolve('@youichi/repograph')), 'cli.js')
}

/** Export an absolute target directory through the supplied absolute CLI entry, defaulting to the
 * installed npm package, and return a validated graph. Both paths are passed unchanged to a child
 * process started in a temporary directory. Callers must serialize exports sharing the same
 * path/index; orchestration's exportGraph calls this under the run lock before writing an artifact.
 * Creates export files in an OS temporary directory and removes that directory before settling,
 * while retaining the path-derived external index for reuse. Process, parse, schema,
 * repository identity, endpoint and filesystem failures reject. Cleanup is awaited on success
 * and failure; a cleanup failure takes precedence over an earlier error. */
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

/** Export and parse the CLI payload for loadGraph using its caller-owned temporary directory.
 * Awaits the repograph subprocess before reading graph.json and retains the external index;
 * process, filesystem, JSON and schema failures reject. Repository identity and endpoint checks
 * must follow parsing, and loadGraph owns temporary-directory cleanup even on rejection. */
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
 * duplicate node IDs or dangling edges before downstream agents can consume a corrupt artifact. */
async function validateRepositoryGraph(graph: RepositoryGraph, cwd: string): Promise<void> {
  if (await realpath(graph.repositoryPath) !== await realpath(cwd)) throw new Error('repograph returned a different repository')
  const ids = new Set(graph.nodes.map(node => node.id))
  if (ids.size !== graph.nodes.length || graph.edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new Error('repograph returned duplicate nodes or missing edge endpoints')
  }
}
