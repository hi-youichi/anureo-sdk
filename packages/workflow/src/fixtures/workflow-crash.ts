import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createClient, HarnessSdkError } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import type { JournalEvent } from '../persistence/records'

const [directory, phase] = process.argv.slice(2) as [string, string]
const originalRename = fs.rename
// workflow.test.ts spawns a fresh process per crash point. Install the mock before
// importing workflow so atomic publication uses the injected rename in this process.
mock.module('node:fs/promises', () => ({ ...fs, rename: renameAtCrashBoundary }))
const { workflow, agent } = await import('../index')

const adapter = createScriptedAdapter({
  async execute(call) {
    if (phase === 'unpublished-unknown' && call.method === 'input/submit' && 'submissionId' in call.params) {
      throw new HarnessSdkError('NATIVE_FAILED', 'unknown', false, true)
    }
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
  await workflow({ directory, name: 'crash-test', revision: '1', input: {}, runId: 'crashed',
    resumeFrom: phase === 'after-retry' ? 'source' : undefined }, async () => {
    if (phase === 'after-retry') {
      await agent('prefix', { client, cwd: directory })
      await agent('work', { client, cwd: directory })
      process.kill(process.pid, 'SIGKILL')
    }
    const first = agent('work', { client, cwd: directory })
    if (phase !== 'after-later-result') return first
    await agent('later', { client, cwd: directory })
    process.kill(process.pid, 'SIGKILL')
    return first
  })
} catch (error) {
  const codes = error instanceof HarnessSdkError ? error.details?.failureCodes : undefined
  if (phase !== 'unpublished-unknown' || !(error instanceof HarnessSdkError)
    || !error.outcomeUnknown || !Array.isArray(codes) || !codes.includes('WORKFLOW_STORAGE_FAILED')) throw error
} finally {
  await client.dispose()
}

/** Replace fs.rename for atomicPublish. Kill the process before the selected rename can
 * publish the started marker, agent result or completed manifest. Unselected renames
 * use the original operation and propagate its failures. */
async function renameAtCrashBoundary(from: string, to: string): Promise<void> {
  const target = to.replaceAll('\\', '/')
  if (target.endsWith('/journal.json')) {
    const pending = JSON.parse(await fs.readFile(from, 'utf8')) as JournalEvent[]
    const event = pending.at(-1)
    if ((phase === 'before-started' && event?.type === 'started')
      || (phase === 'after-execute' && event?.type === 'result')) process.kill(process.pid, 'SIGKILL')
    if (phase === 'unpublished-unknown' && event?.type === 'failed' && event.outcomeUnknown) {
      throw new Error('Injected journal replacement failure')
    }
  }
  if (phase === 'before-final' && target.endsWith('/run.json')) {
    const value = JSON.parse(await fs.readFile(from, 'utf8'))
    if (value.status === 'completed') process.kill(process.pid, 'SIGKILL')
  }
  await originalRename(from, to)
}
