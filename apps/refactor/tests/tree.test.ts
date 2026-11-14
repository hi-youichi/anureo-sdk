// Verifies Git snapshots and source eligibility against real filesystem entries.
import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runChecks, validateChecks } from '../src/checks'
import { captureTree, changes, treeVersion } from '../src/git-tree'
import { git, gitFiles } from '../src/git'
import { exec } from '../src/process'
import { isSource, isTextSource } from '../src/source-policy'
import { createAgentWorktree, mergeWorktree, prepareCheckDependencies, removeAgentWorktree, withWorktreeBaseline } from '../src/worktree'
import { fixture, temporary } from './helpers'

/** Exercise Git visibility separately from snapshot exclusions, including force-added run storage. */
test('snapshots sort visible files, omit deleted entries and metadata, and retain non-source files', async () => {
  const { cwd } = await fixture()
  await writeFile(join(cwd, '.gitignore'), '.anureo/\nignored.ts\n')
  await writeFile(join(cwd, 'ignored.ts'), 'ignored')
  await writeFile(join(cwd, 'notes.txt'), 'untracked text')
  await mkdir(join(cwd, '.anureo'))
  await writeFile(join(cwd, '.anureo', 'report.ts'), 'run output')
  await exec('git', ['-C', cwd, 'add', '--force', '.anureo/report.ts'])
  await rm(join(cwd, 'b.ts'))

  expect(await gitFiles(cwd)).toEqual(['.anureo/report.ts', '.gitignore', 'a.ts', 'b.ts', 'notes.txt'])
  const tree = await captureTree(cwd)
  expect([...tree.keys()]).toEqual(['.gitignore', 'a.ts', 'notes.txt'])
  const version = treeVersion(tree)
  await writeFile(join(cwd, '.anureo', 'report.ts'), 'changed run output')
  expect(treeVersion(await captureTree(cwd))).toBe(version)
})

test('Git file discovery preserves an initial BOM and rejects invalid filename bytes', async () => {
  const { cwd } = await fixture()
  await writeFile(join(cwd, '\uFEFFfile.ts'), 'text')
  expect(await gitFiles(cwd)).toContain('\uFEFFfile.ts')

  const blob = (await git(cwd, 'rev-parse', ':a.ts')).trim()
  const stdin = Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0xff, 0])])
  const child = Bun.spawn(['git', '-C', cwd, 'update-index', '-z', '--index-info'], { stdin })
  expect(await child.exited).toBe(0)
  await expect(gitFiles(cwd)).rejects.toThrow('filename that is not valid UTF-8')
})

test('detached worktrees restore the frozen split index and discover its paths', async () => {
  const { cwd } = await fixture()
  await git(cwd, 'update-index', '--split-index')
  const before = await captureTree(cwd)
  await withWorktreeBaseline(cwd, async baseline => {
    const worktree = await createAgentWorktree(baseline)
    try {
      expect(await captureTree(worktree.root)).toEqual(before)
    } finally {
      await removeAgentWorktree(baseline, worktree)
    }
  })
})

test('validation copies ignored in-repository dependency targets and rebases workspace links', async () => {
  const { cwd } = await fixture()
  const installed = join(cwd, '.deps', 'node_modules')
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'installed.txt'), 'dependency content')
  await symlink(cwd, join(installed, 'workspace'), 'junction')
  await symlink(installed, join(cwd, 'node_modules'), 'junction')
  await writeFile(join(cwd, '.gitignore'), '.anureo/\n.deps/\n')
  await withWorktreeBaseline(cwd, async baseline => {
    const worktree = await createAgentWorktree(baseline)
    try {
      await writeFile(join(worktree.cwd, 'a.ts'), 'candidate content')
      await prepareCheckDependencies(baseline, worktree)
      expect(await readFile(join(worktree.cwd, 'node_modules', 'installed.txt'), 'utf8')).toBe('dependency content')
      expect(await readFile(join(worktree.cwd, 'node_modules', 'workspace', 'a.ts'), 'utf8')).toBe('candidate content')
    } finally {
      await removeAgentWorktree(baseline, worktree)
    }
  })
})

test('shell and argv validation commands use their checkout despite inherited Git selectors', async () => {
  const { cwd } = await fixture()
  await withWorktreeBaseline(cwd, async baseline => {
    const worktree = await createAgentWorktree(baseline)
    const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
    try {
      await writeFile(join(worktree.cwd, 'a.ts'), 'candidate content')
      process.env.GIT_DIR = join(cwd, '.git')
      process.env.GIT_WORK_TREE = cwd
      for (const command of ['git diff --exit-code -- a.ts', { executable: 'git', args: ['diff', '--exit-code', '--', 'a.ts'] }]) {
        const results: Parameters<typeof runChecks>[2] = []
        await expect(runChecks(worktree.cwd, [command], results)).rejects.toThrow('Validation failed')
        expect(results).toMatchObject([{ status: 'failed', output: expect.stringContaining('+candidate content') }])
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await removeAgentWorktree(baseline, worktree)
    }
  })
})

test('validation preflight reports every invalid command and argument position', () => {
  expect(() => validateChecks([' ', { executable: 'git\0', args: ['diff', 'a\0', 'b\0'] }])).toThrow(
    'check commands must be nonempty\ncheck #1 is blank\ncheck #2 contains NUL\ncheck #2 argument #2 contains NUL\ncheck #2 argument #3 contains NUL',
  )
})

test('merge rolls back a late target edit from its target-relative recovery path', async () => {
  const { cwd } = await fixture()
  const file = 'nested/edit.ts'
  const target = join(cwd, file)
  await mkdir(join(cwd, 'nested'))
  await mkdir(join(cwd, '.anureo', 'refactor'), { recursive: true })
  await writeFile(target, 'baseline content')
  await withWorktreeBaseline(cwd, async baseline => {
    const worktree = await createAgentWorktree(baseline)
    const mergeTarget = resolve(baseline.root, baseline.scope, file)
    const rename = fs.rename
    const moves: string[] = []
    const mock = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (from === mergeTarget) {
        moves.push(String(to))
        await writeFile(from, 'late editor save')
      }
      await rename(from, to)
    })
    try {
      await writeFile(join(worktree.cwd, file), 'candidate content')
      await expect(mergeWorktree(baseline, worktree, [file])).rejects.toThrow(`Source changed during refactor: ${file}`)
      expect(moves).toEqual([expect.stringContaining(join('backups', file))])
      expect(await readFile(target, 'utf8')).toBe('late editor save')
    } finally {
      mock.mockRestore()
      await removeAgentWorktree(baseline, worktree)
    }
  })
})

/** Compare real file/link edits so content, mode and link text remain independently observable. */
test.skipIf(process.platform === 'win32')('snapshot changes track content and modes, and hash symlink text without reading its destination', async () => {
  const { cwd } = await fixture()
  const outside = await temporary()
  const destination = join(outside, 'destination.ts')
  await writeFile(destination, 'external content')
  await symlink(destination, join(cwd, 'linked.ts'))
  const before = await captureTree(cwd)

  await writeFile(destination, 'changed external content')
  expect(changes(before, await captureTree(cwd))).toEqual([])
  await writeFile(join(cwd, 'a.ts'), 'changed content')
  const mode = (await lstat(join(cwd, 'b.ts'))).mode
  await chmod(join(cwd, 'b.ts'), mode ^ 0o100)
  await rm(join(cwd, 'linked.ts'))
  await symlink(join(outside, 'missing.ts'), join(cwd, 'linked.ts'))
  await writeFile(join(cwd, 'new.ts'), 'new content')

  const after = await captureTree(cwd)
  expect(changes(before, after)).toEqual(['a.ts', 'b.ts', 'linked.ts', 'new.ts'])
  expect(treeVersion(after)).not.toBe(treeVersion(before))
  expect(treeVersion(new Map([...after].reverse()))).not.toBe(treeVersion(after))
  await rm(join(cwd, 'a.ts'))
  expect(changes(after, await captureTree(cwd))).toEqual(['a.ts'])
})

/** Exercise scope precedence, path inspection and text detection independently. */
test('source inventory accepts unfamiliar names and rejects unsafe paths, binary and non-file targets', async () => {
  const { cwd } = await fixture()
  const outside = await temporary()
  expect(isSource('src/main.ts')).toBe(true)
  expect(isSource('types.d.mts')).toBe(true)
  expect(isSource('bin/outil')).toBe(true)
  for (const file of ['docs/main.ts', 'node_modules/main.ts', 'README.md']) {
    expect(isSource(file)).toBe(false)
  }
  expect(isSource('README.md', ['README.md'])).toBe(true)
  expect(isSource('README.md', ['README.md'], ['*.md'])).toBe(false)
  expect(isSource('docs/main.ts', ['docs/main.ts'])).toBe(false)
  for (const file of ['/absolute.ts', '../escape.ts', './a.ts', 'src//a.ts', 'src/../a.ts', 'src\\a.ts', 'docs/main.ts']) {
    await expect(isTextSource(cwd, file)).rejects.toThrow(`Invalid source path: ${file}`)
  }
  await expect(isTextSource(cwd, 'a.ts')).resolves.toBe(true)
  await expect(isTextSource(cwd, 'missing/new.ts')).resolves.toBe(false)
  expect(await lstat(join(cwd, 'missing')).catch(() => null)).toBeNull()

  await symlink(outside, join(cwd, 'linked'), 'junction')
  await expect(isTextSource(cwd, 'linked/new.ts')).rejects.toThrow('Symlink source paths are unsupported: linked/new.ts')
  await mkdir(join(cwd, 'directory.ts'))
  await expect(isTextSource(cwd, 'directory.ts')).resolves.toBe(false)
  await writeFile(join(cwd, 'archive.dsl'), Buffer.from([0xff, 0, 0x80]))
  await expect(isTextSource(cwd, 'archive.dsl')).resolves.toBe(false)
  await writeFile(join(cwd, '构建'), Buffer.from('\uFEFFrun job\r\n', 'utf16le'))
  await expect(isTextSource(cwd, '构建')).resolves.toBe(true)
  await writeFile(join(cwd, '构建'), Buffer.from([0xfe, 0xff, 0x00, 0x61]))
  await expect(isTextSource(cwd, '构建')).resolves.toBe(true)
})

/** Ensure a replaced ancestor is an actual failure rather than an apparently missing tracked file. */
test.skipIf(process.platform === 'win32')('snapshot and source validation propagate non-ENOENT filesystem failures', async () => {
  const { cwd } = await fixture()
  await mkdir(join(cwd, 'parent'))
  await writeFile(join(cwd, 'parent', 'child.ts'), 'tracked content')
  await exec('git', ['-C', cwd, 'add', 'parent/child.ts'])
  await rm(join(cwd, 'parent'), { recursive: true })
  await writeFile(join(cwd, 'parent'), 'replaced ancestor')

  await expect(isTextSource(cwd, 'parent/child.ts')).rejects.toMatchObject({ code: 'ENOTDIR' })
  await expect(captureTree(cwd)).rejects.toMatchObject({ code: 'ENOTDIR' })
})
