import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withOutputClaim } from '../src/cli-shared'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'anureo-output-claim-'))
  directories.push(root)
  return join(root, 'run')
}

test('an editing output claim excludes a second writer through final report publication', async () => {
  const output = await directory()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const first = withOutputClaim(output, async () => {
    entered()
    await waiting
    await writeFile(join(output, 'report.json'), '{"complete":true}')
  })
  await started
  await expect(withOutputClaim(output, async () => { throw new Error('must not enter') })).rejects.toMatchObject({ code: 'EEXIST' })
  release()
  await first
  expect(await readdir(output)).toEqual(['report.json'])
  await expect(withOutputClaim(output, async () => {})).rejects.toThrow('must be empty')
  expect(await readFile(join(output, 'report.json'), 'utf8')).toBe('{"complete":true}')
})

test('failed work releases its own claim, and replaced claims are never deleted', async () => {
  const output = await directory()
  await expect(withOutputClaim(output, async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
  expect(await readdir(output)).toEqual([])
  await expect(withOutputClaim(output, async () => {
    await unlink(join(output, 'writer.lock'))
    await writeFile(join(output, 'writer.lock'), 'another owner')
  })).rejects.toThrow('ownership changed')
  expect(await readFile(join(output, 'writer.lock'), 'utf8')).toBe('another owner')
})


test('an operation failure and claim cleanup failure both remain observable', async () => {
  const output = await directory()
  const failure = await withOutputClaim(output, async () => {
    await unlink(join(output, 'writer.lock'))
    await writeFile(join(output, 'writer.lock'), 'another owner')
    throw new Error('original operation failed')
  }).then(() => null, error => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors.map((error: Error) => error.message)).toEqual(['original operation failed', 'Output ownership changed'])
  expect(await readFile(join(output, 'writer.lock'), 'utf8')).toBe('another owner')
})
