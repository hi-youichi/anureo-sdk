// Emulates repograph's export subprocess for adapter/CLI tests; it must not index a real repository.
// Accepts loadGraph's complete argv, writes a minimal graph to --out, and lets write failures reject.
import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

const args = process.argv.slice(2)
if (args[0] !== 'export' || args[args.indexOf('--kind') + 1] !== 'all') process.exit(3)
const output = args[args.indexOf('--out') + 1]!
// An export inside the target would be indexed on the next run; fail the adapter test if it drifts.
const local = relative(args[1]!, output)
if (!isAbsolute(local) && !local.startsWith(`..${sep}`) && local !== '..') process.exit(4)
await writeFile(output, JSON.stringify({
  schemaVersion: 1, kind: 'all', repositoryPath: args[1], indexReport: { status: 'indexed' },
  nodes: [{ id: 'main', name: 'main', filePath: 'main.ts', labels: ['Function'], startLine: 1, endLine: 1,
    callable: { parameters: [], returnType: 'number' } }], edges: [],
}))
