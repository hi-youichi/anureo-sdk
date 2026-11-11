/**
 * Records the real normalized event sequence of one Pi run, for pinning against the fake host.
 *
 *   PI_SMOKE_MODEL=provider/id bun scripts/spike.ts [prompt]
 *
 * Needs Pi credentials (Pi's agentDir/auth.json or provider env vars). Writes
 * `protocol/<pi version>/run.json` with the host events and a provenance record; never stores prompts' secrets.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { VERSION } from '@earendil-works/pi-coding-agent'
import { createPiHost, type PiHostEvent } from '../src/host'

const model = process.env.PI_SMOKE_MODEL
if (!model) { console.error('Set PI_SMOKE_MODEL=provider/id (and Pi credentials) to record a run.'); process.exit(2) }
const prompt = process.argv[2] ?? 'Run `echo hello` with the bash tool, then say done.'
const cwd = await mkdtemp(join(tmpdir(), 'anureo-pi-spike-'))
const events: PiHostEvent[] = []
try {
  const host = await createPiHost({ cwd, mode: 'new', persist: false, model })
  const settled = new Promise<void>(resolve => host.subscribe(event => { events.push(event); if (event.type === 'settled') resolve() }))
  console.log('prompt disposition:', await host.prompt(prompt))
  await settled
  await host.dispose()
  const out = join(import.meta.dir, '..', 'protocol', VERSION, 'run.json')
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify({ provenance: { piVersion: VERSION, model, recordedAt: new Date().toISOString() }, events }, null, 2)}\n`)
  console.log(`recorded ${events.length} events -> ${out}`)
} finally { await rm(cwd, { recursive: true, force: true }) }
