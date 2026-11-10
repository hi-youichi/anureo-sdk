import { expect, test } from 'bun:test'
import { createClient } from '@anureo/sdk'
import { createScriptedAdapter, FAKE_CAPABILITIES } from '@anureo/conformance'
import type { HarnessError, InputSubmitParams } from '@anureo/protocol'
import { analysisSchema, parseAnalysis, structuredOutputSchema } from '../src/schemas'
import { createSdkReadabilityAgent, type AnalysisTask } from '../src'

const task: AnalysisTask = { id: 'test', packagePath: '.', focus: 'test', ownedFiles: [] }
const answer = { reviewedFiles: [], unreviewedFiles: [], observations: [] }

function setup(options: { structured?: boolean; output?: string; hang?: boolean; timeoutMs?: number; cleanupFails?: boolean; error?: HarnessError } = {}) {
  const capabilities = structuredClone(FAKE_CAPABILITIES)
  capabilities.turn!.outputSchema = options.structured ?? true
  const adapter = createScriptedAdapter({ capabilities, execute: async (call, sink) => {
    if (call.method !== 'input/submit') return undefined
    const input = call.params as InputSubmitParams
    await sink.emit({ type: 'turn/started', payload: { turnId: 'execution' } })
    if (!options.hang) {
      await sink.emit({ type: 'item/completed', payload: { item: {
        type: 'agentMessage', id: 'answer', phase: 'final', text: options.output ?? JSON.stringify(answer),
      } } }, { turnId: 'execution' })
      await sink.emit({ type: 'turn/completed', payload: { turnId: 'execution', status: options.error ? 'failed' : 'completed',
        ...(options.error ? { error: options.error } : {}) } })
    }
    return { accepted: true, disposition: 'started', submissionId: input.submissionId, turnId: 'execution' }
  } })
  if (options.cleanupFails) adapter.dispose = async () => { throw new Error('cleanup failed') }
  const agent = createSdkReadabilityAgent({ timeoutMs: options.timeoutMs,
    createClient: () => createClient({ adapter, identity: { adapterId: 'scripted', runtimeConfigId: 'readability-test' } }) })
  return { adapter, agent }
}

test.each([true, false])('uses the real SDK and negotiates structured output: %s', async structured => {
  const { agent, adapter } = setup({ structured })
  expect(await agent.analyze(task, { root: process.cwd() })).toEqual(answer)
  const submission = adapter.calls.find(call => call.method === 'input/submit')!.params as InputSubmitParams
  expect(submission.outputSchema !== undefined).toBe(structured)
  expect(adapter.opened).toHaveLength(1)
  expect(adapter.disposeCount).toBe(1)
  expect([...adapter.backends.values()][0]?.disposeCount).toBe(1)
})

test('rejects invalid JSON without retrying the task and releases resources', async () => {
  const { agent, adapter } = setup({ output: '```json\n{}\n```' })
  await expect(agent.analyze(task, { root: process.cwd() })).rejects.toThrow()
  expect(adapter.calls.filter(call => call.method === 'input/submit')).toHaveLength(1)
  expect(adapter.disposeCount).toBe(1)
})

test('valid JSON still needs runtime schema validation', async () => {
  const { agent, adapter } = setup({ output: '{}' })
  await expect(agent.analyze(task, { root: process.cwd() })).rejects.toThrow('Invalid agent output')
  expect(adapter.disposeCount).toBe(1)
})

test('a deadline attempts native interruption before disposing the owned client', async () => {
  const { agent, adapter } = setup({ hang: true, timeoutMs: 100 })
  await expect(agent.analyze(task, { root: process.cwd() })).rejects.toThrow()
  expect(adapter.calls.some(call => call.method === 'session/interrupt')).toBe(true)
  expect(adapter.disposeCount).toBe(1)
})

test('cleanup failures are surfaced instead of publishing a successful result', async () => {
  const { agent } = setup({ cleanupFails: true })
  await expect(agent.analyze(task, { root: process.cwd() })).rejects.toThrow()
})

test('structured output omits unsupported uniqueness while host validation still rejects duplicates', () => {
  const native = structuredOutputSchema(analysisSchema)
  expect(JSON.stringify(native)).not.toContain('uniqueItems')
  expect(JSON.stringify(analysisSchema)).toContain('uniqueItems')
  expect(() => parseAnalysis({ ...answer, reviewedFiles: ['a.ts', 'a.ts'] })).toThrow('Invalid agent output')
})

test('preserves the SDK terminal failure code and message', async () => {
  const { agent } = setup({ error: { code: 'NATIVE_REQUEST_INVALID', message: 'Codex rejected the request',
    retryable: false, outcomeUnknown: false } })
  const error = await agent.analyze(task, { root: process.cwd() }).catch(cause => cause)
  expect(error.code).toBe('NATIVE_REQUEST_INVALID')
  expect(error.message).toBe('Codex rejected the request')
})
