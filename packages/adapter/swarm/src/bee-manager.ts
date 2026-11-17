import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError, type Session, type SessionEventSink, type Turn, type TurnResult } from '@anureo/sdk'
import type { Boundary, HarnessError, JsonSchema, SessionOpenParams, SubagentItem } from '@anureo/protocol'
import { executionError, instructionsUnsupported, releaseSession, SwarmExecution } from './execution'
import { executionSelection, selectTemporaryModel, selectEffort, effortConfig, parseSelectionReason, type MemberBackend, type BeeExecutionSelection } from './models'
import type { BeeProfile, BeeProfileRegistry, BeeProfileSource, BeeProfileScope } from './profiles'
import { isBeeId } from './profiles'
import { relayMemberItems } from './events'
import { ChangeSignal } from './coordination/change-signal'
import type { ProfileReviews } from './profile-review'
import type { EvolutionController } from './evolution/types'
import { HookRunner, snapshot, bounded, type AssignmentRevisionPin, type SwarmAssignment, type TaskSnapshot, type AssessmentSnapshot, type Immutable } from './hooks'
import { TaskStore, type TaskPhase } from './tasks/store'
import { ResultStore, preview, type ResultDescriptor, type SwarmResultOptions } from './results'
import { CompletionMailbox, type SwarmMailboxOptions } from './coordination/mailbox'
import { OperationStore } from './coordination/operations'
import { managementArguments } from './management-dispatch'
import type { ManagementBridgeLease } from './management-bridge'

export interface SwarmLimits { maxBees: number; maxConcurrentTasks: number; maxTasksPerTurn: number }
/** Workflow coordinator attached after construction; it supplies per-bee member tool servers. */
export interface WorkflowCoordinator {
  attachMemberServer(beeId: string): Promise<ManagementBridgeLease | undefined>
}
type Message = { messageId: string; taskId: string; attemptId: string; beeId: string; message: string; delivery: 'currentTurn' | 'nextAssignment'; state: 'queued' | 'submitted' | 'rejected' | 'unknown'; reasonCode?: string; reservedBy?: string; revisionId?: string; targetTaskId?: string; targetAttemptId?: string; runId?: string }
type Bee = { id: string; name: string; role: string; backend: MemberBackend; requestedModel?: string; selection: BeeExecutionSelection; profile?: BeeProfile; profileSource?: BeeProfileSource; sourceFile?: string; workflowInstructions?: string; memberServer?: ManagementBridgeLease; session?: Session; sessionRevision?: string; fallback?: string; busy?: string; poisoned?: boolean; closing?: boolean; review?: Promise<void>; pending?: Message[] }
type WorkflowTaskMeta = { runId: string; parentTaskId?: string; depth: number; outputSchema?: JsonSchema }
type Task = { id: string; attemptId: string; beeId: string; turnId: string; phase: TaskPhase; origin: Pick<Bee, 'profile' | 'profileSource' | 'sourceFile'>; execution: SwarmExecution; selection: Immutable<BeeExecutionSelection>; state: 'running' | TurnResult['status']; result?: TurnResult; error?: HarnessError; output?: ResultDescriptor; done: Promise<void>; assignment: SwarmAssignment; workflow?: WorkflowTaskMeta; pin?: Immutable<AssignmentRevisionPin>; snapshot?: Immutable<TaskSnapshot>; assessment?: Immutable<AssessmentSnapshot>; assessing?: Promise<unknown>; activeTurn?: Turn; messages: Message[]; messageTail: Promise<void> }

const MEMBER_TOOLS_INSTRUCTIONS = 'Workflow execution tools are served on the anureo-swarm-member MCP server: workflow_list, workflow_run, workflow_status and workflow_send. Use them when your assignment calls for a registered workflow; steps you start are tracked as tasks under your own assignment. workflow_send may only target tasks of runs you started.'

function profileDetails(bee?: Pick<Bee, 'profile' | 'profileSource' | 'sourceFile'>) {
  return bee?.profile ? { profileId: bee.profile.id, ...(bee.profileSource ? { profileScope: bee.profileSource.scope, profileSource: bee.profileSource } : {}), ...(bee.sourceFile ? { sourceFile: bee.sourceFile } : {}) } : {}
}

/** Session-owned members; task executions have independent cancellation signals. */
export class BeeManager {
  private readonly bees = new Map<string, Bee>()
  private readonly tasks: TaskStore<Task>
  private readonly results: ResultStore
  private readonly mailbox: CompletionMailbox
  private readonly beeChanges = new ChangeSignal()
  private waiting = new AbortController()
  private waiters = 0
  private readonly operations = new OperationStore()
  private turnId?: string
  private accepting = false
  private closed = false
  uncertain = false
  workflow?: WorkflowCoordinator

  constructor(private readonly params: SessionOpenParams, private readonly sink: SessionEventSink,
    private readonly backendFor: (role: string) => MemberBackend, private readonly profiles: BeeProfileRegistry,
    private readonly limits: SwarmLimits, private readonly reviews?: ProfileReviews, private readonly hooks = new HookRunner(), private readonly evolution?: EvolutionController,
    runtime: { results?: SwarmResultOptions; mailbox?: SwarmMailboxOptions } = {}) {
    this.results = new ResultStore(runtime.results)
    this.mailbox = new CompletionMailbox(runtime.mailbox)
    this.tasks = new TaskStore(limits, task => { if (task.output) this.results.expire(task.output.resultRef) }, 8, 128, task => {
      // Historical queries need descriptors, not full native item trees or hook copies.
      task.result = undefined; task.snapshot = undefined; task.assessing = undefined; task.messages = []
    })
  }

  begin(turnId: string) { this.tasks.begin(turnId); this.mailbox.begin(turnId); this.operations.begin(); this.turnId = turnId; this.waiting = new AbortController(); this.accepting = true }
  stop() { this.accepting = false; this.waiting.abort(); for (const task of this.tasks.values()) if (task.state === 'running') { task.phase = 'stopping'; task.execution.cancel() } }
  async settle() { this.stop(); await Promise.all([...this.tasks.values()].map(task => task.done)) }

  async call(name: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || !this.accepting || !this.turnId) throw new HarnessSdkError('SWARM_TOOLS_INACTIVE')
    const args = managementArguments(name, value)
    if (this.uncertain && (name === 'bee_create' || name === 'bee_delegate')) throw new HarnessSdkError('SWARM_RECOVERY_REQUIRED')
    if (name !== 'bee_send' && args.operationKey !== undefined) {
      const { operationKey, ...operation } = args
      return this.operations.run(name, operationKey, operation, () => this.call(name, operation, signal))
    }
    const text = (key: string) => {
      const value = args[key]
      if (typeof value !== 'string' || !value.trim() || value.length > 16000) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', `${key} must be a nonempty string of at most 16000 characters`)
      return value
    }
    const waitSignal = signal ? AbortSignal.any([signal, this.waiting.signal]) : this.waiting.signal
    const timeout = () => {
      const ms = args.timeoutMs === undefined ? 30000 : args.timeoutMs
      if (!Number.isInteger(ms) || (ms as number) < 0 || (ms as number) > 30000) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      return ms as number
    }
    if (name === 'bee_receive') {
      const limit = args.limit === undefined ? 16 : args.limit
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 64 || (args.after !== undefined && (!Number.isSafeInteger(args.after) || (args.after as number) < 0))) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      return this.observe(() => this.mailbox.receive(args.after as number | undefined, limit as number, timeout(), waitSignal))
    }
    if (name === 'bee_result_read') return this.results.read(text('resultRef'), args.cursor, args.maxBytes)
    if (name === 'bee_send') {
      const taskId = text('taskId'), message = text('message')
      if (Buffer.byteLength(message) > 16 * 1024 || !['currentTurn', 'nextAssignment'].includes(args.delivery as string)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      return this.operations.run(name, args.operationKey, args, () => this.send(taskId, message, args.delivery as Message['delivery'])).then(receipt => ({ ...receipt, message: undefined, reservedBy: undefined }))
    }
    if (name === 'bee_create') {
      if (this.bees.size >= this.limits.maxBees) throw new HarnessSdkError('SWARM_BEE_LIMIT')
      if (args.profileScope !== undefined && (!['user', 'project'].includes(args.profileScope as string) || args.profileId === undefined)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'profileScope requires profileId and must be user or project')
      const registration = args.profileId === undefined ? undefined : this.profiles.resolve(text('profileId'), args.profileScope as BeeProfileScope | undefined)
      const profile = registration?.profile
      if (args.profileId !== undefined && (!profile || args.role !== undefined || args.name !== undefined || args.model !== undefined)) throw new HarnessSdkError('SWARM_INVALID_PROFILE')
      const role = profile?.id ?? text('role')
      if (!isBeeId(role)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'role must be a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$')
      const backend = this.backendFor(role)
      const requestedModel = profile ? profile.model : selectTemporaryModel(args.model, backend)
      const requestedEffort = selectEffort(profile ? profile.effort : args.effort, requestedModel, backend)
      const selectionReason = profile ? undefined : parseSelectionReason(args.selectionReason, backend)
      const bee: Bee = { id: randomUUID(), role, name: profile?.name ?? text('name'), backend, requestedModel, selection: executionSelection(backend, requestedModel, !!profile, selectionReason, requestedEffort), profile, profileSource: registration?.source, sourceFile: registration?.sourceFile }
      this.bees.set(bee.id, bee)
      this.beeChanges.touch()
      await this.attachServer(bee)
      return { beeId: bee.id, name: bee.name, ...profileDetails(bee), execution: bee.selection, operationScope: this.operations.scope() }
    }
    if (name === 'bee_assess') {
      const task = this.task(text('taskId'))
      if (task.turnId !== this.turnId) throw new HarnessSdkError('SWARM_UNKNOWN_TASK')
      if (!task.snapshot) throw new HarnessSdkError('SWARM_TASK_RUNNING')
      const verdict = text('verdict')
      if (!['accepted', 'needs_revision', 'rejected'].includes(verdict)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      const reason = text('reason')
      const evidence = args.evidence
      if (!Array.isArray(evidence) || evidence.length > 32 || !evidence.every(v => typeof v === 'string' && v.trim() && v.length <= 16000)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      if (task.assessment) {
        if (task.assessment.verdict !== verdict || task.assessment.reason !== reason || JSON.stringify(task.assessment.evidence) !== JSON.stringify(evidence)) throw new HarnessSdkError('SWARM_ASSESSMENT_CONFLICT')
        await task.assessing
        return task.assessment
      }
      task.assessment = snapshot({ id: randomUUID(), sessionId: this.params.binding.sessionId, turnId: task.turnId, taskId: task.id, beeId: task.beeId, verdict: verdict as AssessmentSnapshot['verdict'], reason, evidence })
      task.assessing = this.hooks.invoke('afterAssessment', task.assessment)
      await task.assessing
      return task.assessment
    }
    if (name === 'bee_status') {
      if (args.taskId !== undefined) {
        if (args.history !== undefined || args.cursor !== undefined || args.limit !== undefined) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
        return this.report(this.task(text('taskId')))
      }
      const limit = args.limit === undefined ? 16 : args.limit
      if ((args.history !== undefined && typeof args.history !== 'boolean') || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 32) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      const records = this.tasks.list(args.history as boolean | undefined)
      const start = args.cursor === undefined ? 0 : records.findIndex(task => task.id === text('cursor')) + 1
      if (args.cursor !== undefined && start === 0) throw new HarnessSdkError('SWARM_INVALID_CURSOR')
      const selected = records.slice(start, start + (limit as number))
      const hasMore = start + selected.length < records.length
      return { operationScope: this.operations.scope(), diagnostics: snapshot(this.hooks.diagnostics), bees: [...this.bees.values()].map(bee => ({ beeId: bee.id, name: bee.name, ...profileDetails(bee), execution: bee.selection, taskId: bee.busy, unavailable: bee.poisoned })), tasks: this.reports(selected), hasMore, ...(hasMore ? { nextCursor: selected.at(-1)!.id } : {}) }
    }
    if (name === 'bee_wait') {
      const batch = args.taskIds !== undefined
      if (batch ? args.taskId !== undefined || !Array.isArray(args.taskIds) || args.taskIds.length < 1 || args.taskIds.length > 32 || !args.taskIds.every(id => typeof id === 'string' && id.trim() && id.length <= 16000) || new Set(args.taskIds).size !== args.taskIds.length || !['any', 'all'].includes(args.mode as string) : args.mode !== undefined) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS')
      const ids = batch ? args.taskIds as string[] : [text('taskId')]
      const outcome = await this.observe(() => this.tasks.wait(ids, batch ? args.mode as 'any' | 'all' : 'all', timeout(), waitSignal))
      if (!batch) return this.report(outcome.tasks[0])
      const reports = this.reports(outcome.tasks)
      return { reason: outcome.timedOut ? 'timeout' : 'terminal', timedOut: outcome.timedOut, tasks: reports, remainingTaskIds: outcome.tasks.filter(task => task.phase !== 'terminal').map(task => task.id) }
    }
    if (name === 'bee_cancel') {
      const task = this.task(text('taskId'))
      if (task.state === 'running') task.phase = 'stopping'
      task.execution.cancel(); await task.done
      return this.report(task)
    }
    const bee = this.bees.get(text('beeId'))
    if (!bee) throw new HarnessSdkError('SWARM_UNKNOWN_BEE')
    if (name === 'bee_close') {
      await this.closeBee(bee)
      return { closed: true }
    }
    if (bee.busy || bee.poisoned || bee.closing) throw new HarnessSdkError('SWARM_BEE_UNAVAILABLE')
    this.tasks.checkCapacity()
    const assignment = { task: text('task'), context: text('context'), constraints: text('constraints'), expectedOutput: text('expectedOutput') }
    const task: Task = { id: randomUUID(), attemptId: randomUUID(), beeId: bee.id, turnId: this.turnId, phase: 'accepted', origin: structuredClone({ profile: bee.profile, profileSource: bee.profileSource, sourceFile: bee.sourceFile }), execution: new SwarmExecution(), selection: snapshot(bee.selection), state: 'running', done: Promise.resolve(), assignment, messages: [], messageTail: Promise.resolve() }
    this.mailbox.reserve(task.id)
    try { this.tasks.add(task) } catch (cause) { this.mailbox.rollback(task.id); throw cause }
    bee.busy = task.id
    task.done = Promise.resolve().then(() => this.run(bee, task, assignment)).catch(() => { this.uncertain = true; bee.poisoned = true; this.tasks.changes.touch() })
    return { taskId: task.id, beeId: bee.id, attemptId: task.attemptId, operationScope: this.operations.scope() }
  }

  /** Programmatic workflow paths; admission budgets are owned by the workflow runner. */
  get beeSlots() { return this.beeChanges }

  async createWorkflowBee(spec: { role: string; name: string; model?: string; instructions?: string }): Promise<string> {
    if (this.closed) throw new HarnessSdkError('SWARM_TOOLS_INACTIVE')
    if (this.bees.size >= this.limits.maxBees) throw new HarnessSdkError('SWARM_BEE_LIMIT')
    if (!isBeeId(spec.role)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'role must be a lowercase slug matching ^[a-z][a-z0-9-]{0,39}$')
    if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 512) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'name must be a nonempty string of at most 512 characters')
    if (spec.instructions !== undefined && (typeof spec.instructions !== 'string' || spec.instructions.length > 64000)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'instructions must be a string of at most 64000 characters')
    const backend = this.backendFor(spec.role)
    const requestedModel = spec.model === undefined ? undefined : selectTemporaryModel(spec.model, backend)
    const bee: Bee = { id: randomUUID(), role: spec.role, name: spec.name, backend, requestedModel, workflowInstructions: spec.instructions, selection: executionSelection(backend, requestedModel, false, 'Swarm workflow step') }
    this.bees.set(bee.id, bee)
    this.beeChanges.touch()
    await this.attachServer(bee)
    return bee.id
  }

  async closeWorkflowBee(beeId: string): Promise<void> {
    const bee = this.bees.get(beeId)
    if (!bee || bee.busy || bee.closing) return
    await this.closeBee(bee).catch(() => {})
  }

  workflowDelegate(beeId: string, step: { task: string; context?: string; constraints?: string; expectedOutput?: string; outputSchema?: JsonSchema }, meta: WorkflowTaskMeta): { taskId: string; outcome: Promise<{ state: Task['state']; result?: TurnResult }> } {
    if (this.closed || !this.accepting || !this.turnId) throw new HarnessSdkError('SWARM_WORKFLOW_TURN_ENDED')
    const bee = this.bees.get(beeId)
    if (!bee) throw new HarnessSdkError('SWARM_UNKNOWN_BEE')
    if (bee.busy || bee.poisoned || bee.closing) throw new HarnessSdkError('SWARM_BEE_UNAVAILABLE')
    const text = (value: string | undefined): string => {
      if (value !== undefined && (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024)) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'workflow step fields must be strings of at most 256 KiB')
      return value ?? ''
    }
    if (typeof step.task !== 'string' || !step.task.trim() || Buffer.byteLength(step.task) > 256 * 1024) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'task must be a nonempty string of at most 256 KiB')
    const assignment: SwarmAssignment = {
      task: step.task,
      context: text(step.context) || 'Provided by a swarm workflow step.',
      constraints: text(step.constraints) || 'Read-only. Complete the assigned step and report evidence.',
      expectedOutput: text(step.expectedOutput) || 'A plain-text report answering the step prompt.',
    }
    const task: Task = { id: randomUUID(), attemptId: randomUUID(), beeId: bee.id, turnId: this.turnId, phase: 'accepted', origin: structuredClone({ profile: bee.profile, profileSource: bee.profileSource, sourceFile: bee.sourceFile }), execution: new SwarmExecution(), selection: snapshot(bee.selection), state: 'running', done: Promise.resolve(), assignment, workflow: { runId: meta.runId, ...(meta.parentTaskId ? { parentTaskId: meta.parentTaskId } : {}), depth: meta.depth, ...(step.outputSchema ? { outputSchema: step.outputSchema } : {}) }, messages: [], messageTail: Promise.resolve() }
    this.mailbox.reserve(task.id)
    try { this.tasks.add(task, 'workflow') } catch (cause) { this.mailbox.rollback(task.id); throw cause }
    bee.busy = task.id
    task.done = Promise.resolve().then(() => this.run(bee, task, assignment)).catch(() => { this.uncertain = true; bee.poisoned = true; this.tasks.changes.touch() })
    return { taskId: task.id, outcome: task.done.then(() => ({ state: task.state, result: task.result })) }
  }

  currentTaskOf(beeId: string): { taskId: string; depth: number } | undefined {
    const bee = this.bees.get(beeId)
    if (!bee?.busy) return undefined
    const task = this.tasks.get(bee.busy)
    return task ? { taskId: task.id, depth: task.workflow?.depth ?? 0 } : undefined
  }

  workflowTaskRun(taskId: string): string | undefined { return this.tasks.get(taskId)?.workflow?.runId }

  workflowSend(runId: string, taskId: string, message: string, delivery: Message['delivery']): Message | Promise<Message> {
    if (this.workflowTaskRun(taskId) !== runId) throw new HarnessSdkError('SWARM_UNKNOWN_TASK', 'Task does not belong to this workflow run')
    return this.send(taskId, message, delivery, runId)
  }

  expireRunMessages(runId: string) {
    for (const bee of this.bees.values()) for (const message of bee.pending ?? []) {
      if (message.runId === runId && message.state === 'queued') { message.state = 'rejected'; message.reasonCode = 'SWARM_WORKFLOW_ENDED' }
    }
  }

  private task(id: string) { const task = this.tasks.get(id); if (!task) throw new HarnessSdkError('SWARM_UNKNOWN_TASK'); return task }

  private async closeBee(bee: Bee) {
    if (bee.closing) throw new HarnessSdkError('SWARM_BEE_UNAVAILABLE')
    bee.closing = true
    for (const message of bee.pending ?? []) { message.state = 'rejected'; message.reasonCode = 'SWARM_BEE_CLOSED' }
    if (bee.busy) { const task = this.task(bee.busy); task.execution.cancel(); await task.done }
    await this.release(bee)
    this.bees.delete(bee.id)
    this.beeChanges.touch()
  }

  private async attachServer(bee: Bee) {
    if (!this.workflow || bee.memberServer) return
    bee.memberServer = await this.workflow.attachMemberServer(bee.id)
  }
  private report(task: Task, budget = 16 * 1024) {
    let text = task.output ? preview(task.output.preview, Math.max(0, budget)) : undefined
    while (text?.text && Buffer.byteLength(JSON.stringify(text.text)) * 2 > budget) text = { text: preview(text.text, Math.floor(Buffer.byteLength(text.text) / 2)).text, truncated: true }
    return { taskId: task.id, beeId: task.beeId, attemptId: task.attemptId, outerTurnId: task.turnId, phase: task.phase, ...profileDetails(task.origin), execution: task.selection, state: task.state, pin: task.pin, assessment: task.assessment,
      ...(task.workflow ? { workflow: { runId: task.workflow.runId, ...(task.workflow.parentTaskId ? { parentTaskId: task.workflow.parentTaskId } : {}), depth: task.workflow.depth } } : {}),
      text: text?.text, textTruncated: text ? text.truncated || task.output!.previewTruncated : undefined,
      result: task.output ? { ...task.output, preview: text!.text, previewTruncated: text!.truncated || task.output.previewTruncated } : undefined,
      messaging: { currentTurn: task.phase === 'running' && !!task.activeTurn && this.bees.get(task.beeId)?.session?.capabilities.input?.steer?.atomicMatch === true, nextAssignment: this.bees.has(task.beeId) },
      error: task.error }
  }

  private reports(tasks: readonly Task[]) {
    let budget = 32 * 1024
    return tasks.map(task => {
      const report = this.report(task, budget)
      budget = Math.max(0, budget - (report.text ? Buffer.byteLength(JSON.stringify(report.text)) * 2 : 0))
      return report
    })
  }

  private async observe<T>(read: () => Promise<T>): Promise<T> {
    if (this.waiters >= 16) throw new HarnessSdkError('SWARM_WAITER_LIMIT')
    this.waiters++
    try { return await read() } finally { this.waiters-- }
  }

  private send(taskId: string, message: string, delivery: Message['delivery'], runId?: string): Message | Promise<Message> {
    const task = this.task(taskId)
    const bee = this.bees.get(task.beeId)
    if (!bee || bee.closing || bee.poisoned) throw new HarnessSdkError('SWARM_BEE_UNAVAILABLE')
    const receipt: Message = { messageId: randomUUID(), taskId, attemptId: task.attemptId, beeId: bee.id, message, delivery, state: 'queued', revisionId: task.pin?.revisionId, ...(runId ? { runId } : {}) }
    if (delivery === 'nextAssignment') {
      const pendingBytes = [...this.bees.values()].flatMap(member => member.pending ?? []).reduce((bytes, item) => bytes + Buffer.byteLength(item.message), 0)
      if ((bee.pending?.length ?? 0) >= 16 || pendingBytes + Buffer.byteLength(message) > 256 * 1024) throw new HarnessSdkError('SWARM_MESSAGE_QUEUE_FULL')
      bee.pending ??= []
      bee.pending.push(receipt)
      return receipt
    }
    if (task.phase !== 'running' || !task.activeTurn) throw new HarnessSdkError('SWARM_MESSAGE_TARGET_ENDED')
    if (!bee.session?.capabilities.input?.steer?.atomicMatch) throw new HarnessSdkError('SWARM_MESSAGE_DELIVERY_UNSUPPORTED')
    if (task.messages.length >= 16) throw new HarnessSdkError('SWARM_MESSAGE_QUEUE_FULL')
    task.messages.push(receipt)
    const sending = task.messageTail.then(async () => {
      if (task.phase !== 'running' || !task.activeTurn || task.execution.stopped) {
        receipt.state = 'rejected'; receipt.reasonCode = 'SWARM_MESSAGE_TARGET_ENDED'; return receipt
      }
      if (task.messages.some(item => item.state === 'unknown')) {
        receipt.state = 'rejected'; receipt.reasonCode = 'SWARM_MESSAGE_ORDER_UNKNOWN'; return receipt
      }
      try {
        await task.activeTurn.steer({ input: JSON.stringify({ kind: 'swarm.taskMessage', taskId, attemptId: task.attemptId, message }) }, { timeoutMs: 5000 })
        receipt.state = 'submitted'
      } catch (cause) {
        const error = sdkError(cause)
        receipt.state = error.outcomeUnknown || error.code === 'REQUEST_TIMEOUT' || error.code === 'REQUEST_ABORTED' ? 'unknown' : 'rejected'
        receipt.reasonCode = error.code
      }
      return receipt
    })
    task.messageTail = sending.then(() => {})
    return sending
  }

  private async run(bee: Bee, task: Task, assignment: SwarmAssignment) {
    task.phase = 'preparing'
    let profile = bee.profile
    let experiences: readonly string[] = []
    const started = Date.now()
    const item: SubagentItem = { id: task.id, type: 'subagent', subagentId: bee.id, name: bee.name, task: assignment.task, state: 'running', status: 'running', startedAt: new Date(started).toISOString(), ...(task.workflow?.parentTaskId ? { parentItemId: task.workflow.parentTaskId } : {}), extensions: { swarm: { kind: profile ? 'fixed' : 'temporary', attemptId: task.attemptId, ...profileDetails(bee), ...(task.workflow ? { workflow: { runId: task.workflow.runId, depth: task.workflow.depth } } : {}), execution: task.selection } } }
    const relay = relayMemberItems(this.sink, task.turnId, task.id, bee.id)
    const backend = bee.backend.client
    const assemble = (profileInstructions: string | undefined, reusable?: readonly string[]) => ['Perform only the assigned read-only task. Do not edit files or change external state. Report findings and evidence.', profileInstructions, bee.workflowInstructions,
      reusable?.length ? 'Reusable experience:\n' + reusable.join('\n\n') : undefined, bee.memberServer ? MEMBER_TOOLS_INSTRUCTIONS : undefined].filter(Boolean).join('\n\n')
    let instructions = assemble(profile?.instructions)
    let requestedEffort = bee.selection.requestedEffort
    let open = { cwd: this.params.cwd, permissionMode: this.params.permissionMode, model: bee.requestedModel, instructions, config: effortConfig(requestedEffort, bee.backend), ...(bee.memberServer ? { mcpServers: [bee.memberServer.config] } : {}) }
    let boundary: Boundary | undefined
    let submitted = false
    let dispatched = false
    let carried: Message[] = []
    let itemStarted = false
    try {
      if (profile && this.evolution) {
        const configured = profile
        const resolved = await bounded(() => this.evolution!.seed(configured, undefined, bee.profileSource), this.hooks.timeoutMs, task.execution.signal)
        if (task.execution.stopped) throw new Error('SWARM_HOOK_ABORTED')
        profile = resolved.revision.profile
        experiences = resolved.revision.experiences
        task.pin = snapshot({ revisionId: resolved.revision.id, generation: resolved.head.generation, headId: resolved.head.id })
        instructions = assemble(profile.instructions, experiences)
        requestedEffort = selectEffort(profile.effort, profile.model, bee.backend)
        open = { cwd: this.params.cwd, permissionMode: this.params.permissionMode, model: profile.model, instructions, config: effortConfig(requestedEffort, bee.backend), ...(bee.memberServer ? { mcpServers: [bee.memberServer.config] } : {}) }
      }
      for (const message of bee.pending ?? []) {
        if (message.state === 'queued' && message.revisionId !== task.pin?.revisionId) { message.state = 'rejected'; message.reasonCode = 'SWARM_MESSAGE_PROFILE_CHANGED' }
      }
      carried = (bee.pending ?? []).filter(message => message.state === 'queued' && !message.reservedBy && (message.runId === undefined || message.runId === task.workflow?.runId))
      for (const message of carried) message.reservedBy = task.id
      if (carried.length) assignment.context += '\n\nSupplemental task data:\n' + JSON.stringify(carried.map(message => ({ originatingTaskId: message.taskId, originatingAttemptId: message.attemptId, messageId: message.messageId, message: message.message })))
      bee.selection = executionSelection(bee.backend, open.model, !!profile, bee.selection.selectionReason, requestedEffort)
      task.selection = snapshot(bee.selection)
      item.extensions = { swarm: { kind: profile ? 'fixed' : 'temporary', attemptId: task.attemptId, ...profileDetails(bee), ...(task.workflow ? { workflow: { runId: task.workflow.runId, depth: task.workflow.depth } } : {}), ...(task.pin ? { pin: task.pin } : {}), execution: task.selection } }
      itemStarted = true
      await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId: task.turnId })
      const change = await this.hooks.invoke('beforeDelegate', {
        sessionId: this.params.binding.sessionId, turnId: task.turnId, taskId: task.id, beeId: bee.id,
        name: bee.name, role: bee.role, profile, profileSource: bee.profileSource, sourceFile: bee.sourceFile, execution: task.selection, attemptId: task.attemptId, carriedMessageIds: carried.map(message => message.messageId), ...(task.pin ? { pin: task.pin, experiences } : {}), assignment,
      }, task.execution.signal)
      if (task.execution.stopped) throw new Error('SWARM_HOOK_ABORTED')
      if (change && 'deny' in change) throw new Error(`SWARM_DELEGATION_DENIED: ${change.deny}`)
      if (change && 'enrich' in change) {
        if (!change.enrich || typeof change.enrich !== 'object' || Object.keys(change.enrich).some(key => !['context', 'constraints', 'expectedOutput'].includes(key))) throw new Error('SWARM_INVALID_HOOK_ENRICHMENT')
        for (const key of ['context', 'constraints', 'expectedOutput'] as const) {
          const extra = change.enrich[key]
          if (extra !== undefined) {
            if (typeof extra !== 'string' || extra.length > 16000) throw new Error('SWARM_INVALID_HOOK_ENRICHMENT')
            assignment[key] += '\n\n' + extra
          }
        }
      }
      await bee.review
      if (task.execution.stopped) throw new Error('SWARM_HOOK_ABORTED')
      if (bee.session && bee.sessionRevision !== task.pin?.revisionId) {
        // Reservation prevents reuse while the idle old revision is being released.
        await this.release(bee)
        bee.session = undefined
        bee.fallback = undefined
      }
      if (task.execution.stopped) throw new Error('SWARM_HOOK_ABORTED')
      if (!bee.session && !task.execution.stopped) {
        task.phase = 'starting'
        bee.session = await backend.sessions.create(open, { signal: task.execution.signal }).catch(async cause => {
          if (!instructionsUnsupported(cause)) throw cause
          bee.fallback = instructions
          return backend.sessions.create({ ...open, instructions: undefined }, { signal: task.execution.signal })
        })
        bee.sessionRevision = task.pin?.revisionId
      }
      submitted = !!bee.session && !task.execution.stopped
      task.phase = submitted ? 'starting' : 'stopping'
      task.result = bee.session ? await task.execution.submit(bee.session, { input: [bee.fallback, JSON.stringify(assignment)].filter(Boolean).join('\n\n'), ...(task.workflow?.outputSchema ? { outputSchema: task.workflow.outputSchema } : {}) }, async event => {
        if (event.type === 'turn/started') boundary = { turnId: event.payload.turnId, nativeTurnId: event.payload.nativeTurnId, relation: 'through' }
        await relay.accept(event)
      }, undefined, {
        onDispatch() {
          dispatched = true
          for (const message of carried) { message.targetTaskId = task.id; message.targetAttemptId = task.attemptId }
        },
        onBound: turn => {
          task.activeTurn = turn
          task.phase = task.execution.stopped ? 'stopping' : 'running'
          for (const message of carried) message.state = 'submitted'
        },
      }) : { status: 'interrupted', text: '', items: [] }
      if (task.result.status === 'completed' && profile && this.reviews && boundary && bee.session) {
        bee.review = this.reviews.start(backend, bee.session, { ...open, instructions: bee.fallback ? undefined : instructions }, profile, boundary, false, { profileSource: bee.profileSource, sourceFile: bee.sourceFile })
      }
    } catch (cause) { task.result = { status: task.execution.stopped ? 'interrupted' : 'failed', text: '', items: [], error: { ...executionError(cause), ...(!submitted ? { outcomeUnknown: false, message: cause instanceof Error ? cause.message.slice(0, 2000) : 'Delegation setup failed' } : {}) } } }
    finally {
      task.phase = 'settling'
      await task.messageTail
      await task.activeTurn?.dispose()
      task.activeTurn = undefined
      for (const message of carried) {
        if (dispatched && message.state === 'queued') {
          message.state = task.result?.status !== 'completed' && task.result?.error?.outcomeUnknown ? 'unknown' : 'rejected'
          message.reasonCode = 'SWARM_MESSAGE_ASSIGNMENT_FAILED'
        }
        message.reservedBy = undefined
      }
      bee.pending = (bee.pending ?? []).filter(message => message.state === 'queued')
      const terminalState = task.result?.status ?? 'failed'
      if (task.result && task.result.status !== 'completed' && task.result.error?.outcomeUnknown) { this.uncertain = true; bee.poisoned = true }
      try {
        if (!itemStarted) await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId: task.turnId })
        await relay.finish(terminalState)
        await this.sink.emit({ type: 'item/completed', payload: { item: {
          ...item, state: terminalState, status: terminalState, durationMs: Date.now() - started,
          ...(bee.session?.reference.binding.nativeRef ? { nativeRef: bee.session.reference.binding.nativeRef } : {}),
        } } }, { turnId: task.turnId })
      } catch { this.uncertain = true }
      finally {
        const completed = snapshot({ sessionId: this.params.binding.sessionId, turnId: task.turnId, taskId: task.id,
          beeId: bee.id, name: bee.name, role: bee.role, profile, profileSource: bee.profileSource, sourceFile: bee.sourceFile, execution: task.selection, attemptId: task.attemptId, carriedMessageIds: carried.map(message => message.messageId), ...(task.pin ? { pin: task.pin, experiences } : {}), assignment, result: task.result! })
        await this.hooks.invoke('afterTask', completed)
        task.snapshot = completed
        // Expose terminal state only when bee_assess can consume its snapshot.
        task.error = task.result!.status === 'completed' ? undefined : task.result!.error
        task.output = this.results.put(task.id, task.attemptId, task.result!)
        task.state = terminalState
        task.phase = 'terminal'
        if (bee.busy === task.id) bee.busy = undefined
        this.mailbox.publish(task, task.output, task.result!)
        this.tasks.changes.touch()
      }
    }
  }

  async afterTurn(turnId: string, status: TurnResult['status'], signal?: AbortSignal) {
    await Promise.all([...this.tasks.values()].map(task => task.assessing))
    await this.hooks.invoke('afterTurn', { sessionId: this.params.binding.sessionId, turnId, status,
      tasks: [...this.tasks.values()].flatMap(task => task.snapshot ? [task.snapshot] : []),
      assessments: [...this.tasks.values()].flatMap(task => task.assessment ? [task.assessment] : []),
    }, signal)
  }

  async close() {
    this.closed = true
    this.mailbox.close()
    this.tasks.close()
    await this.settle()
    const results = await Promise.allSettled([...this.bees.values()].map(bee => this.release(bee)))
    this.bees.clear()
    this.results.close()
    if (results.some(result => result.status === 'rejected')) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED')
  }

  private async release(bee: Bee) {
    await bee.review
    const server = bee.memberServer
    bee.memberServer = undefined
    try {
      if (server) await server.dispose()
    } catch (cause) { this.uncertain = true; bee.poisoned = true; throw cause }
    if (!bee.session) return
    try {
      // Completed task results are our stop evidence. Some backends conservatively
      // report unconfirmed on close even for an already terminal session.
      await releaseSession(bee.session)
    } catch (cause) { this.uncertain = true; bee.poisoned = true; throw cause }
  }
}
