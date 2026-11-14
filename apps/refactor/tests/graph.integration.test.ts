// Exercises the real Repograph exporter only when REPOGRAPH_INTEGRATION=1.
import { expect, test } from 'bun:test'
import { realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadGraph, resolveRepographEntry } from '../src/graph'
import { exec } from '../src/process'
import { temporary } from './helpers'

const fixtures = [
  { language: 'TypeScript', extension: 'ts', main: 'import { save } from "./store";\nexport function main() { return save() }\n',
    store: 'export function save() { return 1 }\nexport function isolated() { return 2 }\n' },
  { language: 'Python', extension: 'py', main: 'from store import save\n\ndef main():\n    return save()\n',
    store: 'def save():\n    return 1\n\ndef isolated():\n    return 2\n' },
]

// Each live case uses the installed CLI or REPOGRAPH_CLI. The shared temporary() hook removes
// its Git repository, and the test uses the returned index report to attempt project deletion.
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
    // Use the sibling backend matching the CLI's source or installed layout to delete the index.
    const backend = entry.endsWith('.ts') ? 'cbm.ts' : 'cbm.js'
    const { runTool } = await import(join(dirname(entry), backend))
    await runTool('delete_project', { project: graph.indexReport.project })
  }
}, 120_000)
