// Verifies snapshot and source-safety boundaries; it must not duplicate orchestration or filesystem mocks.
import { expect, test } from 'bun:test'
import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureTree, changes, gitFiles, treeVersion } from '../src/git-tree'
import { exec } from '../src/process'
import { isSource, validateSourcePath } from '../src/source-policy'
import { fixture, temporary } from './helpers'

/** Exercise Git visibility separately from snapshot exclusions, including force-added run storage. */
test('snapshots sort visible files, omit deleted entries and metadata, and retain non-source files', async () => {
  const { cwd } = await fixture()
  await writeFile(join(cwd, '.gitignore'), '.anureo/\nignored.ts\n')
  await writeFile(join(cwd, 'ignored.ts'), 'ignored')
  await writeFile(join(cwd, 'notes.txt'), 'untracked non-source content')
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

/** Compare real file/link edits so content, mode and link text remain independently observable. */
test('snapshot changes track content and modes, and hash symlink text without reading its destination', async () => {
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

/** Exercise lexical rules and real ancestors, including missing paths accepted for future files. */
test('source validation rejects unsafe syntax, symlink ancestors and non-file targets without creating files', async () => {
  const { cwd } = await fixture()
  const outside = await temporary()
  expect(isSource('src/main.ts')).toBe(true)
  for (const file of ['docs/main.ts', 'node_modules/main.ts', 'types.d.ts', 'notes.txt']) {
    expect(isSource(file)).toBe(false)
  }
  for (const file of ['/absolute.ts', '../escape.ts', './a.ts', 'src//a.ts', 'src/../a.ts', 'src\\a.ts', 'docs/main.ts']) {
    await expect(validateSourcePath(cwd, file)).rejects.toThrow(`Invalid source path: ${file}`)
  }
  await expect(validateSourcePath(cwd, 'a.ts')).resolves.toBeUndefined()
  await expect(validateSourcePath(cwd, 'missing/new.ts')).resolves.toBeUndefined()
  expect(await lstat(join(cwd, 'missing')).catch(() => null)).toBeNull()

  await symlink(outside, join(cwd, 'linked'))
  await expect(validateSourcePath(cwd, 'linked/new.ts')).rejects.toThrow('Symlink source paths are unsupported: linked/new.ts')
  await symlink(join(outside, 'missing.ts'), join(cwd, 'broken.ts'))
  await expect(validateSourcePath(cwd, 'broken.ts')).rejects.toThrow('Symlink source paths are unsupported: broken.ts')
  await mkdir(join(cwd, 'directory.ts'))
  await expect(validateSourcePath(cwd, 'directory.ts')).rejects.toThrow('Source is not a regular file: directory.ts')
})

/** Ensure a replaced ancestor is an actual failure rather than an apparently missing tracked file. */
test('snapshot and source validation propagate non-ENOENT filesystem failures', async () => {
  const { cwd } = await fixture()
  await mkdir(join(cwd, 'parent'))
  await writeFile(join(cwd, 'parent', 'child.ts'), 'tracked content')
  await exec('git', ['-C', cwd, 'add', 'parent/child.ts'])
  await rm(join(cwd, 'parent'), { recursive: true })
  await writeFile(join(cwd, 'parent'), 'replaced ancestor')

  await expect(validateSourcePath(cwd, 'parent/child.ts')).rejects.toMatchObject({ code: 'ENOTDIR' })
  await expect(captureTree(cwd)).rejects.toMatchObject({ code: 'ENOTDIR' })
})
