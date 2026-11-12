import { afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'
import type { ModulePlan } from '../src/schema'

const clients: Client[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

export const plan: ModulePlan = {
  summary: 'Two independent modules.',
  modules: [
    { id: 'a', name: 'A', description: 'First module', files: ['a.ts'] },
    { id: 'b', name: 'B', description: 'Second module', files: ['b.ts'] },
  ],
}

export const finding = {
  severity: 'P2' as const, title: 'Incorrect fallback', body: 'A zero input returns the fallback instead of zero.',
  file: 'a.ts', lineStart: 1, lineEnd: 1,
}

export async function fixture(
  respond: (prompt: string) => unknown | Promise<unknown> = prompt => prompt.startsWith('Analyze') ? plan : { findings: [] },
  hooks: Omit<FakeAdapterOptions, 'execute'> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-review-'))
  directories.push(cwd)
  await Promise.all(['a.ts', 'b.ts'].map(file => writeFile(join(cwd, file), 'export const fallback = (n: number) => n || 1\n')))
  const prompts: string[] = []
  const adapter = createScriptedAdapter({ ...hooks, execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params) || !('input' in call.params)) return undefined
    const { submissionId, input } = call.params
    const prompt = input.filter(part => part.type === 'text').map(part => part.text).join('\n')
    prompts.push(prompt)
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    const output = await respond(prompt)
    if (output instanceof HarnessSdkError) {
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: {
        code: output.code, message: output.message, retryable: output.retryable, outcomeUnknown: output.outcomeUnknown,
      } } })
    } else {
      await sink.emit({ type: 'item/completed', payload: { item: {
        id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(output),
      } } }, { turnId })
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
    }
    return { submissionId, accepted: true, disposition: 'started', turnId }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, cwd, adapter, prompts }
}
