// Scripted repograph subprocess. Exercises the real command-line boundary.
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
if (args[0] !== 'export' || args[args.indexOf('--kind') + 1] !== 'all') process.exit(3)
const output = args[args.indexOf('--out') + 1]!
if (resolve(output).startsWith(`${resolve(args[1]!)}/`)) process.exit(4)
await writeFile(output, JSON.stringify({
  schemaVersion: 1, kind: 'all', repositoryPath: args[1], indexReport: { status: 'indexed' },
  nodes: [{ id: 'main', name: 'main', filePath: 'main.ts', labels: ['Function'], startLine: 1, endLine: 1 }], edges: [],
}))
