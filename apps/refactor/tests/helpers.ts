import { afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import type { JsonObject } from '@anureo/protocol'
import type { RepositoryGraph } from '../src/graph'
import { exec } from '../src/source'

const clients: Client[] = []
const directories: string[] = []
afterEach(async () => {
  try { await Promise.all(clients.splice(0).map(client => client.dispose())) }
  finally { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) }
})

export async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'anureo-refactor-test-'))
  directories.push(path)
  return path
}

export const plan = { summary: 'Two cohesive modules', modules: [
  { id: 'a', name: 'A', description: 'A responsibility', files: ['a.ts'] },
  { id: 'b', name: 'B', description: 'B responsibility', files: ['b.ts'] },
] }
/** What every agent step returns when it changes nothing. */
export const unchanged = { summary: 'Read the code; direct expression is appropriate.', changes: [], deferred: [] }
export const edited = (change = 'Renamed internal value') => ({ summary: 'Edited', changes: [change], deferred: [] })
/** Prompt kind and, for module steps, the module id. */
export const kind = (prompt: string) => prompt.split('\n')[0]!
export const moduleOf = (prompt: string) => /Module: \{"id":"([^"]+)"/.exec(prompt)?.[1]
export function graph(cwd: string): RepositoryGraph {
  return { schemaVersion: 1, repositoryPath: cwd, kind: 'all', indexReport: { status: 'indexed' }, nodes: [
    { id: 'a', labels: ['Function'], name: 'calculate', filePath: 'a.ts', startLine: 1, endLine: 1 },
    { id: 'b', labels: ['Function'], name: 'persist', filePath: 'b.ts', startLine: 1, endLine: 1 },
  ], edges: [{ id: 'call', source: 'a', target: 'b', type: 'CALLS' }] }
}

export async function fixture(respond: (prompt: string) => unknown | Promise<unknown> = prompt => prompt.startsWith('PLAN') ? plan : unchanged) {
  const cwd = await temporary()
  await Promise.all(['a.ts', 'b.ts'].map(file => writeFile(join(cwd, file), 'export const value = 1\n')))
  await writeFile(join(cwd, '.gitignore'), '.anureo/\n')
  await exec('git', ['init', '-q', cwd])
  await exec('git', ['-C', cwd, 'add', '.'])
  const prompts: string[] = []
  const adapter = createScriptedAdapter({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('input' in call.params) || !('submissionId' in call.params)) return undefined
    const { input, submissionId } = call.params
    const prompt = input.filter(part => part.type === 'text').map(part => part.text).join('\n')
    prompts.push(prompt)
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    const result = await respond(prompt)
    if (result instanceof HarnessSdkError) {
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: {
        code: result.code, message: result.message, retryable: result.retryable, outcomeUnknown: result.outcomeUnknown,
        ...(result.details ? { details: result.details as JsonObject } : {}),
      } } })
    } else {
      await sink.emit({ type: 'item/completed', payload: { item: {
        id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(result),
      } } }, { turnId })
      await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
    }
    return { submissionId, accepted: true, disposition: 'started', turnId }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { cwd, client, adapter, prompts, graphLoader: async () => graph(cwd) }
}
