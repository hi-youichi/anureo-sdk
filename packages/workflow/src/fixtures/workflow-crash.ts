import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createClient } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'

const [directory, phase] = process.argv.slice(2) as [string, string]
const originalRename = fs.rename
let journalPublishes = 0
// Install before importing workflow so atomic publication uses the injected rename.
// workflow.test.ts restarts this process for each boundary and inspects recovery.
mock.module('node:fs/promises', () => ({ ...fs, rename: renameAtCrashBoundary }))
const { workflow, agent } = await import('../index')

const adapter = createScriptedAdapter()
const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'crash-fixture' } })
try {
  await workflow({ directory, name: 'crash-test', revision: '1', input: {}, runId: 'crashed' }, async () =>
    agent('work', { client, cwd: directory }))
} finally {
  await client.dispose()
}

/** Installed as fs.rename by mock.module and invoked by atomicPublish before replacing a file.
 * Kill before the started record, result record or completed manifest reaches its target,
 * according to the test's phase; all earlier renames use the original filesystem operation. */
async function renameAtCrashBoundary(from: string, to: string): Promise<void> {
  const target = to.replaceAll('\\', '/')
  if (target.endsWith('/journal.json')) {
    journalPublishes++
    if (phase === 'before-started' && journalPublishes === 2) process.kill(process.pid, 'SIGKILL')
    if (phase === 'after-execute' && journalPublishes === 3) process.kill(process.pid, 'SIGKILL')
  }
  if (phase === 'before-final' && target.endsWith('/run.json')) {
    const value = JSON.parse(await fs.readFile(from, 'utf8'))
    if (value.status === 'completed') process.kill(process.pid, 'SIGKILL')
  }
  await originalRename(from, to)
}
