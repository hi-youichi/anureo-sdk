/**
 * Records the real normalized event sequence of one Pi run, for pinning against the fake host.
 *
 *   PI_SMOKE_MODEL=provider/id bun scripts/spike.ts [prompt]
 *
 * Needs Pi credentials (Pi's agentDir/auth.json or provider env vars). Writes
 * `protocol/<pi version>/run.json` with raw host events and provenance. Recorded message and tool
 * content is not redacted; use inputs and a working directory suitable for a checked-in fixture.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VERSION } from '@earendil-works/pi-coding-agent'
import { createPiHost, type PiHostEvent } from '../src/host'
import { assistantTextPhase, toolOutputText, usageOf } from '../src/mapping'

const SETTLEMENT_TIMEOUT_MS = 120_000

const model = process.env.PI_SMOKE_MODEL
if (!model) {
  console.error('Set PI_SMOKE_MODEL=provider/id (and Pi credentials) to record a run.')
  process.exit(2)
}
const prompt = process.argv[2] ?? 'Run `echo hello` with the bash tool, then say done.'
const cwd = await mkdtemp(join(tmpdir(), 'anureo-pi-spike-'))
try {
  const events = await recordRun({ cwd, model, prompt })
  await writeRecording(model, events)
} finally {
  await rm(cwd, { recursive: true, force: true })
}

/**
 * Acquire an in-memory host and subscribe before submitting a prompt that starts a run.
 * Await settlement so retries and terminal events are included. Dispose the host after
 * settlement before returning the raw events to the fixture writer.
 */
async function recordRun({ cwd, model, prompt }: { cwd: string; model: string; prompt: string }): Promise<PiHostEvent[]> {
  const host = await createPiHost({ cwd, mode: 'new', persist: false, model })
  const events: PiHostEvent[] = []
  const terminal = Promise.withResolvers<Extract<PiHostEvent, { type: 'settled' | 'error' | 'failed' }> | 'timeout'>()
  const unsubscribe = host.subscribe(event => {
    events.push(event)
    if (event.type === 'settled' || event.type === 'error' || event.type === 'failed') terminal.resolve(event)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const disposition = await host.prompt(prompt)
    if (disposition !== 'started') throw new Error(`Pi fixture prompt was ${disposition} and did not start a run`)
    timer = setTimeout(() => terminal.resolve('timeout'), SETTLEMENT_TIMEOUT_MS)
    const outcome = await terminal.promise
    if (outcome === 'timeout') throw new Error('Timed out waiting for Pi fixture settlement')
    if (outcome.type !== 'settled') throw new Error('Pi fixture run failed before settlement')
    if (outcome.aborted) throw new Error('Pi fixture run was aborted')
    const recorded = events.slice(0, events.indexOf(outcome) + 1)
    const assistants = recorded.flatMap(event => event.type === 'message_end' && event.message.role === 'assistant' ? [event.message] : [])
    const reply = assistants.at(-1)
    const finalText = assistants.flatMap(message => Array.isArray(message.content) && assistantTextPhase(message.content, message.stopReason) === 'final'
      ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : [])
    if (!reply || !Array.isArray(reply.content) || assistantTextPhase(reply.content, reply.stopReason) !== 'final' ||
        finalText.length !== 1 || !finalText[0]?.trim() || (usageOf(assistants).input ?? 0) <= 0) {
      throw new Error('Pi fixture run did not produce a successful final assistant reply')
    }
    const calls = recorded.filter(event => event.type === 'tool_start')
    const call = calls[0]
    if (calls.length !== 1 || call?.name !== 'bash' || !recorded.some(event =>
      event.type === 'tool_end' && event.id === call.id && !event.isError && toolOutputText(event.result).includes('hello'))) {
      throw new Error('Pi fixture run did not produce the expected bash result containing hello')
    }
    return recorded
  } finally {
    clearTimeout(timer)
    unsubscribe()
    await host.dispose()
  }
}

/** Overwrite the versioned replay fixture with raw events and the provenance of this run. */
async function writeRecording(model: string, events: PiHostEvent[]): Promise<void> {
  const out = join(import.meta.dir, '..', 'protocol', VERSION, 'run.json')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify({ provenance: { piVersion: VERSION, model, recordedAt: new Date().toISOString() }, events }, null, 2)}\n`)
  console.log(`recorded ${events.length} events -> ${out}`)
}
