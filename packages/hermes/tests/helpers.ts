import { resolve } from 'node:path'
import { spawnHarnessProcess } from '@anureo/sdk/process'
import { createHermesAdapter, type HermesAdapterOptions } from '../src'

export const fixture = resolve(import.meta.dir, 'fixtures/fake-hermes.mjs')
export async function startFake(scenario = 'lifecycle') {
  const child = await spawnHarnessProcess({ command: process.execPath, args: [fixture, '--server'], env: { ...process.env, FAKE_HERMES_SCENARIO: scenario } })
  void (async () => { for await (const _chunk of child.stderr) { /* no native stderr in public test output */ } })()
  const iterator = child.stdout[Symbol.asyncIterator](); let output = ''
  for (;;) {
    const chunk = await iterator.next()
    if (chunk.done) throw new Error('Hermes fixture did not start')
    output += new TextDecoder().decode(chunk.value)
    if (output.includes('\n')) break
  }
  const url = (JSON.parse(output.trim()) as { url: string }).url
  return {
    adapter(options: HermesAdapterOptions = {}) {
      return createHermesAdapter({ command: process.execPath, args: [fixture], timeoutMs: 1500, reconnectDelayMs: 1,
        ...options, env: { ...process.env, FAKE_HERMES_SCENARIO: scenario, FAKE_HERMES_URL: url, ...options.env } })
    },
    async control(action: string) { await fetch(url + '/control', { method: 'POST', body: JSON.stringify({ action }) }) },
    async state(): Promise<{ createParams: Array<Record<string, unknown>>; creates: number; attaches: number; interrupts: number; disconnects: number; connections: number; methods: string[]; inputs: Array<{ inputId: string; text: string }>; responses: Array<Record<string, unknown>>; attachArgs: string[][]; active: number; viewers: number }> {
      return await (await fetch(url + '/state')).json() as Awaited<ReturnType<typeof this.state>>
    },
    async dispose() { await child.dispose() },
  }
}
