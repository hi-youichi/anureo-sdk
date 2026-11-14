// Exercises public sequencing, checkpoints and failure gates through refactorCode.
import { expect, test } from 'bun:test'
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient, HarnessSdkError, type StructuredOutputToolDefinition } from '@anureo/sdk'
import { createPiAdapter } from '@anureo/adapter-pi'
import { fakeFactory } from '../../../packages/adapter/pi/tests/fake-host'
import { startFake } from '../../../packages/adapter/hermes/tests/helpers'
import { refactorCode, formatReport } from '../src'
import { captureTree, treeVersion } from '../src/git-tree'
import { git } from '../src/git'
import { edited, fixture, graph, kind, moduleOf, plan, temporary, unchanged } from './helpers'

const DESIGN = 'DESIGN MODULE BOUNDARIES'
const MODULE = 'REFACTOR MODULE'

test('refactor completes through the Hermes gateway with schema-validated text', async () => {
  const { cwd } = await fixture()
  const server = await startFake('refactor', { FAKE_HERMES_RESPONSE_MODULE: new URL('./fixtures/answer.mjs', import.meta.url).href })
  try {
    const client = await createClient({ adapter: server.adapter(), identity: { adapterId: 'hermes', runtimeConfigId: 'refactor-test' } })
    try {
      const report = await refactorCode({ client, cwd, reviewOnly: true, noGraph: true })
      expect(report.status).toBe('completed')
      expect(report.plan?.modules[0]?.files).toEqual(['a.ts', 'b.ts'])
      expect((await server.state()).inputs).toHaveLength(3)
    } finally { await client.dispose() }
  } finally { await server.dispose() }
}, 20_000)

test('refactor completes through Pi with its structured output tool', async () => {
  const { cwd } = await fixture()
  const fake = fakeFactory(host => {
    let tool: StructuredOutputToolDefinition | undefined
    Object.assign(host, { async setOutputTool(next?: StructuredOutputToolDefinition) { tool = next } })
    host.script = async (host, prompt) => {
      const value = prompt.startsWith('PLAN') ? plan : unchanged
      expect(await tool?.execute(value)).toMatchObject({ accepted: true })
      await host.assistant('Submitted the result')
    }
  })
  const client = await createClient({
    adapter: createPiAdapter({ version: '1.5.2', createHost: fake.factory }),
    identity: { adapterId: 'pi', runtimeConfigId: 'refactor-test' },
  })
  try {
    const report = await refactorCode({ client, cwd, noGraph: true, readPermissionMode: 'read-only', editPermissionMode: 'agent-full-access' })
    expect(report.status).toBe('completed')
    expect(report.plan).toEqual(plan)
  } finally { await client.dispose() }
})

/** Require argument failure before filesystem preflight can mask it; fixture cleanup owns the client. */
test('blank library checks fail before repository setup or agent dispatch', async () => {
  const context = await fixture()
  await expect(refactorCode({ ...context, cwd: join(context.cwd, 'missing'), checks: [' '] })).rejects.toThrow('check commands must be nonempty')
  expect(context.prompts).toHaveLength(0)
  expect(await stat(join(context.cwd, '.anureo')).catch(() => null)).toBeNull()
})

test('each agent has a worktree and module sessions overlap on the same post-design baseline', async () => {
  let exports = 0
  const order: string[] = []
  const worktrees: string[] = []
  const modulesReady = Promise.withResolvers<void>()
  let runningModules = 0
  const context = await fixture(async (prompt, cwd) => {
    worktrees.push(cwd)
    expect((await git(cwd, 'rev-parse', '--show-toplevel')).trim()).toBe(cwd)
    const module = moduleOf(prompt)
    order.push(module ? `module:${module}` : kind(prompt))
    if (prompt.startsWith(DESIGN)) {
      expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe('untracked input')
      expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('unstaged')
      await writeFile(join(cwd, 'a.ts'), 'export const value = 1 // design\n')
      return edited()
    }
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('// design')
    if (prompt.startsWith('PLAN')) return plan

    if (++runningModules === 2) modulesReady.resolve()
    await modulesReady.promise
    await writeFile(join(cwd, `${module}.ts`), 'export const value = 2\n')
    expect(await readFile(join(context.cwd, 'a.ts'), 'utf8')).toContain('// design')
    const other = module === 'a' ? 'b' : 'a'
    expect(await readFile(join(cwd, `${other}.ts`), 'utf8')).toContain('value = 1')
    return edited()
  })
  await writeFile(join(context.cwd, 'README.md'), 'untracked input')
  await writeFile(join(context.cwd, 'a.ts'), 'export const value = 1 // unstaged\n')
  const indexBefore = await git(context.cwd, 'ls-files', '--stage')
  const report = await refactorCode({
    ...context, checks: ['git diff --exit-code -- .gitignore'],
    readPermissionMode: 'read-only', editPermissionMode: 'agent-full-access',
    graphLoader: async () => { exports++; return graph(context.cwd) },
  })
  expect(report.status).toBe('completed')
  expect(order.slice(0, 2)).toEqual([DESIGN, 'PLAN REFACTOR MODULES'])
  expect(order.slice(2).sort()).toEqual(['module:a', 'module:b'])
  expect(new Set(worktrees).size).toBe(4)
  expect(worktrees).not.toContain(context.cwd)
  expect(exports).toBe(2)
  expect(report.design).toMatchObject({ status: 'applied', changedFiles: ['a.ts'] })
  expect(report.modules.map(item => [item.module.id, item.step?.status])).toEqual([['a', 'applied'], ['b', 'applied']])
  expect(report.modules.every(item => item.step?.checks[0]?.status === 'passed')).toBe(true)
  for (const file of ['a.ts', 'b.ts']) expect(await readFile(join(context.cwd, file), 'utf8')).toContain('value = 2')
  for (const cwd of worktrees) expect(await stat(cwd).catch(() => null)).toBeNull()
  expect((await git(context.cwd, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1)
  expect(await git(context.cwd, 'ls-files', '--stage')).toBe(indexBefore)
  expect(context.adapter.opened.filter(session => session.permissionMode === 'read-only')).toHaveLength(1)
  expect(context.adapter.opened.filter(session => session.permissionMode === 'agent-full-access')).toHaveLength(3)
  expect(context.prompts.find(prompt => prompt.startsWith(MODULE))).toContain('Cross-module design step already done in this run: Edited')
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
  expect(await stat(join(context.cwd, '.anureo/refactor/writer.lock')).catch(() => null)).toBeNull()
})

/** Inspect scripted prompts without edits so review instructions and report wording stay aligned. */
test('prompts name the problem catalog, the graph guide and the mode', async () => {
  const context = await fixture()
  const report = await refactorCode({ ...context, reviewOnly: true })
  expect(report.status).toBe('completed')
  const design = context.prompts.find(prompt => prompt.startsWith(DESIGN))!
  const module = context.prompts.find(prompt => prompt.startsWith(MODULE))!
  for (const prompt of [design, module]) {
    expect(prompt).toContain('MODE: READ ONLY')
    expect(prompt).toContain('Graph artifact:')
    expect(prompt).toContain('local_name')
  }
  expect(design).toContain('Wrong dependency direction')
  expect(design).toContain('Import cycles between files')
  expect(module).toContain('shares mutable variables across them')
  expect(module).toContain('five or more positional parameters')
  for (const prompt of [design, module]) {
    expect(prompt).toContain('Comment WHY, not WHAT')
    expect(prompt).toContain('doc comment stating')
    expect(prompt).toContain('Documentation conventions and tags:')
    expect(prompt).toContain('re-export chains')
    expect(prompt).toContain('Declaration order:')
  }
  expect(design).toContain('Design documentation scope:')
  expect(module).toContain('Module documentation scope:')
  expect(module).toContain('including declarations\nwhose implementation stays unchanged')
  expect(formatReport(report)).toContain('review only')
})

/** Verify explicit edit checks reach the agent even when its response leaves the tree unchanged. */
test('edit mode states how to edit and lists the validation commands', async () => {
  const context = await fixture()
  await refactorCode({ ...context, checks: ['true'] })
  const module = context.prompts.find(prompt => prompt.startsWith(MODULE))!
  expect(module).toContain('MODE: EDIT')
  expect(module).toContain('Validation commands: ["true"]')
})

/** Feed malformed assignments through the real planner boundary; no module may start after rejection. */
test.each([
  { ...plan, modules: [plan.modules[0]] },
  { ...plan, modules: [plan.modules[0], plan.modules[0]] },
  { ...plan, modules: [plan.modules[0], { ...plan.modules[1], id: 'A' }] },
  { ...plan, modules: [{ ...plan.modules[0], files: ['a.ts', 'not-in-inventory.ts'] }, plan.modules[1]] },
])('rejects missing, duplicate and invented inventory assignments before any module agent', async invalid => {
  const context = await fixture(prompt => prompt.startsWith('PLAN') ? invalid : unchanged)
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(context.prompts.some(prompt => prompt.startsWith(MODULE))).toBe(false)
})

/** Inject an unknown SDK outcome after a real edit; planning must stop while the partial diff survives. */
test('a failed design step stops before planning and records its partial edit', async () => {
  const context = await fixture(async (_prompt, cwd) => {
    await writeFile(join(cwd, 'a.ts'), 'export const value = 2\n')
    return new HarnessSdkError('RECEIPT_LOST', 'Unknown', false, true)
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(report.design).toMatchObject({ status: 'failed', changedFiles: ['a.ts'], failure: { code: 'RECEIPT_LOST', outcomeUnknown: true } })
  expect(await readFile(join(context.cwd, 'a.ts'), 'utf8')).toBe('export const value = 2\n')
  expect(context.prompts).toHaveLength(1)
  expect(formatReport(report)).toContain('execution outcome is unknown')
})

test('a failed module preserves its patch and blocks integration after siblings finish', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return plan
    const module = moduleOf(prompt)
    if (!module) return unchanged
    await writeFile(join(cwd, `${module}.ts`), 'export const value = 2\n')
    return module === 'a' ? new HarnessSdkError('NATIVE_FAILED', 'Writer failed') : edited()
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.step).toMatchObject({ status: 'failed', changedFiles: ['a.ts'] })
  expect(report.modules[1]?.step).toMatchObject({ status: 'failed', error: 'Integration blocked by failed module a', changedFiles: ['b.ts'] })
  for (const result of report.modules) {
    expect(await readFile(result.step!.patch!, 'utf8')).toContain('+export const value = 2')
    expect(await readFile(join(context.cwd, `${result.module.id}.ts`), 'utf8')).toContain('value = 1')
  }
  expect((await git(context.cwd, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(1)
})

test('competing additions report a conflict and keep the earlier patch applied', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return plan
    const module = moduleOf(prompt)
    if (!module) return unchanged
    await writeFile(join(cwd, `${module}.ts`), 'export const value = 2\n')
    await writeFile(join(cwd, 'shared.ts'), `export const owner = '${module}'\n`)
    return edited()
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.step?.status).toBe('applied')
  expect(report.modules[1]?.step).toMatchObject({ status: 'failed', error: 'Source changed during refactor: shared.ts' })
  expect(await readFile(join(context.cwd, 'shared.ts'), 'utf8')).toContain("owner = 'a'")
  expect(await readFile(join(context.cwd, 'b.ts'), 'utf8')).toContain('value = 1')
})

test('edits to another module and review-only writes stay out of the target checkout', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) !== 'a') return unchanged
    await writeFile(join(cwd, 'b.ts'), 'export const value = 2\n')
    return edited()
  })
  for (const reviewOnly of [false, true]) {
    const report = await refactorCode({ ...context, reviewOnly, checks: [] })
    expect(report.status).toBe('incomplete')
    expect(report.modules[0]?.step).toMatchObject({
      status: 'failed', changedFiles: ['b.ts'],
      error: reviewOnly ? 'Review-only agent modified files' : 'Module edited paths outside its assignment: b.ts',
    })
    expect(await readFile(join(context.cwd, 'b.ts'), 'utf8')).toContain('value = 1')
  }
})

/** Fail a check after the first patch applies so the second patch exercises the integration gate. */
test('failed validation retains its output and stops later integration', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return plan
    const module = moduleOf(prompt)
    if (!module) return unchanged
    await writeFile(join(cwd, `${module}.ts`), 'export const value = 2\n')
    return edited()
  })
  const report = await refactorCode({ ...context, checks: [
    { executable: process.execPath, args: ['-e', 'console.error("validation-broken"); process.exit(7)'] },
    { executable: process.execPath, args: ['-e', 'Bun.write("later-check-ran", "unexpected")'] },
  ] })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.step?.checks[0]).toMatchObject({ status: 'failed', output: expect.stringContaining('validation-broken') })
  expect(report.modules).toHaveLength(2)
  expect(report.modules[0]?.step?.checks).toHaveLength(1)
  expect(report.modules[1]?.step).toMatchObject({
    status: 'failed',
    error: 'Integration blocked by failed module a',
    changedFiles: ['b.ts'],
    checks: [],
  })
  expect(await readFile(join(context.cwd, 'a.ts'), 'utf8')).toBe('export const value = 2\n')
  expect(await readFile(join(context.cwd, 'b.ts'), 'utf8')).toBe('export const value = 1\n')
  expect(await stat(join(context.cwd, 'later-check-ran')).catch(() => null)).toBeNull()
})

test('the plan checkpoint is published before either module starts', async () => {
  let directory = ''
  const context = await fixture(async prompt => {
    if (prompt.startsWith(DESIGN)) return unchanged
    const saved = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
    expect(saved.design.status).toBe('unchanged')
    if (prompt.startsWith('PLAN')) {
      expect(saved.plan).toBeNull()
      return plan
    }
    expect(saved.plan).toEqual(plan)
    expect(saved.modules).toEqual([])
    return unchanged
  })
  const report = await refactorCode({ ...context, checks: [],
    onProgress: event => { if (event.startsWith('run: ')) directory = event.slice('run: '.length) },
  })
  expect(report.status).toBe('completed')
})

test('a failed post-design graph refresh prevents module dispatch and releases the lock', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return plan
    if (prompt.startsWith(DESIGN)) {
      await writeFile(join(cwd, 'a.ts'), 'export const value = 2\n')
      return edited()
    }
    return unchanged
  })
  let exports = 0
  const report = await refactorCode({ ...context, checks: [],
    graphLoader: async () => {
      if (++exports === 2) throw new Error('Graph refresh unavailable')
      return graph(context.cwd)
    },
  })
  expect(report.status).toBe('incomplete')
  expect(report.errors).toEqual(['Graph refresh unavailable'])
  expect(report.modules).toEqual([])
  expect(context.prompts.some(prompt => prompt.startsWith(MODULE))).toBe(false)
  expect(await readFile(join(context.cwd, 'a.ts'), 'utf8')).toBe('export const value = 2\n')
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
  expect(await stat(join(context.cwd, '.anureo/refactor/writer.lock')).catch(() => null)).toBeNull()
})

/** Discover real package scripts and confirm typecheck failure prevents the test script from running. */
test('default validation discovers root package scripts and stops on a failing typecheck', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) === 'a') await writeFile(join(cwd, 'a.ts'), 'const named = 1; export { named as value }\n')
    return moduleOf(prompt) === 'a' ? edited() : unchanged
  })
  await writeFile(join(context.cwd, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.2', scripts: { typecheck: 'exit 9', test: 'exit 0' } }))
  const report = await refactorCode(context)
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.step?.checks).toMatchObject([{ command: 'bun run typecheck', status: 'failed' }])
})

/** Move/add files during design so the host diff and post-design inventory use observed paths. */
test('moves and new files need no declaration and are reported from the real diff', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith('PLAN')) return { ...plan, modules: [{ ...plan.modules[0], files: ['moved.ts', 'types.ts'] }, plan.modules[1]] }
    if (prompt.startsWith(DESIGN)) {
      await rename(join(cwd, 'a.ts'), join(cwd, 'moved.ts'))
      await writeFile(join(cwd, 'types.ts'), 'export type T = 1\n')
      return edited('Moved a.ts, added types.ts')
    }
    return unchanged
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('completed')
  expect(report.design?.changedFiles).toEqual(['a.ts', 'moved.ts', 'types.ts'])
  expect(report.plan).not.toBeNull()
})

/** Add a design-time source and require its inclusion in the subsequent planning prompt. */
test('the plan is made from the tree after the design step', async () => {
  const context = await fixture(async (prompt, cwd) => {
    if (prompt.startsWith(DESIGN)) { await writeFile(join(cwd, 'extra.ts'), 'export const extra = 1\n'); return edited() }
    if (prompt.startsWith('PLAN')) return { ...plan, modules: [{ ...plan.modules[0], files: ['a.ts', 'extra.ts'] }, plan.modules[1]] }
    return unchanged
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('completed')
  expect(context.prompts.find(prompt => prompt.startsWith('PLAN'))).toContain('"extra.ts"')
})

/** Use an external fixture path to ensure source safety rejects links before graph or agent work. */
test.skipIf(process.platform === 'win32')('a symlinked source file is rejected before any agent runs', async () => {
  const outside = await temporary()
  const context = await fixture()
  await writeFile(join(outside, 'x.ts'), 'export const x = 1\n')
  await symlink(join(outside, 'x.ts'), join(context.cwd, 'linked.ts'))
  const report = await refactorCode({ ...context })
  expect(report.status).toBe('incomplete')
  expect(report.errors.join()).toContain('Symlink')
  expect(context.prompts).toHaveLength(0)
})

/** Precreate a competing writer lock; acquisition failure must reject without dispatching agents. */
test('one cooperating process owns the tree', async () => {
  const context = await fixture()
  await mkdir(join(context.cwd, '.anureo/refactor'), { recursive: true })
  await writeFile(join(context.cwd, '.anureo/refactor/writer.lock'), 'active')
  await expect(refactorCode(context)).rejects.toThrow('Cannot acquire refactor lock')
  expect(context.prompts).toHaveLength(0)
})

/** Throw from the observer and supply a failing check; unchanged steps must still complete without edits. */
test('progress errors are observational and unchanged steps run no checks', async () => {
  const context = await fixture()
  const before = treeVersion(await captureTree(context.cwd))
  const report = await refactorCode({ ...context, checks: ['exit 1'], onProgress: () => { throw new Error('Sink unavailable') } })
  expect(report.status).toBe('completed')
  expect(report.modules.map(item => item.step?.status)).toEqual(['unchanged', 'unchanged'])
  expect(report.progressErrors.length).toBeGreaterThan(0)
  expect(treeVersion(await captureTree(context.cwd))).toBe(before)
})

/** Target a nested Git directory to verify inventory and graph context do not expand to the repository root. */
test('a subdirectory of a Git repository is a valid target and only its files are in scope', async () => {
  const context = await fixture(async (prompt, cwd) => {
    expect(await readFile(join(cwd, '..', 'a.ts'), 'utf8')).toContain('value = 1')
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) !== 'a') return unchanged
    await writeFile(join(cwd, 'a.ts'), 'export const value = 3\n')
    return edited()
  })
  await mkdir(join(context.cwd, 'pkg'))
  const cwd = join(context.cwd, 'pkg')
  await Promise.all(['a.ts', 'b.ts'].map(file => writeFile(join(cwd, file), 'export const value = 1\n')))
  const report = await refactorCode({ ...context, cwd, checks: [], graphLoader: async () => graph(cwd) })
  expect(report.status).toBe('completed')
  expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toContain('value = 3')
  expect(await readFile(join(context.cwd, 'a.ts'), 'utf8')).toContain('value = 1')
  expect(JSON.parse(context.prompts.find(prompt => prompt.startsWith('PLAN'))!.split('Inventory: ')[1]!.split('\n')[0]!)).toEqual(['a.ts', 'b.ts'])
})
