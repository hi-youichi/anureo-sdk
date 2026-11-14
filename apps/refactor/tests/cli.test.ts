// Verifies CLI exit codes, client ownership and subprocess boundaries with scripted harnesses.
import { expect, spyOn, test } from 'bun:test'
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runCli } from '../src/cli'
import { refactorHarnesses } from '../src/client'
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
  for (const args of [
    ['--unknown'], ['--concurrency', '0'], ['--concurrency', '1.5'], ['a', 'b'], ['--check', ' '],
    ['--check-argv', '[]'], ['--check-argv', '["git", 1]'], ['--no-graph', '--repograph', 'other.ts'],
    ['--harness', 'unknown'], ['--harness', 'acp'], ['--harness-url', 'ws://localhost:3000'],
    ['--harness', 'ahp', '--harness-command', 'peer', '--harness-url', 'ws://localhost:3000'],
  ]) {
    expect(await runCli(args, dependencies)).toBe(2)
  }
  expect(created).toBe(0)
  expect(errors).toContain('anureo-refactor: --concurrency must be a positive integer\n')
  expect(errors).toContain('anureo-refactor: --check commands must be nonempty\n')
})

test('CLI limits concurrent module sessions while running every planned module', async () => {
  let active = 0
  let peak = 0
  const modules = Array.from({ length: 10 }, (_, index) => ({
    id: `module-${index}`, name: `Module ${index}`, description: 'Fixture module',
    files: [`module-${index}.ts`],
  }))
  const firstWorkersReady = Promise.withResolvers<void>()
  const context = await fixture(async prompt => {
    if (prompt.startsWith('PLAN')) return { summary: plan.summary, modules }
    if (!moduleOf(prompt)) return unchanged
    peak = Math.max(peak, ++active)
    if (active === 8) firstWorkersReady.resolve()
    await firstWorkersReady.promise
    active--
    return unchanged
  })
  await Promise.all(modules.map(module => writeFile(join(context.cwd, module.files[0]!), 'export {}\n')))
  let output = ''
  const code = await runCli([
    context.cwd, '--include', 'module-*.ts', '--concurrency', '8', '--review-only', '--no-graph', '--json',
  ], {
    stdout: text => { output += text }, stderr: () => {}, createClient: async () => context.client,
  })
  expect({ code, errors: JSON.parse(output).errors }).toEqual({ code: 0, errors: [] })
  expect(peak).toBe(8)
  expect(JSON.parse(output).modules.map((result: { module: { id: string } }) => result.module.id))
    .toEqual(modules.map(module => module.id))
})

test.each([...refactorHarnesses])('CLI dispatches %s with the matching permission and model settings', async id => {
  const context = await fixture()
  const transport = id === 'acp' ? ['--harness-command', 'agent', '--harness-arg=--stdio']
    : id === 'ahp' ? ['--harness-url', 'ws://localhost:3000'] : []
  const code = await runCli([context.cwd, '--harness', id, ...transport, '--review-only'], {
    ...context, env: { CODEX_MODEL: 'codex-fixture' }, stdout: () => {}, stderr: () => {},
    createClient: async (cwd, selection) => {
      expect(cwd).toBe(context.cwd)
      expect(selection.id).toBe(id)
      if (id === 'acp') expect(selection).toMatchObject({ command: 'agent', args: ['--stdio'] })
      if (id === 'ahp') expect(selection.url).toBe('ws://localhost:3000')
      return context.client
    },
  })
  expect(code).toBe(0)
  const mode = id === 'claude' ? 'plan' : id === 'codex' || id === 'pi' ? 'read-only' : undefined
  expect(context.adapter.opened).toHaveLength(4)
  for (const session of context.adapter.opened) {
    expect(session.permissionMode).toBe(mode)
    expect(session.model).toBe(id === 'codex' ? 'codex-fixture' : undefined)
  }
  expect(context.adapter.disposeCount).toBe(1)
})

test.each(['acp', 'ahp'])('installed CLI completes a run over a scripted %s stdio peer', async id => {
  const target = await temporary()
  await exec('git', ['init', '-q', target])
  await writeFile(join(target, 'task.custom'), 'do work\n')
  const peer = fileURLToPath(new URL(`./fixtures/${id}.mjs`, import.meta.url))
  const { stdout } = await runInstalledCli([
    target, '--harness', id, '--harness-command', process.execPath, '--harness-arg', peer,
    '--no-graph', '--review-only', '--json',
  ])
  expect(JSON.parse(stdout)).toMatchObject({
    status: 'completed', plan: { modules: [{ files: ['task.custom'] }] },
    modules: [{ step: { status: 'unchanged' } }],
  })
}, 25_000)

test('installed CLI completes a run through the Claude SDK with native structured output', async () => {
  const target = await temporary()
  const state = await temporary()
  await exec('git', ['init', '-q', target])
  await writeFile(join(target, 'script.rb'), 'puts "hello"\n')
  const claude = fileURLToPath(new URL('../../../packages/adapter/claude/tests/fixtures/fake-claude.mjs', import.meta.url))
  const answer = fileURLToPath(new URL('./fixtures/answer.mjs', import.meta.url))
  const { stdout } = await runInstalledCli([
    target, '--harness', 'claude', '--no-graph', '--review-only', '--json',
  ], { env: { ...process.env, CLAUDE_BIN: claude, CLAUDE_CONFIG_DIR: state, FAKE_STRUCTURED_ANSWER: answer } })
  expect(JSON.parse(stdout)).toMatchObject({
    status: 'completed', plan: { modules: [{ files: ['script.rb'] }] },
  })
}, 25_000)

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
  { failure: 'incomplete', cleanupError: 'Disposal unavailable' },
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
      graphLoader: failure === 'incomplete' ? async () => { throw new Error('Graph unavailable') } : context.graphLoader,
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
      expect(JSON.parse(output).status).toBe(failure === 'incomplete' ? 'incomplete' : 'completed')
      if (failure === 'output') expect(errors).toContain('anureo-refactor: Output unavailable\n')
    }
    if (cleanupError) {
      const executionThrew = failure === 'output' || failure === 'preflight'
      const diagnostic = `anureo-refactor: ${executionThrew ? 'cleanup failed: ' : ''}${cleanupError}\n`
      expect(errors).toContain(diagnostic)
      expect(errors.endsWith(diagnostic)).toBe(!executionThrew)
      if (!executionThrew) expect(errors).not.toContain('cleanup failed:')
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
  expect(graph.nodes[0]?.callable).toEqual({ parameters: [], returnType: 'number' })
})

/** Launch the installed entry outside its target with scripted Codex/repograph executables, then
 * compare stdout with the persisted report. Temporary repositories are fixture-owned;
 * executable failures/timeouts reject the test. No model calls or live indexing are involved. */
test('installed CLI entry runs from an unrelated cwd through real Codex and graph process boundaries', async () => {
  const target = await temporary()
  const outside = await temporary()
  await writeFile(join(target, 'main.ts'), 'export function main() { return 1 }\n')
  await writeFile(join(target, 'task.dsl'), 'do work\n')
  await exec('git', ['init', '-q', target])
  const repograph = fileURLToPath(new URL('./fixtures/repograph.ts', import.meta.url))
  const { stdout, stderr } = await runInstalledCli([target, '--review-only', '--repograph', repograph, '--json'], {
    cwd: outside, env: { ...process.env, CODEX_BIN: codexFixture }, maxBuffer: 1 << 20,
  })
  const report = JSON.parse(stdout)
  expect(report).toMatchObject({ status: 'completed', reviewOnly: true })
  expect(report.modules[0].module.id).toBe('main')
  expect(report.graphCoverage).toEqual([{ phase: 'design', status: 'available', filesWithoutSymbols: ['task.dsl'] }])
  expect(stderr).toContain('module/main: unchanged')
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
}, 25_000)

test('installed CLI edits a mixed-language repository and runs ordered checks without a graph', async () => {
  const target = join(await temporary(), 'mixed 项目')
  const outside = await temporary()
  await mkdir(target)
  await exec('git', ['init', '-q', target])
  for (const [file, content] of Object.entries({
    'main.py': 'def main(): return 1\r\n', 'worker.zig': 'pub fn run() void {}\n',
    'start': '#!/bin/sh\nexit 0\n', 'job 配置.custom': 'task = "main"\n',
    'excluded.custom': 'task = "ignore"\n', 'binary.custom': Buffer.from([0, 0xff]),
    'README.md': '# Project\n', 'secret.txt': 'outside the include patterns\n',
  })) await writeFile(join(target, file), content)
  const literal = 'label with spaces & symbols %! ${value}'
  const check = [
    process.execPath, '-e',
    'if (process.argv[1] !== "label with spaces & symbols %! ${value}") process.exit(7); console.log("verified")',
    literal,
  ]
  const { stdout } = await runInstalledCli([
    target, '--no-graph', '--json', '--include', '**/*.{py,zig,custom}',
    '--include', 'start', '--exclude', 'excluded.*', '--check-argv', JSON.stringify(check),
    '--check', 'git rev-parse --is-inside-work-tree',
  ], {
    cwd: outside, env: { ...process.env, CODEX_BIN: codexFixture, REFACTOR_FIXTURE_EDIT: 'job 配置.custom' },
    maxBuffer: 1 << 20,
  })
  const report = JSON.parse(stdout)
  const files = ['job 配置.custom', 'main.py', 'start', 'worker.zig']
  expect(report.status).toBe('completed')
  expect(report.modules[0].module.files).toEqual(files)
  expect(report.modules[0].step).toMatchObject({
    status: 'applied', changedFiles: ['job 配置.custom'],
    checks: [{ status: 'passed', output: expect.stringContaining('verified') },
      { status: 'passed', output: expect.stringContaining('true') }],
  })
  expect(report.graphCoverage).toEqual([{ phase: 'design', status: 'disabled', filesWithoutSymbols: files }])
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
}, 25_000)

test('CLI automatically falls back when the optional graph package is absent', async () => {
  const target = await temporary()
  const isolated = await temporary()
  await exec('git', ['init', '-q', target])
  await writeFile(join(target, 'program.unknown-dsl'), 'do work\n')
  const packageDirectory = dirname(dirname(installedEntry()))
  for (const folder of ['bin', 'src']) await cp(join(packageDirectory, folder), join(isolated, folder), { recursive: true })
  await mkdir(join(isolated, 'node_modules', '@anureo'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.dependencies)) {
    const directory = await realpath(join(packageDirectory, 'node_modules', name))
    await symlink(directory, join(isolated, 'node_modules', name), 'junction')
  }
  const { stdout, stderr } = await exec(process.execPath, [
    join(isolated, 'bin', 'anureo-refactor.ts'), target, '--review-only', '--json',
  ], { cwd: isolated, env: { ...process.env, CODEX_BIN: codexFixture }, timeout: 20_000 })
  expect(JSON.parse(stdout)).toMatchObject({
    status: 'completed',
    graphCoverage: [{ phase: 'design', status: 'unavailable', filesWithoutSymbols: ['program.unknown-dsl'] }],
  })
  expect(stderr).toContain('continuing with source')
}, 25_000)

const codexFixture = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url))

/** Run the package-resolved CLI in a child with a 20-second timeout. Return its buffered streams
 * on success. Failed resolution, launch, exit, timeout or buffer errors reject the test. */
async function runInstalledCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}) {
  return exec(process.execPath, [installedEntry(), ...args], { ...options, timeout: 20_000 })
}

/** Locate the executable relative to the resolved package root entry, independent of test cwd.
 * A missing package throws here. The optional-dependency test also uses this to locate copy inputs. */
function installedEntry(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@anureo/refactor')), '../bin/anureo-refactor.ts')
}
