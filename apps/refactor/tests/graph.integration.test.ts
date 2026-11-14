// Optionally verifies the real repograph adapter; it must not run a live backend in the default suite.
import { expect, test } from 'bun:test'
import { realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadGraph, resolveRepographEntry } from '../src/graph'
import { exec } from '../src/process'
import { temporary } from './helpers'

/** Opt-in live-backend check for adapter maintainers using the installed package or REPOGRAPH_CLI.
 * Creates a fixture repository and index, then checks caller edges and index counts. Assertions,
 * process and backend failures reject; shared temporary() cleanup removes the repository, while
 * the finally block deletes the external index only after loadGraph has returned its identity. */
const fixtures = [
  { language: 'TypeScript', extension: 'ts', main: 'import { save } from "./store";\nexport function main() { return save() }\n',
    store: 'export function save() { return 1 }\nexport function isolated() { return 2 }\n' },
  { language: 'Python', extension: 'py', main: 'from store import save\n\ndef main():\n    return save()\n',
    store: 'def save():\n    return 1\n\ndef isolated():\n    return 2\n' },
]

test.skipIf(process.env.REPOGRAPH_INTEGRATION !== '1').each(fixtures)('real repograph exports $language cross-file callers', async ({ extension, main, store }) => {
  const cwd = await realpath(await temporary())
  await exec('git', ['init', '-q', cwd])
  await writeFile(join(cwd, `main.${extension}`), main)
  await writeFile(join(cwd, `store.${extension}`), store)
  const entry = process.env.REPOGRAPH_CLI ?? resolveRepographEntry()
  const graph = await loadGraph(cwd, entry)
  try {
    const byId = new Map(graph.nodes.map(node => [node.id, node.name]))
    expect(graph.edges.some(edge => edge.type === 'CALLS' && byId.get(edge.source) === 'main' && byId.get(edge.target) === 'save')).toBe(true)
    expect(graph.nodes.some(node => node.name === 'isolated')).toBe(true)
    expect(graph.indexReport.nodes).toBe(graph.nodes.length)
    expect(graph.indexReport.edges).toBe(graph.edges.length)
  } finally {
    // Test-only cleanup through the package's backend (or a TS source override);
    // production uses only the public CLI and reuses one index per target repo.
    const { runTool } = await import(join(dirname(entry), entry.endsWith('.ts') ? 'cbm.ts' : 'cbm.js'))
    await runTool('delete_project', { project: graph.indexReport.project })
  }
}, 120_000)
