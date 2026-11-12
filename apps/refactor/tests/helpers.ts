// Builds scripted repositories and clients for tests; it must not reproduce production phase logic.
import { afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import type { JsonObject } from '@anureo/protocol'
import type { RepositoryGraph } from '../src/graph'
import { exec } from '../src/process'

const clients: Client[] = []
const directories: string[] = []
/** Release test-owned clients before deleting repositories; afterEach awaits both cleanup stages.
 * Disposal or removal failures reject the hook, while finally still attempts directory cleanup. */
afterEach(async () => {
  try { await Promise.all(clients.splice(0).map(client => client.dispose())) }
  finally { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) }
})

/** Create a test-owned temporary directory, registering removal after the test; filesystem errors reject. */
export async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'anureo-refactor-test-'))
  directories.push(path)
  return path
}

/** Default exact-cover response for fixture planning; consumers derive variants rather than mutate shared state. */
export const plan = { summary: 'Two cohesive modules', modules: [
  { id: 'a', name: 'A', description: 'A responsibility', files: ['a.ts'] },
  { id: 'b', name: 'B', description: 'B responsibility', files: ['b.ts'] },
] }
/** Default work response for fixture agents; consumers reuse it without mutating shared state. */
export const unchanged = { summary: 'Read the code; direct expression is appropriate.', changes: [], deferred: [] }
/** Return an edit-claim response for a test-supplied description; performs no I/O and does not throw.
 * Tests must make the real edit separately so host observations remain independent of agent claims. */
export const edited = (change = 'Renamed internal value') => ({ summary: 'Edited', changes: [change], deferred: [] })
/** Return the first heading (empty for empty input) for test routing; pure, with no expected errors. */
export const kind = (prompt: string) => prompt.split('\n')[0]!
/** Read a module ID from its serialized prompt header for test routing, or undefined if absent.
 * Pure matching does not parse the rest of the prompt and has no expected errors. */
export const moduleOf = (prompt: string) => /Module: \{"id":"([^"]+)"/.exec(prompt)?.[1]
/** Return a schema-compatible two-node graph for a test cwd without validation, I/O or expected errors. */
export function graph(cwd: string): RepositoryGraph {
  return { schemaVersion: 1, repositoryPath: cwd, kind: 'all', indexReport: { status: 'indexed' }, nodes: [
    { id: 'a', labels: ['Function'], name: 'calculate', filePath: 'a.ts', startLine: 1, endLine: 1 },
    { id: 'b', labels: ['Function'], name: 'persist', filePath: 'b.ts', startLine: 1, endLine: 1 },
  ], edges: [{ id: 'call', source: 'a', target: 'b', type: 'CALLS' }] }
}

/** Build the fixture adapter with a caller-supplied responder and prompt log; no resources start yet.
 * Submissions later emit start before awaiting respond, then emit either failure or final JSON
 * before completion. Responder/serialization/event errors reject execution; other calls fall through. */
function respondingAdapter(respond: (prompt: string) => unknown | Promise<unknown>, prompts: string[]) {
  return createScriptedAdapter({
    /** Handle submissions in SDK event order, awaiting the test responder before completing each turn. */
    execute: async (call, sink) => {
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
    },
  })
}

/** Create a staged two-file Git repository and scripted SDK client for orchestration/CLI tests.
 * Returns the cwd, client, adapter, prompt log and an in-memory graph loader; setup failures reject.
 * Shared afterEach owns client disposal and directory removal so tests share one cleanup path. */
export async function fixture(respond: (prompt: string) => unknown | Promise<unknown> = prompt => prompt.startsWith('PLAN') ? plan : unchanged) {
  const cwd = await temporary()
  await Promise.all(['a.ts', 'b.ts'].map(file => writeFile(join(cwd, file), 'export const value = 1\n')))
  await writeFile(join(cwd, '.gitignore'), '.anureo/\n')
  await exec('git', ['init', '-q', cwd])
  await exec('git', ['-C', cwd, 'add', '.'])
  const prompts: string[] = []
  const adapter = respondingAdapter(respond, prompts)
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { cwd, client, adapter, prompts, graphLoader: async () => graph(cwd) }
}
