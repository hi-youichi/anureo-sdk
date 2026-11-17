// Workflow execution for one swarm session: runs, step admission, façade clients and tool dispatch.
import { randomUUID } from 'node:crypto'
import { HarnessSdkError, sdkError, type Client, type SessionEventSink, type TurnResult } from '@anureo/sdk'
import type { JsonSchema, JsonValue, SessionOpenParams } from '@anureo/protocol'
import { workflow as runWorkflow } from '@anureo/workflow'
import type { BeeManager } from '../bee-manager'
import type { MemberBackend } from '../models'
import { WorkflowPool, poolKeyFor, type WorkflowBeeLease } from './pool'
import { workflowArguments, WORKFLOW_TOOLS, MEMBER_WORKFLOW_TOOLS } from './tools'
import type { ParsedSwarmWorkflowOptions, SwarmWorkflowRegistration } from './types'

export type WorkflowRunStatus = 'running' | 'completed' | 'incomplete' | 'failed' | 'interrupted'
type RunTrigger = { kind: 'host' } | { kind: 'main' } | { kind: 'member'; beeId: string }

interface RunRecord {
  runId: string
  workflowId: string
  status: WorkflowRunStatus
  startedAt: string
  depth: number
  parentTaskId?: string
  trigger: RunTrigger['kind']
  triggeredBy?: string
  taskIds: Set<string>
  started: number
  waiting: number
  settled: number
  resultJson?: string
  resultTruncated?: boolean
  journalRunId?: string
  error?: { code: string; message: string }
  done: Promise<void>
}

/** One workflow step as submitted by beer() or the façade client. */
export interface WorkflowStep {
  prompt: string
  role?: string
  name?: string
  model?: string
  instructions?: string
  context?: string
  constraints?: string
  expectedOutput?: string
  outputSchema?: JsonSchema
}

/** Delegate handle published on façade clients; beer() binds to it. */
export const swarmWorkflowClient: unique symbol = Symbol.for('anureo.adapter-swarm/swarm-workflow-client')
export interface SwarmWorkflowDelegate {
  readonly run: { runId: string; depth: number }
  readonly outputSchemaAdvertised: boolean
  turnEnded(): boolean
  step(step: WorkflowStep): Promise<TurnResult>
}

const turnEndedError = () => new HarnessSdkError('SWARM_WORKFLOW_TURN_ENDED', 'The outer turn ended; queued workflow steps were cancelled')
const RESULT_PREVIEW_BYTES = 16 * 1024
const RESULT_JSON_BYTES = 64 * 1024

/** Host directive grammar: /workflow list | /workflow run <id> [argsJson] | /workflow resume <id> <runId>. */
export type WorkflowDirective = { kind: 'list' } | { kind: 'run'; workflowId: string; args?: unknown; resumeFrom?: string }

export function parseWorkflowDirective(text: string): WorkflowDirective | 'invalid' | undefined {
  if (!text.startsWith('/workflow')) return undefined
  const match = /^\/workflow[ \t]+(list|run|resume)(?:[ \t]+([\s\S]*))?$/.exec(text.trim())
  if (!match) return 'invalid'
  const [, verb, raw = ''] = match
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (verb === 'list') return parts.length ? 'invalid' : { kind: 'list' }
  if (verb === 'run') {
    if (!parts.length) return 'invalid'
    const workflowId = parts.shift()!
    let remaining = parts.join(' ')
    let resumeFrom: string | undefined
    const resume = /^(?:--resume[ \t]*=?[ \t]*|--resume=)(\S+)(?:[ \t]+([\s\S]*))?$/.exec(remaining)
    if (resume) { resumeFrom = resume[1]; remaining = resume[2] ?? '' }
    let args: unknown
    if (remaining.trim()) {
      try { args = JSON.parse(remaining) } catch { return 'invalid' }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'invalid'
    }
    return { kind: 'run', workflowId, ...(args !== undefined ? { args } : {}), ...(resumeFrom !== undefined ? { resumeFrom } : {}) }
  }
  if (parts.length !== 2) return 'invalid'
  return { kind: 'run', workflowId: parts[0], args: null, resumeFrom: parts[1] }
}

const boundPreview = (text: string): string =>
  Buffer.byteLength(text) <= RESULT_PREVIEW_BYTES ? text : `${text.slice(0, RESULT_PREVIEW_BYTES)}…[truncated]`

/**
 * Owns every workflow run of one swarm session. Runs triggered by the host
 * execute inside the outer turn; main-agent and member runs execute in the
 * background while their starter polls workflow_status. All runs settle before
 * the turn completes: queued steps are cancelled, completed steps stay journaled.
 */
export class WorkflowRunner {
  private readonly runs = new Map<string, RunRecord>()
  private pool?: WorkflowPool
  private ended = new AbortController()
  private running = 0
  private readonly slotWaiters: Array<{ resolve: () => void; reject: (error: HarnessSdkError) => void }> = []
  private waiters = 0
  private closed = false

  constructor(private readonly deps: {
    members: BeeManager
    params: SessionOpenParams
    sink: SessionEventSink
    options: ParsedSwarmWorkflowOptions
    resolveBackend: (role: string) => MemberBackend
  }) {}

  get options() { return this.deps.options }

  turnEnded(): boolean { return this.closed || this.ended.signal.aborted }

  beginTurn() {
    this.ended = new AbortController()
    this.pool ??= new WorkflowPool({
      createBee: spec => this.deps.members.createWorkflowBee(spec),
      closeBee: beeId => this.deps.members.closeWorkflowBee(beeId),
      beeSlots: this.deps.members.beeSlots,
    })
  }

  /** Cancel queued steps, await run settlement, then close idle pooled bees. */
  async settleTurn(): Promise<void> {
    if (!this.pool && this.runs.size === 0) return
    this.ended.abort()
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(turnEndedError())
    await Promise.allSettled([...this.runs.values()].map(record => record.done))
    const pool = this.pool
    this.pool = undefined
    await pool?.settle()
    const terminal = [...this.runs.values()].filter(record => record.status !== 'running')
    for (const record of terminal.slice(0, Math.max(0, terminal.length - 64))) this.runs.delete(record.runId)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.settleTurn()
  }

  /** Start a run and return its runId; the run itself settles through record.done. */
  async start(workflowId: string, args: unknown, trigger: RunTrigger, resumeFrom?: string): Promise<string> {
    if (this.closed) throw new HarnessSdkError('SWARM_TOOLS_INACTIVE')
    const registration = this.options.registrations.find(candidate => candidate.id === workflowId)
    if (!registration) throw new HarnessSdkError('SWARM_UNKNOWN_WORKFLOW')
    let depth = 0
    let parentTaskId: string | undefined
    if (trigger.kind === 'member') {
      const current = this.deps.members.currentTaskOf(trigger.beeId)
      if (!current) throw new HarnessSdkError('SWARM_WORKFLOW_MEMBER_IDLE', 'A bee may only start workflows while running one of its tasks')
      depth = current.depth + 1
      parentTaskId = current.taskId
    }
    if (depth > this.options.limits.maxDepth) throw new HarnessSdkError('SWARM_WORKFLOW_DEPTH', `Workflow nesting exceeds maxDepth ${this.options.limits.maxDepth}`)
    if (resumeFrom !== undefined && this.options.journalDirectory === undefined) {
      throw new HarnessSdkError('SWARM_WORKFLOW_RESUME_UNSUPPORTED', 'Runs without a journal directory cannot be resumed')
    }
    const runId = resumeFrom ?? randomUUID()
    const existing = this.runs.get(runId)
    if (existing) {
      if (existing.status === 'running') throw new HarnessSdkError('SWARM_WORKFLOW_RUN_ACTIVE')
      if (existing.workflowId !== workflowId) throw new HarnessSdkError('SWARM_INVALID_ARGUMENTS', 'resumeFrom belongs to a different workflow')
    }
    const record: RunRecord = {
      runId, workflowId, status: 'running', startedAt: new Date().toISOString(), depth,
      ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      trigger: trigger.kind, ...(trigger.kind === 'member' ? { triggeredBy: trigger.beeId } : {}),
      taskIds: new Set(), started: 0, waiting: 0, settled: 0, done: Promise.resolve(),
    }
    this.runs.set(runId, record)
    record.done = this.execute(record, registration, args, resumeFrom)
    return runId
  }

  private async execute(record: RunRecord, registration: SwarmWorkflowRegistration, argsInput: unknown, resumeFrom?: string): Promise<void> {
    try {
      if (registration.argsSchema !== undefined) {
        const parsed = registration.argsSchema.safeParse(argsInput ?? null)
        if (!parsed.success) {
          record.status = 'failed'
          record.error = { code: 'SWARM_INVALID_WORKFLOW_ARGS', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000) || 'args rejected by the workflow schema' }
          return
        }
        argsInput = parsed.data
      }
      const outcome = await runWorkflow({
        name: registration.id,
        revision: registration.revision,
        input: (argsInput ?? null) as JsonValue,
        ...(resumeFrom === undefined ? { runId: record.runId } : {}),
        ...(this.options.journalDirectory !== undefined ? { directory: this.options.journalDirectory } : {}),
        ...(resumeFrom !== undefined && this.options.journalDirectory !== undefined ? { resumeFrom: { directory: this.options.journalDirectory, runId: resumeFrom } } : {}),
      }, async () => await registration.run(argsInput as never, {
        client: this.client(record),
        cwd: this.deps.params.cwd,
        runId: record.runId,
        signal: this.ended.signal,
      }) as never)
      record.status = outcome.status
      // A run that cannot finish inside the turn was interrupted, whatever its body returned.
      if (outcome.status !== 'completed' && this.turnEnded()) record.status = 'interrupted'
      // A resumed run continues in a fresh journal directory; track it for later resumeFrom chaining.
      record.journalRunId = outcome.runId
      const json = outcome.result === undefined ? 'null' : JSON.stringify(outcome.result) ?? 'null'
      record.resultTruncated = json.length > RESULT_JSON_BYTES
      record.resultJson = record.resultTruncated ? JSON.stringify({ truncated: true, bytes: json.length }) : json
    } catch (cause) {
      const error = sdkError(cause, 'SWARM_WORKFLOW_FAILED')
      record.status = this.turnEnded() || error.code === 'SWARM_WORKFLOW_TURN_ENDED' ? 'interrupted' : 'failed'
      record.error = { code: error.code, message: (error.message ?? '').slice(0, 2000) }
    } finally {
      this.deps.members.expireRunMessages(record.runId)
    }
  }

  /** Execute a host directive inside the current outer turn and derive its TurnResult. */
  async runHostDirective(directive: WorkflowDirective): Promise<TurnResult> {
    if (directive.kind === 'list') return { status: 'completed', text: JSON.stringify(this.list()), items: [] }
    const runId = await this.start(directive.workflowId, directive.args ?? null, { kind: 'host' }, directive.resumeFrom)
    const record = this.runs.get(runId)!
    await record.done
    const payload = this.statusPayload(record)
    if (record.status === 'failed') {
      return { status: 'failed', text: JSON.stringify(payload), items: [], error: { code: record.error?.code ?? 'SWARM_WORKFLOW_FAILED', message: record.error?.message ?? 'The workflow run failed', retryable: false, outcomeUnknown: false } }
    }
    if (record.status === 'interrupted') return { status: 'interrupted', text: JSON.stringify(payload), items: [] }
    return { status: 'completed', text: JSON.stringify(payload), items: [] }
  }

  /** Main-agent tool dispatch for workflow_list/run/status. */
  async callMain(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = workflowArguments(name, input, WORKFLOW_TOOLS)
    if (name === 'workflow_list') return this.list()
    if (name === 'workflow_run') {
      const runId = await this.start(String(args.workflowId), args.args ?? null, { kind: 'main' }, typeof args.resumeFrom === 'string' ? args.resumeFrom : undefined)
      return { runId, workflowId: String(args.workflowId), status: 'running' }
    }
    return this.status(String(args.runId), Number(args.timeoutMs ?? 0), signal)
  }

  /** Member tool dispatch scoped to one bee by its dedicated lease. */
  async memberCall(beeId: string, name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = workflowArguments(name, input, MEMBER_WORKFLOW_TOOLS)
    if (name === 'workflow_list') return this.list()
    if (name === 'workflow_run') {
      const runId = await this.start(String(args.workflowId), args.args ?? null, { kind: 'member', beeId }, typeof args.resumeFrom === 'string' ? args.resumeFrom : undefined)
      return { runId, workflowId: String(args.workflowId), status: 'running' }
    }
    if (name === 'workflow_send') {
      const taskId = String(args.taskId)
      const runId = this.deps.members.workflowTaskRun(taskId)
      const record = runId !== undefined ? this.runs.get(runId) : undefined
      if (!record || record.triggeredBy !== beeId) throw new HarnessSdkError('SWARM_UNKNOWN_TASK', 'Only tasks of runs started by this bee are addressable')
      return this.deps.members.workflowSend(runId!, taskId, String(args.message), args.delivery as 'currentTurn' | 'nextAssignment')
    }
    return this.status(String(args.runId), Number(args.timeoutMs ?? 0), signal)
  }

  private list() {
    return { workflows: this.options.registrations.map(({ id, description, revision }) => ({ id, description, revision })) }
  }

  private async status(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const record = this.runs.get(runId)
    if (!record) throw new HarnessSdkError('SWARM_UNKNOWN_WORKFLOW_RUN')
    if (record.status === 'running' && timeoutMs > 0) {
      if (this.waiters >= 16) throw new HarnessSdkError('SWARM_WAITER_LIMIT')
      this.waiters++
      try {
        const deadline = Date.now() + timeoutMs
        while (record.status === 'running') {
          const remaining = Math.max(0, deadline - Date.now())
          if (!remaining) break
          await Promise.race([record.done.then(() => undefined), new Promise(resolve => setTimeout(resolve, Math.min(remaining, 1000)))])
          if (signal?.aborted) throw new HarnessSdkError('REQUEST_ABORTED')
        }
      } finally { this.waiters-- }
    }
    return this.statusPayload(record)
  }

  private statusPayload(record: RunRecord) {
    return {
      runId: record.runId,
      workflowId: record.workflowId,
      status: record.status,
      depth: record.depth,
      ...(record.parentTaskId !== undefined ? { parentTaskId: record.parentTaskId } : {}),
      steps: { started: record.started, settled: record.settled, queued: record.waiting },
      taskIds: [...record.taskIds],
      ...(record.journalRunId !== undefined && record.journalRunId !== record.runId ? { journalRunId: record.journalRunId } : {}),
      ...(record.resultJson !== undefined ? { result: boundPreview(record.resultJson), ...(record.resultTruncated ? { resultTruncated: true } : {}) } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    }
  }

  /** One admitted step: queue bounds, concurrency slot, pooled bee, then BeeManager delegation. */
  private async step(step: WorkflowStep, record: RunRecord): Promise<TurnResult> {
    if (this.turnEnded()) throw turnEndedError()
    if (record.waiting >= this.options.limits.maxQueueDepthPerRun) throw new HarnessSdkError('SWARM_WORKFLOW_QUEUE_FULL', `More than ${this.options.limits.maxQueueDepthPerRun} steps of this run are waiting for admission`)
    if (record.started + record.waiting >= this.options.limits.maxStepsPerRun) throw new HarnessSdkError('SWARM_WORKFLOW_STEP_LIMIT', `This run already started or queued ${this.options.limits.maxStepsPerRun} steps`)
    record.waiting++
    let admitted = false
    let lease: WorkflowBeeLease | undefined
    try {
      await this.slot()
      record.waiting--
      record.started++
      admitted = true
      const role = step.role ?? 'workflow'
      const backend = this.deps.resolveBackend(role)
      const poolKey = poolKeyFor(backend, step.model, step.instructions)
      lease = await this.pool!.acquire({
        role,
        name: step.name ?? `workflow-${role}`,
        ...(step.model !== undefined ? { model: step.model } : {}),
        ...(step.instructions !== undefined ? { instructions: step.instructions } : {}),
      }, poolKey, backend, this.ended.signal)
      const handle = this.deps.members.workflowDelegate(lease.beeId, {
        task: step.prompt,
        ...(step.context !== undefined ? { context: step.context } : {}),
        ...(step.constraints !== undefined ? { constraints: step.constraints } : {}),
        ...(step.expectedOutput !== undefined ? { expectedOutput: step.expectedOutput } : {}),
        ...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
      }, { runId: record.runId, ...(record.parentTaskId !== undefined ? { parentTaskId: record.parentTaskId } : {}), depth: record.depth })
      record.taskIds.add(handle.taskId)
      const outcome = await handle.outcome
      record.settled++
      return outcome.result ?? { status: 'failed', text: '', items: [], error: { code: 'SWARM_MEMBER_OUTCOME_UNKNOWN', message: 'The step task settled without a result', retryable: false, outcomeUnknown: true } }
    } finally {
      if (!admitted) record.waiting--
      lease?.release()
      if (admitted) this.releaseSlot()
    }
  }

  private async slot(): Promise<void> {
    if (this.turnEnded()) throw turnEndedError()
    if (this.running < this.options.limits.maxConcurrentSteps) { this.running++; return }
    await new Promise<void>((resolve, reject) => this.slotWaiters.push({ resolve, reject }))
    if (this.turnEnded()) throw turnEndedError()
  }

  private releaseSlot() {
    const waiter = this.slotWaiters.shift()
    if (waiter) waiter.resolve()
    else this.running = Math.max(0, this.running - 1)
  }

  /** Façade Client bound to one run; agent()/beer() with it execute as bees. */
  client(record: RunRecord): Client {
    const runner = this
    const delegate: SwarmWorkflowDelegate = {
      run: { runId: record.runId, depth: record.depth },
      get outputSchemaAdvertised() { return runner.options.outputSchema },
      turnEnded: () => runner.turnEnded(),
      step: step => runner.step(step, record),
    }
    const client = {
      identity: { adapterId: 'swarm-workflow', runtimeConfigId: `swarm-workflow:${record.workflowId}` },
      inputHookRevision: undefined,
      initialize: async () => { throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') },
      openSession: async () => { throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') },
      dispose: async () => {},
      sessions: {
        create: async (open: { cwd?: string; model?: string; instructions?: string; permissionMode?: string; config?: unknown }) => this.façadeSession(record, open),
        resume: async () => { throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') },
        fork: async () => { throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') },
      },
      [swarmWorkflowClient]: delegate,
    }
    return client as unknown as Client
  }

  private façadeSession(record: RunRecord, open: { cwd?: string; model?: string; instructions?: string; permissionMode?: string; config?: unknown }): object {
    if (open.permissionMode !== undefined) throw new HarnessSdkError('SWARM_OPTION_UNSUPPORTED', 'permissionMode is owned by the swarm session')
    if (open.config !== undefined) throw new HarnessSdkError('SWARM_OPTION_UNSUPPORTED', 'config is owned by the swarm session')
    if (open.cwd !== undefined && open.cwd !== this.deps.params.cwd) throw new HarnessSdkError('SWARM_OPTION_UNSUPPORTED', 'cwd is fixed to the swarm session working directory')
    const capabilities = { input: {}, turn: { inputModalities: ['text'] as const, ...(this.options.outputSchema ? { outputSchema: true } : {}) } }
    return {
      capabilities,
      submit: async (options: { input: string | unknown[]; outputSchema?: JsonSchema }) => {
        if (typeof options.input !== 'string') throw new HarnessSdkError('SWARM_OPTION_UNSUPPORTED', 'workflow sessions accept a plain text prompt')
        const result = await this.step({ prompt: options.input, model: open.model, instructions: open.instructions, ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}) }, record)
        return { result: async () => result }
      },
      close: async () => {},
      dispose: async () => {},
    }
  }
}
