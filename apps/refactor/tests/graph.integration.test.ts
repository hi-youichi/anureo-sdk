// Optionally verifies the real repograph adapter; it must not run a live backend in the default suite.
import { expect, test } from 'bun:test'
import { realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultRepographEntry, loadGraph } from '../src/graph'
import { exec } from '../src/process'
import { temporary } from './helpers'

/** Opt-in live-backend check for adapter maintainers using REPOGRAPH_CLI or the default checkout.
 * Creates a fixture repository and index, then checks caller edges and index counts. Assertions,
 * process and backend failures reject; shared temporary() cleanup removes the repository, while
 * the finally block deletes the external index only after loadGraph has returned its identity. */
test.skipIf(process.env.REPOGRAPH_INTEGRATION !== '1')('real repograph exports cross-file callers for module review', async () => {
  const cwd = await realpath(await temporary())
  await exec('git', ['init', '-q', cwd])
  await writeFile(join(cwd, 'main.ts'), 'import { save } from "./store";\nexport function main() { return save() }\n')
  await writeFile(join(cwd, 'store.ts'), 'export function save() { return 1 }\nexport function isolated() { return 2 }\n')
  const entry = process.env.REPOGRAPH_CLI ?? defaultRepographEntry
  const graph = await loadGraph(cwd, entry)
  try {
    const byId = new Map(graph.nodes.map(node => [node.id, node.name]))
    expect(graph.edges.some(edge => edge.type === 'CALLS' && byId.get(edge.source) === 'main' && byId.get(edge.target) === 'save')).toBe(true)
    expect(graph.nodes.some(node => node.name === 'isolated')).toBe(true)
    expect(graph.indexReport.nodes).toBe(graph.nodes.length)
    expect(graph.indexReport.edges).toBe(graph.edges.length)
  } finally {
    // Optional integration-only cleanup through the adjacent checkout's backend;
    // production uses only its public CLI and reuses one index per target repo.
    const { runTool } = await import(join(dirname(entry), 'cbm.ts'))
    await runTool('delete_project', { project: graph.indexReport.project })
  }
}, 120_000)
