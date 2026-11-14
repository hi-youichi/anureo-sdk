import { afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Client } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'
import type { JsonObject } from '@anureo/protocol'
import type { ModulePlan } from '../src/schema'

/** Routing convention for scripted responses: `respond` receives the full prompt
 * text; route on the stage prefixes below (stages.analyze / stages.fix /
 * stages.verify) and on the module's compact JSON marker via isModule(id).
 * Prompt-building changes in src must update these keys. */
export const stages = { analyze: 'Analyze', fix: 'Fix these review findings', verify: 'Verify' } as const
/** Recognize analysis submissions when routing fixture responses. */
export const isAnalysis = (prompt: string) => prompt.startsWith(stages.analyze)
/** Build a predicate for the compact module JSON embedded in review/verification prompts. */
export const isModule = (id: string) => (prompt: string) => prompt.includes(`"id":"${id}"`)

/** Captured-IO recorder matching the CliDependencies stdout/stderr seam. */
export function output() {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout: (text: string) => { stdout.push(text) }, stderr: (text: string) => { stderr.push(text) },
    read: () => ({ stdout: stdout.join(''), stderr: stderr.join('') }) }
}

/** Default analysis response assigning the fixture's two source files to independent modules. */
export const plan: ModulePlan = {
  summary: 'Two independent modules.',
  modules: [
    { id: 'a', name: 'A', description: 'First module', files: ['a.ts'] },
    { id: 'b', name: 'B', description: 'Second module', files: ['b.ts'] },
  ],
}

/** Valid finding against the first line of fixture source a.ts, reusable in review and fix tests. */
export const finding = {
  severity: 'P2' as const, title: 'Incorrect fallback', body: 'A zero input returns the fallback instead of zero.',
  suggestion: 'Treat zero as a valid value: `return n === 0 ? n : (n || 1)`',
  file: 'a.ts', lineStart: 1, lineEnd: 1,
}

/** Create two temporary source files and an initialized scripted client for review, fix and CLI tests.
 * The adapter invokes respond with captured full prompts when turns are submitted after setup, so
 * the callback may reference this fixture's returned context. Defaults to plan plus empty reviews;
 * returning HarnessSdkError emits a failed turn, while other values become JSON agent messages.
 * Setup failures reject. This module's afterEach disposes clients and removes directories; tests must
 * settle their runs first. Hooks customize adapter capabilities/session opening, not turn execution. */
export async function fixture(
  respond: (prompt: string) => unknown | Promise<unknown> = prompt => isAnalysis(prompt) ? plan : { findings: [] },
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
        ...(output.details === undefined ? {} : { details: output.details as JsonObject }),
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

const clients: Client[] = []
const directories: string[] = []

afterEach(async () => {
  // Dispose failures must neither skip directory cleanup nor mask the test's result.
  const disposed = await Promise.allSettled(clients.splice(0).map(client => client.dispose()))
  await Promise.allSettled(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  const failed = disposed.filter(result => result.status === 'rejected')
  if (failed.length > 0) console.error('cleanup dispose failures:', failed.map(result => String(result.reason)))
})
