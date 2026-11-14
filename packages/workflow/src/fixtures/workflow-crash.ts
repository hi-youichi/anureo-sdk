import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createClient } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'

const [directory, phase] = process.argv.slice(2) as [string, string]
const originalRename = fs.rename
let journalPublishes = 0
// workflow.test.ts spawns a fresh process per crash point. Install the mock before
// importing workflow so atomic publication uses the injected rename in this process.
mock.module('node:fs/promises', () => ({ ...fs, rename: renameAtCrashBoundary }))
const { workflow, agent } = await import('../index')

const adapter = createScriptedAdapter({
  async execute(call) {
    if (phase === 'after-later-result' && call.method === 'input/submit' && 'input' in call.params
      && call.params.input.some(part => part.type === 'text' && part.text === 'work')) {
      // Hold the first call at started while the second reaches durable completion.
      await new Promise<never>(() => {})
    }
    return undefined
  },
})
const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'crash-fixture' } })
try {
  await workflow({ directory, name: 'crash-test', revision: '1', input: {}, runId: 'crashed' }, async () => {
    const first = agent('work', { client, cwd: directory })
    if (phase !== 'after-later-result') return first
    await agent('later', { client, cwd: directory })
    process.kill(process.pid, 'SIGKILL')
    return first
  })
} finally {
  await client.dispose()
}

/** Replace fs.rename for atomicPublish. Kill the process before the selected rename can
 * publish the started marker, agent result or completed manifest. Unselected renames
 * use the original operation and propagate its failures. */
async function renameAtCrashBoundary(from: string, to: string): Promise<void> {
  const target = to.replaceAll('\\', '/')
  if (target.endsWith('/journal.json')) {
    // The first publication creates the empty journal before any agent work can start.
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
