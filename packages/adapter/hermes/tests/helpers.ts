import { resolve } from 'node:path'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import { createHermesAdapter, type HermesAdapterOptions } from '../src'

/** Shared gateway executable used by Hermes wire/resource tests and the Node launcher fixture. */
export const fixture = resolve(import.meta.dir, 'fixtures/fake-hermes.mjs')
/**
 * Start a real child gateway and wait for its stdout URL. Hermes, code-review and refactor tests
 * own both their clients and the fixture and must dispose them separately. env configures the
 * server, while adapter options configure CLI children. Startup/read/JSON failures reject before
 * returning a disposal handle. Fixture stderr is drained without entering test output.
 */
export async function startFake(scenario = 'lifecycle', env: Record<string, string> = {}) {
  const child = await spawnHarnessProcess({ command: process.execPath, args: [fixture, '--server'], env: { ...process.env, ...env, FAKE_HERMES_SCENARIO: scenario } })
  void (async () => { for await (const _chunk of child.stderr) { /* no native stderr in public test output */ } })()
  const url = await readFixtureUrl(child.stdout)
  return {
    /** Construct an independently owned adapter using this server's URL and the selected scenario. */
    adapter(options: HermesAdapterOptions = {}) {
      return createHermesAdapter({ command: process.execPath, args: [fixture], timeoutMs: 1500, reconnectDelayMs: 1,
        ...options, env: { ...process.env, FAKE_HERMES_SCENARIO: scenario, FAKE_HERMES_URL: url, ...options.env } })
    },
    /** Await the fixture control response; native progress publication can still be queued in the adapter. */
    async control(action: string) { await fetch(url + '/control', { method: 'POST', body: JSON.stringify({ action }) }) },
    /** Read the server's counters and captured wire traffic without waiting for adapter event projection. */
    async state(): Promise<FixtureState> {
      return await (await fetch(url + '/state')).json() as FixtureState
    },
    /** Release the server child; adapters created by this fixture remain the test's responsibility. */
    async dispose() { await child.dispose() },
  }
}

/** Poll fixture I/O at 5 ms intervals for at most 200 attempts; reject with the caller diagnostic
 * when unobserved. Predicate errors propagate immediately without retry. */
export async function until(predicate: () => Promise<boolean>, message = 'Native fixture condition was not observed'): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error(message)
}

/** Gateway counters and captured wire traffic exposed to fixture consumers through state(). */
interface FixtureState {
  createParams: Array<Record<string, unknown>>
  creates: number
  attaches: number
  interrupts: number
  disconnects: number
  connections: number
  methods: string[]
  inputs: Array<{ inputId: string; text: string }>
  responses: Array<Record<string, unknown>>
  attachArgs: string[][]
  active: number
  viewers: number
}

/** Read the startup record without waiting for server exit or closing its stdout iterator. */
async function readFixtureUrl(stdout: HarnessProcess['stdout']): Promise<string> {
  const iterator = stdout[Symbol.asyncIterator]()
  let output = ''
  for (;;) {
    const chunk = await iterator.next()
    if (chunk.done) throw new Error('Hermes fixture did not start')
    output += new TextDecoder().decode(chunk.value)
    if (output.includes('\n')) return (JSON.parse(output.trim()) as { url: string }).url
  }
}
