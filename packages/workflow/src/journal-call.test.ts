import { describe, expect, test } from 'bun:test'
import { journaledCall } from './journal-call'
import { workflow } from './workflow'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessSdkError } from '@anureo/sdk'

describe('journaledCall', () => {
  test('executes unbundled outside workflow() and journals inside it', async () => {
    const unbundled = await journaledCall({ prompt: 'p', canonical: { a: 1 } }, async agentId => {
      expect(typeof agentId).toBe('string')
      return 'outside'
    })
    expect(unbundled).toBe('outside')

    let calls = 0
    const outcome = await workflow({ name: 'wf', revision: '1', input: { n: 1 } }, async () => {
      calls++
      const first = await journaledCall({ prompt: 'p1', canonical: { a: 1 } }, async () => 'one')
      const second = await journaledCall({ prompt: 'p2', canonical: { a: 2 } }, async () => 'two')
      return [first, second]
    })
    expect(calls).toBe(1)
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toEqual(['one', 'two'])
  })

  test('memorizes by prompt and canonical options inside one journal chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    const executions: string[] = []
    const body = async () => {
      const a = await journaledCall({ prompt: 'same', canonical: { model: 'm1' } }, async () => { executions.push('m1'); return 'r1' })
      const b = await journaledCall({ prompt: 'same', canonical: { model: 'm2' } }, async () => { executions.push('m2'); return 'r2' })
      return [a, b]
    }
    const first = await workflow({ name: 'wf', revision: '1', directory, input: null }, body)
    expect(first.result).toEqual(['r1', 'r2'])
    expect(executions).toEqual(['m1', 'm2'])
    // A fresh run in a new directory re-executes; the same directory resumed by
    // runId replays both results without executing.
    const second = await workflow({ name: 'wf', revision: '1', directory, input: null, runId: 'again' }, body)
    expect(second.result).toEqual(['r1', 'r2'])
    expect(executions).toEqual(['m1', 'm2', 'm1', 'm2'])
  })

  test('journals dropped null outcomes and thrown failures with their codes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wf-journal-'))
    const outcome = await workflow({ name: 'wf', revision: '1', directory, input: null }, async () => {
      const dropped = await journaledCall({ prompt: 'drop', canonical: {}, droppedCode: 'STEP_DROPPED' }, async () => null)
      const failed = await journaledCall<string>({ prompt: 'fail', canonical: {}, failureCode: 'STEP_FAILED' }, async () => {
        throw new HarnessSdkError('STEP_BOOM')
      }).catch(cause => (cause as HarnessSdkError).code)
      return { dropped, failed }
    })
    expect(outcome.status).toBe('incomplete')
    expect(outcome.result).toEqual({ dropped: null, failed: 'STEP_BOOM' })
  })
})

describe('memory-only workflow runs', () => {
  test('complete without a directory and cannot be resumed', async () => {
    const outcome = await workflow({ name: 'wf', revision: '1', input: { a: 1 } }, async run => run.input)
    expect(outcome).toMatchObject({ status: 'completed', result: { a: 1 } })
    const resume = workflow({ name: 'wf', revision: '1', input: null, resumeFrom: { directory: '', runId: outcome.runId } }, () => 'x')
    await expect(resume).rejects.toThrow('WORKFLOW_RESUME_NOT_FOUND')
  })
})
