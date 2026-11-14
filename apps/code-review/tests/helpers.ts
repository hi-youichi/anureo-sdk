import { afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type Client, type SessionEventSink } from '@anureo/sdk'
import { createScriptedAdapter, type FakeAdapterOptions } from '@anureo/conformance'
import type { JsonObject } from '@anureo/protocol'
import type { ModulePlan } from '../src/schema'

/** Prefixes for routing fixture responses by stage in analysis and fix tests. */
export const stages = { analyze: 'Analyze', fix: 'Fix these review findings', verify: 'Verify' } as const
/** Recognize analysis submissions when routing fixture responses. */
export const isAnalysis = (prompt: string) => prompt.startsWith(stages.analyze)
/** Build a predicate for the compact module JSON embedded in review/verification prompts. */
export const isModule = (id: string) => (prompt: string) => prompt.includes(`"id":"${id}"`)

/** Capture CLI output in separate streams. Pass the callbacks to runCli and read the joined text
 * after it settles. Reading leaves the recorded writes available for later assertions. */
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

/** Create a temporary two-file source tree and an initialized scripted client for review, fix and
 * CLI tests. The submission hook awaits respond with the captured prompt and session directory.
 * By default it returns the fixture plan for analysis and empty findings for other submissions.
 * A returned HarnessSdkError emits a failed turn. Other values are serialized as final JSON text.
 * A thrown or rejected response fails submission. The optional hooks configure capabilities and
 * session opening. Setup failures reject. Settle all runs before the test cleanup hook disposes
 * fixture clients and removes their source directories. */
export async function fixture(
  respond: (prompt: string, sessionCwd: string) => unknown | Promise<unknown> = prompt => isAnalysis(prompt) ? plan : { findings: [] },
  hooks: Omit<FakeAdapterOptions, 'execute'> = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'anureo-review-'))
  directories.push(cwd)
  await Promise.all(['a.ts', 'b.ts'].map(file => writeFile(join(cwd, file), 'export const fallback = (n: number) => n || 1\n')))
  const prompts: string[] = []
  const adapter = createScriptedAdapter({ ...hooks, execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params) || !('input' in call.params)) return undefined
    const { submissionId, input, sessionId } = call.params
    const prompt = input.filter(part => part.type === 'text').map(part => part.text).join('\n')
    prompts.push(prompt)
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    const session = adapter.opened.find(open => open.binding.sessionId === sessionId)
    if (!session) throw new Error('Fixture submission has no session')
    const response = await respond(prompt, session.cwd)
    await publishFixtureResult(sink, turnId, response)
    return { submissionId, accepted: true, disposition: 'started', turnId }
  } })
  const client = await createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: randomUUID() } })
  clients.push(client)
  return { client, cwd, adapter, prompts }
}

/** Publish the scripted turn outcome before the submission hook returns its acceptance receipt.
 * Preserve SDK error metadata for workflow failure tests. Serialization and sink failures reject
 * the submission hook. */
async function publishFixtureResult(sink: SessionEventSink, turnId: string, response: unknown): Promise<void> {
  if (response instanceof HarnessSdkError) {
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'failed', error: {
      code: response.code, message: response.message, retryable: response.retryable, outcomeUnknown: response.outcomeUnknown,
      ...(response.details === undefined ? {} : { details: response.details as JsonObject }),
    } } })
    return
  }
  await sink.emit({ type: 'item/completed', payload: { item: {
    id: randomUUID(), type: 'agentMessage', phase: 'final', text: JSON.stringify(response),
  } } }, { turnId })
  await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
}

const clients: Client[] = []
const directories: string[] = []

afterEach(cleanupFixtures)

/** Release tracked clients before removing source directories, even when a client's disposal
 * rejects. Bun invokes this after each test. Disposal rejections are logged after both settle. */
async function cleanupFixtures(): Promise<void> {
  const disposed = await Promise.allSettled(clients.splice(0).map(client => client.dispose()))
  await Promise.allSettled(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  const failed = disposed.filter(result => result.status === 'rejected')
  if (failed.length > 0) console.error('cleanup dispose failures:', failed.map(result => String(result.reason)))
}
