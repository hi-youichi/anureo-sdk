import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnHarnessProcess, type HarnessProcess } from '@anureo/sdk/process'
import type { CatalogProbeEvent } from '@anureo/sdk/diagnostics'
import { createCodexCatalogSession } from '../src/catalog'

test('directory refresh reuses one process/handshake and never opens a thread or turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'codex catalog ')), log = path.join(root, 'calls.jsonl')
  const children: HarnessProcess[] = [], phases: CatalogProbeEvent[] = []
  const session = createCodexCatalogSession({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
    env: { ...process.env, FAKE_LOG_FILE: log }, processFactory: async options => { const child = await spawnHarnessProcess(options); children.push(child); return child } })
  try {
    await Promise.all([session.prepare({ onPhase: event => phases.push(event) }), session.prepare()])
    expect((await session.listModels()).some(model => model.id === 'test-model')).toBe(true)
    await session.listModels()
    expect(children).toHaveLength(1)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string })
    expect(calls.filter(call => call.method === 'initialize')).toHaveLength(1)
    expect(calls.filter(call => call.method === 'model/list')).toHaveLength(2)
    expect(calls.some(call => /^(thread|turn)\//.test(call.method))).toBe(false)
    expect(phases.map(event => [event.phase, event.outcome])).toEqual([['spawn', 'started'], ['spawn', 'success'], ['handshake', 'started'], ['handshake', 'success']])
  } finally { await session.dispose(); await session.dispose(); rmSync(root, { recursive: true, force: true }) }
  expect((await children[0]!.exited).code).not.toBeUndefined()
})

test('cancellation at spawn completion disposes the just-created process', async () => {
  const abort = new AbortController(); let child: HarnessProcess | undefined
  const session = createCodexCatalogSession({ command: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))],
    processFactory: async options => { child = await spawnHarnessProcess(options); abort.abort(); return child } })
  try {
    await expect(session.prepare({ signal: abort.signal })).rejects.toMatchObject({ code: 'RPC_ABORTED' })
    expect(child).toBeDefined()
    await child!.exited
  } finally { await session.dispose() }
}, 3_000)
