// Stand-in subprocess for the CLI suite's direct loadGraph and installed-entry tests.
// Checks the export kind and output location, then writes a minimal graph without indexing.
import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

const args = process.argv.slice(2)
const [command, repositoryPath] = args
if (command !== 'export' || args[args.indexOf('--kind') + 1] !== 'all') process.exit(3)
const output = args[args.indexOf('--out') + 1]
// Keeping the export outside the target prevents a later export from indexing it.
const relativeOutput = relative(repositoryPath, output)
if (!isAbsolute(relativeOutput) && !relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..') process.exit(4)
await writeFile(output, JSON.stringify({
  schemaVersion: 1, kind: 'all', repositoryPath, indexReport: { status: 'indexed' },
  nodes: [{ id: 'main', name: 'main', filePath: 'main.ts', labels: ['Function'], startLine: 1, endLine: 1,
    callable: { parameters: [], returnType: 'number' } }], edges: [],
}))
