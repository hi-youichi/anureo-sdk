import { mock } from 'bun:test'
import { appendFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient, HarnessSdkError } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import * as shared from '../../src/cli-shared'
import { defaultOutput, type Request } from './review-responses'

// Exercise the real CLI and persistence with a deterministic backend, without model calls.
mock.module('../../src/cli-shared', () => ({ ...shared,
  withClient: async <T>(cwd: string, maxOutputBytes: number, editing: boolean,
    execute: Parameters<typeof shared.withClient<T>>[3]): Promise<T> => {
    if (editing && process.env.FIX_UNKNOWN !== '1') throw new Error('Review fixture must remain read-only')
    let analyses = 0
    const client = await createClient({
      adapter: createScriptedAdapter({ execute: async (call, sink) => {
        if (call.method !== 'input/submit' || !('input' in call.params)) return undefined
        const input = JSON.parse(call.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n')) as Request
        if (editing) {
          const target = (input as Request & { finding: { path: string } }).finding.path
          await writeFile(join(cwd, target), 'partial write before losing observation\n')
          throw new HarnessSdkError('SOURCE_LOST', 'Unknown writer state', false, true)
        }
        await appendFile(process.env.REVIEW_CALLS!, `${JSON.stringify({ task: input.task, taskId: input.assignment?.id })}\n`)
        if (process.env.REVIEW_CRASH === '1' && input.task === 'design-analysis' && ++analyses === 4) {
          // Model-call concurrency is distinct from checkpoint publication; wait for the
          // three earlier workers to commit before choosing this crash boundary.
          const deadline = Date.now() + 5000
          while ((await readdir(join(process.env.REVIEW_OUTPUT!, 'checkpoints')))
            .filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length < 4) {
            if (Date.now() > deadline) throw new Error('Earlier task checkpoints were not published')
            await new Promise(resolve => setTimeout(resolve, 2))
          }
          process.kill(process.pid, 'SIGKILL')
        }
        const turnId = randomUUID()
        await sink.emit({ type: 'turn/started', payload: { turnId } })
        await sink.emit({ type: 'item/completed', payload: { item: { id: randomUUID(), type: 'agentMessage',
          phase: 'final', text: JSON.stringify(defaultOutput(input)) } } }, { turnId })
        await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
        return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
      } }),
      identity: { adapterId: 'scripted', runtimeConfigId: 'cli-recovery' },
      limits: { maxResultBytes: maxOutputBytes },
    })
    try { return await execute(client, () => false) } finally { await client.dispose() }
  },
}))

const { main } = await import('../../src/cli')
await main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1 })
