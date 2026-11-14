// Exercises the subprocess graph adapter, with optional live Repograph coverage.
import { expect, test } from 'bun:test'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadGraph, repographProject, resolveRepographEntry } from '../src/graph'
import { exportGraph, type GraphArtifactContext } from '../src/graph-artifacts'
import { exec } from '../src/process'
import { temporary } from './helpers'

test('graph artifacts retain metadata and cover symbols under either spelling of the target', async () => {
  const outside = await temporary()
  const cwd = await realpath(await temporary())
  const directory = join(cwd, '.anureo', 'refactor', 'run')
  const alias = join(outside, 'alias')
  await exec('git', ['init', '-q', cwd])
  await mkdir(directory, { recursive: true })
  await writeFile(join(dirname(directory), '.gitignore'), 'writer.lock\n')
  await symlink(cwd, alias, 'junction')
  const entry = fileURLToPath(new URL('./fixtures/repograph.ts', import.meta.url))
  const context: GraphArtifactContext = {
    options: { cwd, graphLoader: async () => {
      expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe('*\n')
      return loadGraph(alias, entry)
    } },
    report: { directory, graphCoverage: [] }, progress: () => {},
  }
  const file = await exportGraph(context, 'design', ['main.ts', 'relative.ts', 'absolute.ts', 'canonical.ts', 'missing.ts'])
  expect(context.report.graphCoverage).toEqual([{ phase: 'design', status: 'available', filesWithoutSymbols: ['missing.ts'] }])
  expect(JSON.parse(await readFile(file!, 'utf8'))).toMatchObject({
    repositoryPath: alias, project: repographProject(alias), generatedAt: expect.any(String), files: { 'main.ts': { lines: 1 } },
  })
  await exec('git', ['-C', cwd, 'check-ignore', '--quiet', file!])
})

test('graph validation reports duplicate nodes and missing edge endpoints together', async () => {
  const cwd = await temporary()
  const entry = join(cwd, 'invalid.mjs')
  await writeFile(entry, `
    import { writeFileSync } from 'node:fs'
    const node = { id: 'duplicate', name: 'main', filePath: 'main.ts', labels: ['Function'], startLine: 1, endLine: 1 }
    writeFileSync(process.argv.at(-1), JSON.stringify({
      schemaVersion: 1, kind: 'all', repositoryPath: process.argv[3], indexReport: {}, nodes: [node, node],
      edges: [{ id: 'bad-edge', source: 'missing-source', target: 'missing-target', type: 'CALLS' }],
    }))
  `)
  await expect(loadGraph(cwd, entry)).rejects.toThrow(
    'Duplicate node ID "duplicate"\nEdge "bad-edge" references missing node IDs ["missing-source","missing-target"]',
  )
})

test.each(['stdout', 'stderr'])('graph export enforces the byte limit on %s', async stream => {
  const cwd = await temporary()
  const entry = join(cwd, 'overflow.mjs')
  await writeFile(entry, `
    process.${stream}.write(Buffer.alloc((8 << 20) + 1))
    setInterval(() => {}, 1000)
  `)
  await expect(loadGraph(cwd, entry)).rejects.toThrow(`repograph ${stream} exceeded the 8388608-byte output limit`)
})

const fixtures = [
  { language: 'TypeScript', extension: 'ts', main: 'import { save } from "./store";\nexport function main() { return save() }\n',
    store: 'export function save() { return 1 }\nexport function isolated() { return 2 }\n' },
  { language: 'Python', extension: 'py', main: 'from store import save\n\ndef main():\n    return save()\n',
    store: 'def save():\n    return 1\n\ndef isolated():\n    return 2\n' },
]

// Each live case uses the installed CLI or REPOGRAPH_CLI and owns its deterministic project key.
test.skipIf(process.env.REPOGRAPH_INTEGRATION !== '1').each(fixtures)('real repograph exports $language cross-file callers', async ({ extension, main, store }) => {
  const cwd = await realpath(await temporary())
  await exec('git', ['init', '-q', cwd])
  await writeFile(join(cwd, `main.${extension}`), main)
  await writeFile(join(cwd, `store.${extension}`), store)
  const entry = process.env.REPOGRAPH_CLI ?? resolveRepographEntry()
  const project = repographProject(cwd)
  const shim = createRequire(entry).resolve('codebase-memory-mcp/bin.js')
  const errors: unknown[] = []
  try {
    const graph = await loadGraph(cwd, entry)
    const byId = new Map(graph.nodes.map(node => [node.id, node.name]))
    expect(graph.edges.some(edge => edge.type === 'CALLS' && byId.get(edge.source) === 'main' && byId.get(edge.target) === 'save')).toBe(true)
    expect(graph.nodes.some(node => node.name === 'isolated')).toBe(true)
    expect(graph.indexReport.nodes).toBe(graph.nodes.length)
    expect(graph.indexReport.edges).toBe(graph.edges.length)
  } catch (cause) {
    errors.push(cause)
  } finally {
    try {
      await deleteTestProject(shim, project)
    } catch (cause) {
      errors.push(cause)
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, errors.map(String).join('\n'))
  if (errors.length) throw errors[0]
}, 120_000)

async function deleteTestProject(shim: string, project: string): Promise<void> {
  try {
    await exec(process.execPath, [shim, 'cli', '--json', 'delete_project', '--project', project], { timeout: 30_000 })
  } catch (cause) {
    // The native CLI uses exit status 1 when the exporter never created the project.
    const stdout = (cause as { stdout?: string }).stdout
    let result: { structuredContent?: { project?: string; status?: string } } | undefined
    try { result = stdout ? JSON.parse(stdout) : undefined } catch { throw cause }
    if (result?.structuredContent?.project !== project || result.structuredContent.status !== 'not_found') throw cause
  }
}
