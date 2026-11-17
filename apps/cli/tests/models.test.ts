import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexModels, claudeModels, piModels, loadSwarmModelCatalog } from '../src/models'
import { runCli } from '../src/cli'

test('catalog normalization uses backend execution IDs and preserves hidden/default metadata', () => {
  expect(codexModels([{ id: 'execution-id', name: 'Display', hidden: true, isDefault: true }])).toEqual([{ id: 'execution-id', name: 'Display', hidden: true, isDefault: true }])
  expect(claudeModels([{ value: 'claude-value', displayName: 'Claude display', description: 'Description' }])).toEqual([{ id: 'claude-value', name: 'Claude display', description: 'Description' }])
  expect(claudeModels([{ value: 'id', displayName: '', description: '' }])).toEqual([{ id: 'id' }])
  expect(piModels([{ ref: 'provider/path/model', name: 'Pi display', reasoning: true, thinkingLevels: [] }])).toEqual([{ id: 'provider/path/model', name: 'Pi display' }])
})

test('discovery absence, empty results and failure remain distinct and keep legacy defaults usable', async () => {
  const diagnostics: string[] = []
  const log = (message: string) => { diagnostics.push(message) }
  expect((await loadSwarmModelCatalog(undefined, log)).default?.status).toBe('unavailable')
  expect(await loadSwarmModelCatalog(async () => [], log)).toEqual({ default: { status: 'available', models: [] } })
  expect((await loadSwarmModelCatalog(async () => { throw new Error('private native message') }, log)).default?.status).toBe('unavailable')
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]).not.toContain('private native message')
  for (const invalid of [[{ id: 'a' }, { id: 'a' }], [{ id: ' ' }], [{ id: 'model', description: 'x'.repeat(4001) }]]) {
    expect((await loadSwarmModelCatalog(async () => invalid, log)).default?.status).toBe('unavailable')
  }
})

test('Codex CLI discovers with its launch settings, injects the catalog and survives discovery failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-model-catalog-'))
  const fixture = fileURLToPath(new URL('../../../packages/adapter/codex/tests/fake-app-server.mjs', import.meta.url))
  const originalLog = process.env.FAKE_LOG_FILE
  const originalScenario = process.env.FAKE_SCENARIO
  try {
    for (const scenario of ['normal', 'model-loop']) {
      const log = join(directory, `${scenario}.jsonl`)
      process.env.FAKE_LOG_FILE = log
      process.env.FAKE_SCENARIO = scenario
      let stdout = '', stderr = ''
      expect(await runCli([
        '--harness', 'swarm:codex', '--command', process.execPath, '--args', JSON.stringify([fixture]),
        '--cd', directory, '--model', 'main-choice', '--output', 'result', '--verbose', 'Inspect',
      ], { stdout: text => { stdout += text }, stderr: text => { stderr += text } })).toBe(0)
      expect(JSON.parse(stdout).status).toBe('completed')
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(calls.some(call => call.method === 'model/list')).toBe(true)
      const threads = calls.filter(call => call.method === 'thread/start')
      expect(threads).toHaveLength(1)
      expect(threads[0].params).toMatchObject({ cwd: directory, model: 'main-choice' })
      const instructions: string = threads[0].params.developerInstructions
      expect(instructions).toContain('Backend model catalogs:')
      if (scenario === 'normal') {
        expect(instructions).toContain('"id":"gpt-6.1-sol"')
        expect(instructions).not.toContain('gpt-reserve')
        expect(stderr).not.toContain('discovery failed')
      } else {
        expect(instructions).toContain('"status":"unavailable"')
        expect(stderr).toContain('Model discovery failed')
      }
    }
  } finally {
    if (originalLog === undefined) delete process.env.FAKE_LOG_FILE; else process.env.FAKE_LOG_FILE = originalLog
    if (originalScenario === undefined) delete process.env.FAKE_SCENARIO; else process.env.FAKE_SCENARIO = originalScenario
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
