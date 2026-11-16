import { randomUUID } from 'node:crypto'
import type { Client, SessionEventSink } from '@anureo/sdk'
import type { SessionOpenParams, SubagentItem } from '@anureo/protocol'
import { executionError, type SwarmExecution } from './execution'
import type { MemberTask } from './router'

export function runTeam(
  execution: SwarmExecution,
  params: SessionOpenParams,
  sink: SessionEventSink,
  turnId: string,
  input: string,
  tasks: readonly MemberTask[],
  backendFor: (role: string) => Client,
) {
  return Promise.allSettled(tasks.map(async ({ role, task }) => {
    const id = randomUUID()
    const item: SubagentItem = { id, type: 'subagent', subagentId: id, state: 'running', name: role, task }
    const scope = { turnId }
    await sink.emit({ type: 'item/started', payload: { item } }, scope)
    const { cwd, permissionMode } = params
    const report = await execution.fresh(backendFor(role), {
      cwd,
      permissionMode,
      instructions: 'Perform only the assigned read-only task. Do not edit files or change external state. Report findings and their evidence.',
    }, session => execution.submit(session, {
      input: JSON.stringify({ request: input, assignment: task }),
    })).then(
      result => result.status === 'completed'
        ? { role, task, status: result.status, text: result.text.slice(0, 12_000) }
        : { role, task, status: result.status, error: result.error },
      cause => ({ role, task, status: execution.stopped ? 'interrupted' as const : 'failed' as const, error: executionError(cause) }),
    )
    await sink.emit({ type: 'item/completed', payload: { item: { ...item, state: report.status } } }, scope)
    return report
  }))
}
