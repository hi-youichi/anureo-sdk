import { mock } from 'bun:test'
import * as sdk from '@anureo/sdk'

const scenario = process.env.FAILURE_CASE
let disposals = 0
mock.module('@anureo/sdk', () => ({ ...sdk, createClient: async () => ({
  dispose: async () => {
    disposals++
    if (scenario === 'both' || scenario === 'cleanup') throw new Error('cleanup failure B')
  },
}) as unknown as sdk.Client }))
const { withClient } = await import('../../src/cli-shared')
mock.module('../../src/cli', () => ({ main: () => withClient(process.cwd(), 1024, false, async () => {
  if (scenario === 'both' || scenario === 'operation') throw new Error('operation failure A')
  if (scenario === 'signal') process.emit('SIGINT')
}) }))
// Use the production withClient and the actual binary's error/exit handling.
await import('../../bin/anureo-review')
console.log(JSON.stringify({ disposals }))
