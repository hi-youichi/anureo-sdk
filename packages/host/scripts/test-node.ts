import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = await mkdtemp(join(tmpdir(), 'anureo-host-node-build-'))
try {
  const outfile = join(directory, 'host.mjs')
  const build = Bun.spawn([process.execPath, 'build', resolve(import.meta.dir, '../tests/node-smoke.ts'), '--target=node', '--outfile', outfile], { stdout: 'inherit', stderr: 'inherit' })
  if (await build.exited !== 0) throw new Error('Could not bundle the Host Node smoke test')
  const node = Bun.spawn(['node', outfile], { stdout: 'inherit', stderr: 'inherit' })
  if (await node.exited !== 0) throw new Error('Host Node smoke test failed')
} finally {
  await rm(directory, { recursive: true, force: true })
}
