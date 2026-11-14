// Builds scripted repositories and clients with shared cleanup for refactor tests.
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
/** Return an agent's edit claim. Tests make the real edit separately so host observations
 * remain independent of the claim. */
export const edited = (change = 'Renamed internal value') => ({ summary: 'Edited', changes: [change], deferred: [] })
/** Return the first line for prompt routing, or an empty string for empty input. */
export const kind = (prompt: string) => prompt.split('\n')[0]!
/** Read a module ID from its serialized prompt header, or return undefined when absent. */
export const moduleOf = (prompt: string) => /Module: \{"id":"([^"]+)"/.exec(prompt)?.[1]
/** Build a two-file graph rooted at the test target for injected graph loaders. */
export function graph(cwd: string): RepositoryGraph {
  return { schemaVersion: 1, repositoryPath: cwd, kind: 'all', indexReport: { status: 'indexed' }, nodes: [
    { id: 'a', labels: ['Function'], name: 'calculate', filePath: 'a.ts', startLine: 1, endLine: 1 },
    { id: 'b', labels: ['Function'], name: 'persist', filePath: 'b.ts', startLine: 1, endLine: 1 },
  ], edges: [{ id: 'call', source: 'a', target: 'b', type: 'CALLS' }] }
}

/** Create a staged two-file Git repository and scripted SDK client for refactor, CLI and lifecycle tests.
 * Defaults to the shared plan for planning prompts and unchanged work otherwise. A supplied responder
 * is awaited on each submission; return HarnessSdkError to fail the turn or a JSON-serializable value
 * as agent output. Tests make edits themselves so host snapshots can verify them independently.
 * Returns the cwd, client, adapter, prompt log and an in-memory graph loader. Setup failures reject.
 * Shared afterEach handles registered resources, including directories from failed setup. */
export async function fixture(respond: Responder = prompt => prompt.startsWith('PLAN') ? plan : unchanged) {
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

/** Script one submission's output against the session's own working directory. */
type Responder = (prompt: string, cwd: string) => unknown | Promise<unknown>

const clients: Client[] = []
const directories: string[] = []
/** Attempt client disposal before removing test repositories. Disposal or removal failures reject
 * the hook; finally starts directory cleanup even when Promise.all rejects during disposal. */
afterEach(async () => {
  try { await Promise.all(clients.splice(0).map(client => client.dispose())) }
  finally { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) }
})

/** Build the adapter that fixture passes to createClient. During submission, the scripted
 * backend invokes execute to log the prompt and emit start before awaiting the responder.
 * A returned HarnessSdkError becomes a failed terminal event. Other values are serialized to
 * final JSON before completion. Responder, serialization and event errors reject the submission.
 * Other session calls use the adapter defaults. */
function respondingAdapter(respond: Responder, prompts: string[]) {
  const sessionDirectories = new Map<string, string>()
  return createScriptedAdapter({
    /** The adapter awaits this at session open, before a submission can use the recorded cwd. */
    onOpen: async params => { sessionDirectories.set(params.binding.sessionId, params.cwd) },
    execute: async (call, sink) => {
      if (call.method !== 'input/submit' || !('input' in call.params) || !('submissionId' in call.params)) return undefined
      const { input, submissionId, sessionId } = call.params
      const prompt = input.filter(part => part.type === 'text').map(part => part.text).join('\n')
      prompts.push(prompt)
      const turnId = randomUUID()
      await sink.emit({ type: 'turn/started', payload: { turnId } })
      const result = await respond(prompt, sessionDirectories.get(sessionId)!)
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
