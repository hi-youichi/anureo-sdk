import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnHarnessProcess } from '@anureo/sdk/process'
import { fixture as nativeFixture, startFake } from './helpers'

test('a bundled consumer runs on Node from an unrelated cwd against the native WS fixture', async () => {
  const native = await startFake(), directory = await mkdtemp(join(tmpdir(), 'anureo-hermes-node-'))
  try {
    const entry = join(directory, 'consumer.ts'), output = join(directory, 'consumer.mjs')
    const root = resolve(import.meta.dir, '../../../..')
    await writeFile(entry, `
import { createClient } from ${JSON.stringify(join(root, 'packages/core/src/index.ts'))}
import { createHermesAdapter } from ${JSON.stringify(join(root, 'packages/adapter/hermes/src/index.ts'))}
const client = await createClient({
  adapter: createHermesAdapter({ command: process.env.FIXTURE_BUN, args: [process.env.FIXTURE_ENTRY], env: process.env, timeoutMs: 2000 }),
  identity: { adapterId: 'hermes', runtimeConfigId: 'node-test' },
})
try {
  const session = await client.sessions.create({ cwd: process.cwd() })
  const result = await (await session.submit({ input: 'Node consumer' })).result()
  if (result.status !== 'completed' || result.text !== 'authoritative final') throw new Error('Invalid native result')
  const close = await session.close()
  if (close.executionStopped !== 'unconfirmed') throw new Error('False stop confirmation')
  console.log(JSON.stringify({ status: result.status, text: result.text }))
} finally { await client.dispose() }
`)
    const build = await Bun.build({ entrypoints: [entry], target: 'node', format: 'esm', outdir: directory, naming: 'consumer.mjs' })
    expect(build.success).toBe(true)
    const child = await spawnHarnessProcess({ command: 'node', args: [output], cwd: directory,
      env: { ...process.env, ...native.adapter().options.env, FIXTURE_BUN: process.execPath, FIXTURE_ENTRY: nativeFixture } })
    try {
      const stdout = readProcessOutput(child.stdout)
      const stderr = readProcessOutput(child.stderr)
      const [exit, result, errors] = await Promise.all([child.exited, stdout, stderr])
      expect(errors).toBe('')
      expect(exit.code).toBe(0)
      expect(JSON.parse(result)).toEqual({ status: 'completed', text: 'authoritative final' })
    } finally { await child.dispose() }
    expect((await native.state()).inputs).toHaveLength(1)
  } finally { await native.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 15_000)

/** Drain each consumer pipe concurrently with process exit so a full stdout/stderr pipe cannot stall the Node test. */
async function readProcessOutput(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let value = ''
  for await (const chunk of stream) value += new TextDecoder().decode(chunk)
  return value
}
