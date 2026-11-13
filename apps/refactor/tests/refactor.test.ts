// Verifies public sequencing, checkpoints and failure gates; it must not implement production orchestration.
import { expect, test } from 'bun:test'
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'
import { refactorCode, formatReport } from '../src'
import { captureTree, treeVersion } from '../src/git-tree'
import { edited, fixture, graph, kind, moduleOf, plan, temporary, unchanged } from './helpers'

const DESIGN = 'DESIGN MODULE BOUNDARIES'
const MODULE = 'REFACTOR MODULE'

/** Require argument failure before filesystem preflight can mask it; fixture cleanup owns the client. */
test('blank library checks fail before repository setup or agent dispatch', async () => {
  const context = await fixture()
  await expect(refactorCode({ ...context, cwd: join(context.cwd, 'missing'), checks: [' '] })).rejects.toThrow('check commands must be nonempty')
  expect(context.prompts).toHaveLength(0)
  expect(await stat(join(context.cwd, '.anureo')).catch(() => null)).toBeNull()
})

/** Use real awaited edits to detect overlapping agents and verify graph refreshes and final publication. */
test('design runs first, then planning, then one editing agent per module in series with graph refreshes', async () => {
  let active = 0
  let peak = 0
  let exports = 0
  const order: string[] = []
  const context = await fixture(async prompt => {
    order.push(kind(prompt) === MODULE ? `module:${moduleOf(prompt)}` : kind(prompt))
    if (prompt.startsWith('PLAN')) return plan
    active++
    peak = Math.max(peak, active)
    if (prompt.startsWith(DESIGN)) await writeFile(join(context.cwd, 'a.ts'), 'export const value = 1 // design\n')
    else await writeFile(join(context.cwd, `${moduleOf(prompt)}.ts`), 'export const value = 2\n')
    active--
    return edited()
  })
  const report = await refactorCode({ ...context, checks: ['git diff --exit-code -- .gitignore'], graphLoader: async () => { exports++; return graph(context.cwd) } })
  expect(report.status).toBe('completed')
  expect(order).toEqual([DESIGN, 'PLAN REFACTOR MODULES', 'module:a', 'module:b'])
  expect(peak).toBe(1)
  expect(exports).toBe(3) // design, after design edits, before module b
  expect(report.design).toMatchObject({ status: 'applied', changedFiles: ['a.ts'] })
  expect(report.modules.map(item => item.step?.status)).toEqual(['applied', 'applied'])
  expect(report.modules.every(item => item.step?.checks[0]?.status === 'passed')).toBe(true)
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
  expect(formatReport(report)).toContain('read-only prompt')
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
  { ...plan, modules: [{ ...plan.modules[0], files: ['a.ts', 'not-in-inventory.ts'] }, plan.modules[1]] },
])('rejects missing, duplicate and invented inventory assignments before any module agent', async invalid => {
  const context = await fixture(prompt => prompt.startsWith('PLAN') ? invalid : unchanged)
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(context.prompts.some(prompt => prompt.startsWith(MODULE))).toBe(false)
})

/** Inject an unknown SDK outcome after a real edit; planning must stop while the partial diff survives. */
test('a failed design step stops before planning and records its partial edit', async () => {
  const context = await fixture(async prompt => {
    await writeFile(join(context.cwd, 'a.ts'), 'export const value = 2\n')
    return new HarnessSdkError('RECEIPT_LOST', 'Unknown', false, true)
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(report.design).toMatchObject({ status: 'failed', changedFiles: ['a.ts'], failure: { code: 'RECEIPT_LOST', outcomeUnknown: true } })
  expect(context.prompts).toHaveLength(1)
  expect(formatReport(report)).toContain('execution outcome is unknown')
})

/** Fail the first module after writing so serial failure cannot hide edits or dispatch its successor. */
test('a failed module stops later modules and keeps its partial edits', async () => {
  const context = await fixture(async prompt => {
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) === 'a') {
      await writeFile(join(context.cwd, 'a.ts'), 'export const value = 2\n')
      return new HarnessSdkError('NATIVE_FAILED', 'Writer failed')
    }
    return unchanged
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('incomplete')
  expect(report.modules).toHaveLength(1)
  expect(report.modules[0]?.step).toMatchObject({ status: 'failed', changedFiles: ['a.ts'] })
  expect(context.prompts.some(prompt => moduleOf(prompt) === 'b')).toBe(false)
})

/** Fail a shell gate after a real module edit; retain diagnostics and prevent later checks and modules. */
test('failed validation retains its output and stops later modules', async () => {
  const context = await fixture(async prompt => {
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) === 'a') await writeFile(join(context.cwd, 'a.ts'), 'export const value = 2\n')
    return moduleOf(prompt) === 'a' ? edited() : unchanged
  })
  const report = await refactorCode({ ...context, checks: ['echo validation-broken >&2; exit 7', 'touch later-check-ran'] })
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.step?.checks[0]).toMatchObject({ status: 'failed', output: expect.stringContaining('validation-broken') })
  expect(report.modules).toHaveLength(1)
  expect(report.modules[0]?.step?.checks).toHaveLength(1)
  expect(await stat(join(context.cwd, 'later-check-ran')).catch(() => null)).toBeNull()
})

/** Read published checkpoints from the next agent to prove a phase never outruns its report write.
 * The shared fixture supplies real storage and SDK sessions; read/assertion failures fail the run. */
test('each next agent sees the previous checkpoint before dispatch', async () => {
  let directory = ''
  const checkpoints: string[] = []
  const context = await fixture(async prompt => {
    if (prompt.startsWith(DESIGN)) return unchanged
    const saved = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
    expect(saved.design.status).toBe('unchanged')
    if (prompt.startsWith('PLAN')) {
      expect(saved.plan).toBeNull()
      checkpoints.push('design')
      return plan
    }
    expect(saved.plan).toEqual(plan)
    if (moduleOf(prompt) === 'a') {
      expect(saved.modules).toEqual([])
      checkpoints.push('plan')
    } else {
      expect(saved.modules).toHaveLength(1)
      expect(saved.modules[0].step.status).toBe('unchanged')
      checkpoints.push('module:a')
    }
    return unchanged
  })
  const report = await refactorCode({ ...context, checks: [],
    /** Capture the lifecycle-owned directory before the first agent needs its checkpoint. */
    onProgress: event => { if (event.startsWith('run: ')) directory = event.slice('run: '.length) },
  })
  expect(report.status).toBe('completed')
  expect(checkpoints).toEqual(['design', 'plan', 'module:a'])
})

/** Fail the graph refresh after an applied module to verify its successor is recorded but never dispatched.
 * Real edits remain, the final report is published and the writer lock must still be released. */
test('graph refresh failure retains the pending module and releases the lock', async () => {
  const context = await fixture(async prompt => {
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) === 'a') {
      await writeFile(join(context.cwd, 'a.ts'), 'export const value = 2\n')
      return edited()
    }
    return unchanged
  })
  let exports = 0
  const events: string[] = []
  const report = await refactorCode({ ...context, checks: [],
    /** Fail only the post-edit export, leaving design and planning on the normal path. */
    graphLoader: async () => {
      if (++exports === 2) throw new Error('Graph refresh unavailable')
      return graph(context.cwd)
    },
    onProgress: event => { events.push(event) },
  })
  expect(report.status).toBe('incomplete')
  expect(report.errors).toEqual(['Graph refresh unavailable'])
  expect(report.modules.map(item => item.step?.status ?? null)).toEqual(['applied', null])
  expect(context.prompts.some(prompt => moduleOf(prompt) === 'b')).toBe(false)
  expect(events).not.toContain('module/b: started')
  expect(await readFile(join(context.cwd, 'a.ts'), 'utf8')).toBe('export const value = 2\n')
  expect(JSON.parse(await readFile(join(report.directory, 'report.json'), 'utf8'))).toEqual(report)
  expect(await stat(join(context.cwd, '.anureo/refactor/writer.lock')).catch(() => null)).toBeNull()
})

/** Discover real package scripts and confirm typecheck failure prevents the test script from running. */
test('default validation discovers root package scripts and stops on a failing typecheck', async () => {
  const context = await fixture(async prompt => {
    if (prompt.startsWith('PLAN')) return plan
    if (moduleOf(prompt) === 'a') await writeFile(join(context.cwd, 'a.ts'), 'const named = 1; export { named as value }\n')
    return moduleOf(prompt) === 'a' ? edited() : unchanged
  })
  await writeFile(join(context.cwd, 'package.json'), JSON.stringify({ packageManager: 'bun@1.4.2', scripts: { typecheck: 'exit 9', test: 'exit 0' } }))
  const report = await refactorCode(context)
  expect(report.status).toBe('incomplete')
  expect(report.modules[0]?.step?.checks).toMatchObject([{ command: 'bun run typecheck', status: 'failed' }])
})

/** Move/add files during design so the host diff and post-design inventory use observed paths. */
test('moves and new files need no declaration and are reported from the real diff', async () => {
  const context = await fixture(async prompt => {
    if (prompt.startsWith('PLAN')) return { ...plan, modules: [{ ...plan.modules[0], files: ['moved.ts', 'types.ts'] }, plan.modules[1]] }
    if (prompt.startsWith(DESIGN)) {
      await rename(join(context.cwd, 'a.ts'), join(context.cwd, 'moved.ts'))
      await writeFile(join(context.cwd, 'types.ts'), 'export type T = 1\n')
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
  const context = await fixture(async prompt => {
    if (prompt.startsWith(DESIGN)) { await writeFile(join(context.cwd, 'extra.ts'), 'export const extra = 1\n'); return edited() }
    if (prompt.startsWith('PLAN')) return { ...plan, modules: [{ ...plan.modules[0], files: ['a.ts', 'extra.ts'] }, plan.modules[1]] }
    return unchanged
  })
  const report = await refactorCode({ ...context, checks: [] })
  expect(report.status).toBe('completed')
  expect(context.prompts.find(prompt => prompt.startsWith('PLAN'))).toContain('"extra.ts"')
})

/** Use an external fixture path to ensure source safety rejects links before graph or agent work. */
test('a symlinked source file is rejected before any agent runs', async () => {
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
  const context = await fixture()
  await mkdir(join(context.cwd, 'pkg'))
  await Promise.all(['a.ts', 'b.ts'].map(file => writeFile(join(context.cwd, 'pkg', file), 'export const value = 1\n')))
  const cwd = join(context.cwd, 'pkg')
  const report = await refactorCode({ ...context, cwd, checks: [], graphLoader: async () => graph(cwd) })
  expect(report.status).toBe('completed')
  expect(JSON.parse(context.prompts.find(prompt => prompt.startsWith('PLAN'))!.split('Inventory: ')[1]!.split('\n')[0]!)).toEqual(['a.ts', 'b.ts'])
})
