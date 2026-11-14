// Owns repograph CLI exports, graph validation and temporary export cleanup.
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawnHarnessProcess } from '@anureo/sdk/process'
import { z } from 'zod'

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

export class RepographNotInstalledError extends Error {}

export class GraphCleanupError extends Error {
  readonly code = 'RESOURCE_RELEASE_FAILED'
}

/** Resolve the optional Repograph package's CLI entry for loadGraph's default and live tests.
 * Throws if the package cannot be resolved. Deferring resolution allows source-only runs. */
export function resolveRepographEntry(): string {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('@youichi/repograph')), 'cli.js')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw cause
    throw new RepographNotInstalledError('Cannot resolve the optional @youichi/repograph package', { cause })
  }
}

/** Keep the supplied path as the index key so repeated exports reuse the same project. */
export function repographProject(cwd: string): string {
  return `anureo-refactor-${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`
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
    await rm(temporary, { recursive: true, force: true }).catch(cause => {
      throw new GraphCleanupError(`Unable to remove temporary graph directory ${temporary}: ${cause.message}`, { cause })
    })
  }
}

/** Validate the core export fields and retain exporter and language-specific node metadata. */
const graphSchema = z.looseObject({
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

const exportTimeout = 300_000
const outputLimit = 8 << 20

/** Return the parsed CLI payload after the exporter has exited and its process tree is disposed. */
async function exportRepositoryGraph(input: { cwd: string; entry: string; temporary: string }): Promise<RepositoryGraph> {
  const { cwd, entry, temporary } = input
  const output = join(temporary, 'graph.json')
  const child = await spawnHarnessProcess({
    command: process.execPath, cwd: temporary,
    args: [entry, 'export', cwd, '--kind', 'all', '--project', repographProject(cwd), '--out', output],
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const completion = Promise.all([child.exited, drainOutput(child.stdout, 'stdout'), drainOutput(child.stderr, 'stderr')])
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`repograph export timed out after ${exportTimeout} ms`)), exportTimeout)
    })
    const [exit, , stderr] = await Promise.race([completion, deadline])
    if (exit.code !== 0) {
      const status = exit.signal ? `with signal ${exit.signal}` : `with code ${exit.code}`
      throw new Error(`repograph exited ${status}${stderr ? `: ${stderr}` : ''}`)
    }
  } finally {
    clearTimeout(timer)
    await child.dispose().catch(cause => {
      throw new GraphCleanupError(`Unable to dispose repograph process: ${cause.message}`, { cause })
    })
  }
  return graphSchema.parse(JSON.parse(await readFile(output, 'utf8')))
}

/** Enforce a byte limit on each pipe and retain stderr for exit diagnostics. */
async function drainOutput(stream: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr'): Promise<string> {
  let bytes = 0
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    bytes += chunk.byteLength
    if (bytes > outputLimit) throw new Error(`repograph ${name} exceeded the ${outputLimit}-byte output limit`)
    if (name === 'stderr') chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Require a parsed graph to describe the same real directory and have unique node IDs and valid
 * edge references. loadGraph awaits this read-only check before returning the graph. Filesystem,
 * repository identity and graph integrity failures reject through loadGraph's cleanup. */
async function validateRepositoryGraph(graph: RepositoryGraph, cwd: string): Promise<void> {
  if (await realpath(graph.repositoryPath) !== await realpath(cwd)) throw new Error('repograph returned a different repository')
  const ids = new Set<string>()
  let duplicateId: string | undefined
  for (const node of graph.nodes) {
    if (ids.has(node.id)) duplicateId ??= node.id
    ids.add(node.id)
  }
  const edge = graph.edges.find(edge => !ids.has(edge.source) || !ids.has(edge.target))
  const diagnostics: string[] = []
  if (duplicateId !== undefined) diagnostics.push(`Duplicate node ID ${JSON.stringify(duplicateId)}`)
  if (edge) {
    const missingIds = [...new Set([edge.source, edge.target])].filter(id => !ids.has(id))
    diagnostics.push(`Edge ${JSON.stringify(edge.id)} references missing node IDs ${JSON.stringify(missingIds)}`)
  }
  if (diagnostics.length) throw new Error(diagnostics.join('\n'))
}
