import { randomUUID } from 'node:crypto'
import type { Client, SessionEventSink } from '@anureo/sdk'
import type { AhpEvent, Boundary, SessionOpenParams, SubagentItem } from '@anureo/protocol'
import { executionError, type SwarmExecution } from './execution'
import type { ProfileReviews } from './profile-review'
import type { MemberTask } from './router'

export function runTeam(
  execution: SwarmExecution,
  params: SessionOpenParams,
  sink: SessionEventSink,
  turnId: string,
  input: string,
  tasks: readonly MemberTask[],
  backendFor: (role: string) => Client,
  reviews?: ProfileReviews,
) {
  return Promise.allSettled(tasks.map(async assignment => {
    const { task } = assignment
    const profile = assignment.kind === 'fixed' ? assignment.profile : undefined
    const role = assignment.kind === 'fixed' ? assignment.profile.id : assignment.role
    const name = assignment.kind === 'fixed' ? assignment.profile.name : assignment.name
    const id = randomUUID()
    const item: SubagentItem = {
      id, type: 'subagent', subagentId: id, state: 'running', name, task,
      extensions: { swarm: { kind: assignment.kind, ...(profile ? { profileId: profile.id } : {}) } },
    }
    const scope = { turnId }
    await sink.emit({ type: 'item/started', payload: { item } }, scope)
    const { cwd, permissionMode } = params
    const instructions = 'Perform only the assigned read-only task. Do not edit files or change external state. Report findings and their evidence.'
    const member = { role, name, task, ...(profile ? { profileId: profile.id } : {}) }
    const backend = backendFor(role)
    const memberParams = {
      cwd,
      permissionMode,
      model: profile?.model,
      instructions: profile ? `${instructions}\n\nProfile instructions:\n${profile.instructions}` : instructions,
    }
    let boundary: Boundary | undefined
    const observeStart = profile && reviews ? async (event: AhpEvent) => {
      if (event.type !== 'turn/started') return
      const { turnId, nativeTurnId } = event.payload
      boundary = { turnId, nativeTurnId, relation: 'through' }
    } : undefined
    const report = await execution.fresh(backend, memberParams, (session, promptInstructions) => {
      const payload = JSON.stringify({ request: input, assignment: task })
      return execution.submit(session, { input: promptInstructions ? `${promptInstructions}\n\n${payload}` : payload }, observeStart)
    }, {
      allowPromptInstructions: true,
      handoff: (session, promptInstructions) => {
        if (execution.stopped || !profile || !reviews || !boundary) return false
        reviews.start(backend, session, {
          ...memberParams,
          model: session.snapshot.model ?? memberParams.model,
          instructions: promptInstructions ? undefined : memberParams.instructions,
        }, profile, boundary)
        return true
      },
    }).then(
      result => result.status === 'completed'
        ? { ...member, status: result.status, text: result.text.slice(0, 12_000) }
        : { ...member, status: result.status, error: result.error },
      cause => ({ ...member, status: execution.stopped ? 'interrupted' as const : 'failed' as const, error: executionError(cause) }),
    )
    await sink.emit({ type: 'item/completed', payload: { item: { ...item, state: report.status } } }, scope)
    return report
  }))
}
