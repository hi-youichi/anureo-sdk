import { expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/cli'
import { loadGraph } from '../src/graph'
import { exec } from '../src/source'
import { edited, fixture, moduleOf, plan, temporary, unchanged } from './helpers'

test('help and invalid arguments do not construct a backend', async () => {
  let created = 0
  const dependencies = { stdout: () => {}, stderr: () => {}, createClient: async () => { created++; throw new Error('Unexpected backend') } }
  expect(await runCli(['--help'], dependencies)).toBe(0)
  for (const args of [['--unknown'], ['--concurrency', '2'], ['a', 'b'], ['--check', ' ']]) {
    expect(await runCli(args, dependencies)).toBe(2)
  }
  expect(created).toBe(0)
})

test('CLI reports completion and owns client cleanup', async () => {
  const context = await fixture(prompt => prompt.startsWith('PLAN') ? plan : moduleOf(prompt) === 'a' ? edited() : unchanged)
  let output = ''
  const code = await runCli([context.cwd, '--review-only', '--json'], {
    ...context, createClient: async () => context.client,
    stdout: text => { output += text }, stderr: () => {},
  })
  expect(code).toBe(0)
  expect(JSON.parse(output)).toMatchObject({ status: 'completed', reviewOnly: true })
  expect(context.adapter.disposeCount).toBe(1)
})

test('graph adapter invokes the real subprocess interface and reads its JSON', async () => {
  const context = await fixture()
  const entry = fileURLToPath(new URL('./fixtures/repograph.ts', import.meta.url))
  const graph = await loadGraph(context.cwd, entry)
  expect(graph.kind).toBe('all')
  expect(graph.nodes[0]?.filePath).toBe('main.ts')
})

test('installed CLI entry runs from an unrelated cwd through real Codex and graph process boundaries', async () => {
  const target = await temporary()
  const outside = await temporary()
  await writeFile(join(target, 'main.ts'), 'export function main() { return 1 }\n')
  await exec('git', ['init', '-q', target])
  const binary = fileURLToPath(new URL('../../../node_modules/.bin/anureo-refactor', import.meta.url))
  const codex = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url))
  const repograph = fileURLToPath(new URL('./fixtures/repograph.ts', import.meta.url))
  const { stdout, stderr } = await exec(process.execPath, [binary, target, '--review-only', '--repograph', repograph, '--json'], {
    cwd: outside, env: { ...process.env, CODEX_BIN: codex }, timeout: 20_000, maxBuffer: 1 << 20,
  })
  const report = JSON.parse(stdout)
  expect(report).toMatchObject({ status: 'completed', reviewOnly: true })
  expect(report.modules[0].module.id).toBe('main')
  expect(stderr).toContain('module/main: unchanged')
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
}, 25_000)
