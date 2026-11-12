import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const [directory, phase] = process.argv.slice(2) as [string, string]
const originalRename = fs.rename
mock.module('node:fs/promises', () => ({ ...fs, rename: async (from: string, to: string) => {
  const target = to.replaceAll('\\', '/')
  if (phase === 'before-started' && target.includes('/attempts/')) process.kill(process.pid, 'SIGKILL')
  if (phase === 'before-marker' && target.includes('/checkpoints/')) process.kill(process.pid, 'SIGKILL')
  if (phase === 'before-final' && target.endsWith('/run.json')) {
    const value = JSON.parse(await fs.readFile(from, 'utf8'))
    if (value.status === 'completed') process.kill(process.pid, 'SIGKILL')
  }
  await originalRename(from, to)
  if (phase === 'after-marker' && target.includes('/checkpoints/')) process.kill(process.pid, 'SIGKILL')
} }))
const { workflow } = await import('../workflow')
await workflow({ directory, name: 'crash-test', revision: '1', input: {}, runId: 'crashed' }, run =>
  run.step({ key: 'work', input: {}, schema: z.strictObject({ value: z.number() }), recovery: 'repeatable' }, async () => {
    await fs.appendFile(join(directory, 'calls'), 'call\n')
    if (phase === 'after-execute') process.kill(process.pid, 'SIGKILL')
    return { value: 7 }
  }))
