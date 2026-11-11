import { mock } from 'bun:test'
import * as sdk from '@anureo/sdk'
import { createScriptedAdapter } from '@anureo/conformance'
import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'

const realCreateClient = sdk.createClient
mock.module('@anureo/sdk', () => ({ ...sdk, createClient: async () => {
  const client = await realCreateClient({ adapter: createScriptedAdapter({ execute: async (call, sink) => {
    if (call.method !== 'input/submit' || !('submissionId' in call.params)) return undefined
    const turnId = randomUUID()
    await sink.emit({ type: 'turn/started', payload: { turnId } })
    await sink.emit({ type: 'item/completed', payload: { item: { id: randomUUID(), type: 'agentMessage', phase: 'final',
      text: JSON.stringify({ status: 'already_satisfied', summary: '当前建议已满足。', checks: ['fixture static check'] }),
    } } }, { turnId })
    await sink.emit({ type: 'turn/completed', payload: { turnId, status: 'completed' } })
    return { submissionId: call.params.submissionId, accepted: true, disposition: 'started', turnId }
  } }), identity: { adapterId: 'scripted', runtimeConfigId: 'fix-cleanup-fixture' } })
  let disposals = 0
  return new Proxy(client, { get(target, key) {
    if (key === 'dispose') return async () => {
      disposals++
      const reportExisted = await access(process.env.FIX_REPORT!).then(() => true, () => false)
      await target.dispose()
      await writeFile(process.env.FIX_DISPOSALS!, JSON.stringify({ disposals, reportExisted }))
      if (process.env.FIX_PUBLISH_BLOCK) await mkdir(process.env.FIX_PUBLISH_BLOCK)
      if (process.env.FIX_CLEANUP_FAIL !== '0') throw new sdk.HarnessSdkError('RESOURCE_RELEASE_FAILED', 'fixture client cleanup failure')
    }
    return Reflect.get(target, key)
  } })
} }))
// Production entry, withClient, fix scheduler, output claim and report publication.
await import('../../bin/anureo-review')
