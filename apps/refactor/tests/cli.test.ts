// Verifies CLI exit codes, client ownership and process boundaries; it must not require live models or credentials.
import { expect, spyOn, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/cli'
import { loadGraph } from '../src/graph'
import { exec } from '../src/process'
import { edited, fixture, moduleOf, plan, temporary, unchanged } from './helpers'

/** Exercise argument/help precedence without acquiring a client; failures remain CLI diagnostics. */
test('help and invalid arguments do not construct a backend', async () => {
  let created = 0
  let errors = ''
  const dependencies = {
    stdout: () => {}, stderr: (text: string) => { errors += text },
    createClient: async () => { created++; throw new Error('Unexpected backend') },
  }
  expect(await runCli(['--help'], dependencies)).toBe(0)
  expect(await runCli(['--help', 'a', 'b', '--check', ' '], dependencies)).toBe(0)
  for (const args of [['--unknown'], ['--concurrency', '2'], ['a', 'b'], ['--check', ' ']]) {
    expect(await runCli(args, dependencies)).toBe(2)
  }
  expect(created).toBe(0)
  expect(errors).toContain('anureo-refactor: --check commands must be nonempty\n')
})

/** Run scripted agents through the CLI; the shared fixture removes the repository after assertions. */
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

/** Check primary/cleanup error precedence and awaited disposal after preflight or report output.
 * Each case uses a real scripted client; the one-shot disposal override releases it before failing. */
test.each([
  { failure: 'none', cleanupError: null },
  { failure: 'none', cleanupError: 'Disposal unavailable' },
  { failure: 'output', cleanupError: null },
  { failure: 'output', cleanupError: 'Disposal unavailable' },
  { failure: 'preflight', cleanupError: null },
  { failure: 'preflight', cleanupError: 'Disposal unavailable' },
])('CLI handles $failure failure with cleanup error $cleanupError', async ({ failure, cleanupError }) => {
  const context = await fixture()
  const events: string[] = []
  let output = ''
  let errors = ''
  const dispose = context.client.dispose.bind(context.client)
  /** Release actual SDK resources before injecting a rejection, leaving shared cleanup safe to retry. */
  const disposal = spyOn(context.client, 'dispose').mockImplementationOnce(async () => {
    await dispose()
    events.push('disposed')
    if (cleanupError) throw new Error(cleanupError)
  })
  try {
    const cwd = failure === 'preflight' ? join(context.cwd, 'missing') : context.cwd
    const code = await runCli([cwd, '--json'], {
      ...context, createClient: async () => context.client,
      /** Record report delivery before optionally failing the sink to exercise post-run cleanup. */
      stdout: text => {
        output += text
        events.push('report')
        if (failure === 'output') throw new Error('Output unavailable')
      },
      stderr: text => { errors += text },
    })
    expect(code).toBe(failure === 'none' && !cleanupError ? 0 : 2)
    expect(events).toEqual(failure === 'preflight' ? ['disposed'] : ['report', 'disposed'])
    expect(disposal).toHaveBeenCalledTimes(1)
    expect(context.adapter.disposeCount).toBe(1)
    if (failure === 'preflight') {
      expect(output).toBe('')
      expect(errors).toContain('missing')
      expect(errors).toContain('anureo-refactor: ')
    } else {
      expect(JSON.parse(output).status).toBe('completed')
      if (failure === 'output') expect(errors).toContain('anureo-refactor: Output unavailable\n')
    }
    if (cleanupError) {
      const diagnostic = failure === 'none' ? `anureo-refactor: ${cleanupError}\n` : `anureo-refactor: cleanup failed: ${cleanupError}\n`
      expect(errors).toContain(diagnostic)
      expect(errors.endsWith(diagnostic)).toBe(failure === 'none')
    } else {
      expect(errors).not.toContain('cleanup failed:')
      if (failure === 'none') expect(errors).not.toContain('anureo-refactor:')
    }
  } finally { disposal.mockRestore() }
})

/** A reported orchestration failure still prints JSON and disposes the CLI client before returning 2. */
test('CLI prints an incomplete report and cleans up its client', async () => {
  const context = await fixture()
  let output = ''
  const code = await runCli([context.cwd, '--json'], {
    ...context, createClient: async () => context.client,
    graphLoader: async () => { throw new Error('Graph unavailable') },
    stdout: text => { output += text }, stderr: () => {},
  })
  expect(code).toBe(2)
  expect(JSON.parse(output)).toMatchObject({ status: 'incomplete', errors: ['Graph unavailable'] })
  expect(context.adapter.disposeCount).toBe(1)
  expect(context.prompts).toHaveLength(0)
})

/** Use the deterministic graph executable to verify transport/JSON handling without live indexing. */
test('graph adapter invokes the real subprocess interface and reads its JSON', async () => {
  const context = await fixture()
  const entry = fileURLToPath(new URL('./fixtures/repograph.ts', import.meta.url))
  const graph = await loadGraph(context.cwd, entry)
  expect(graph.kind).toBe('all')
  expect(graph.nodes[0]?.filePath).toBe('main.ts')
})

/** Launch the installed entry outside its target, then compare stdout with the persisted report.
 * Temporary repositories are fixture-owned; executable failures/timeouts reject the test. */
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
