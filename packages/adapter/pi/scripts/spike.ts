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
  const settled = new Promise<void>(resolve => {
    host.subscribe(event => {
      events.push(event)
      if (event.type === 'settled') resolve()
    })
  })
  console.log('prompt disposition:', await host.prompt(prompt))
  await settled
  await host.dispose()
  return events
}

/** Overwrite the versioned replay fixture with raw events and the provenance of this run. */
async function writeRecording(model: string, events: PiHostEvent[]): Promise<void> {
  const out = join(import.meta.dir, '..', 'protocol', VERSION, 'run.json')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify({ provenance: { piVersion: VERSION, model, recordedAt: new Date().toISOString() }, events }, null, 2)}\n`)
  console.log(`recorded ${events.length} events -> ${out}`)
}
