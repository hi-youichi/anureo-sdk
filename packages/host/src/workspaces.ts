import { HostError } from './errors'

/** Product workspace allocation. Requests deliberately contain no paths or commands. */
export type WorkspaceRequest = { kind: 'project' } | { kind: 'worktree'; name?: string; baseRef?: string; worktreeId?: string }
export type WorkspacePrincipal = { userId: string; mode: 'on' | 'off'; isAdmin?: boolean; service?: boolean }
export type WorkspaceContext = { principal: WorkspacePrincipal; projectId: string; sessionId: string }
/** cwd is an internal server value. Only the remaining fields are public metadata. */
export type WorkspaceBinding = { kind: 'project' | 'worktree'; cwd: string; worktreeId?: string; name?: string; branch?: string }
export type WorkspaceAllocation = { binding: WorkspaceBinding; created: boolean; rollback(): Promise<void> }
/** Constructed by Host after inspecting or disposing its independently owned runtime. */
export type WorkspaceStopEvidence = { stopped: true; source: 'native-inspect' | 'owned-runtime-disposed'; bindingGeneration: number }
export type WorkspaceIntegration = { result: 'merged' | 'noop' | 'conflict' | 'patch'; conflictFiles?: string[]; patchPath?: string }
export interface WorkspacePort {
  allocate(context: WorkspaceContext & { request?: WorkspaceRequest }): Promise<WorkspaceAllocation>
  get(context: WorkspaceContext): Promise<WorkspaceBinding>
  integrate(context: WorkspaceContext & { worktreeId: string; mode: 'merge' | 'patch'; message?: string; force?: boolean; evidence: WorkspaceStopEvidence }): Promise<WorkspaceIntegration>
  discard(context: WorkspaceContext & { worktreeId: string; force?: boolean; evidence: WorkspaceStopEvidence }): Promise<WorkspaceBinding>
}

export type WorkspaceExecutionState = {
  status: string; activeTurnId?: string; pendingInteractions?: boolean; pendingQueue?: boolean
  unknownOperation?: boolean; activeGoal?: boolean; managed?: boolean; executedTurns?: boolean
}
/** Call under the Host's session mutation lock, before reserving destructive work. */
export function assertWorkspaceMutable(state: WorkspaceExecutionState): void {
  if (state.managed) throw new HostError('MANAGED_SESSION_IMMUTABLE')
  if (state.status === 'recoveryRequired' || state.unknownOperation) throw new HostError('RECOVERY_REQUIRED')
  if (['running', 'opening'].includes(state.status) || state.activeTurnId || state.pendingInteractions || state.pendingQueue || state.activeGoal) throw new HostError('SESSION_BUSY')
  // 产品规则（2026-11）：Harness 仅可在会话开始前选择；已执行过 turn 的会话锁定。
  // 放在忙碌判定之后：运行中/排队等瞬时状态优先报 SESSION_BUSY，空闲的已开始会话才报 HARNESS_LOCKED。
  if (state.executedTurns) throw new HostError('HARNESS_LOCKED', 'Harness selection is locked once a session has executed turns')
}

export function assertWorkspaceStopEvidence(evidence: WorkspaceStopEvidence | undefined): void {
  if (!evidence || evidence.stopped !== true || !['native-inspect', 'owned-runtime-disposed'].includes(evidence.source) || !Number.isSafeInteger(evidence.bindingGeneration) || evidence.bindingGeneration < 0) throw new HostError('RESULT_UNKNOWN', 'Native execution stop has not been verified', false, true)
}
