import { randomUUID } from 'node:crypto'
import { HarnessSdkError, type BackendSession, type Session, type SessionEventSink, type SessionMethod, type TurnResult } from '@anureo/sdk'
import type { AhpRequestMap, AhpResultMap, Capabilities, SessionOpenParams, TurnCompletedEvent } from '@anureo/protocol'
import { relayMessages } from './events'
import { executionError, releaseSession, SwarmExecution } from './execution'
import type { BeeProfileRegistry, BeeProfileScope } from './profiles'
import type { BeeManager } from './bee-manager'
import type { ManagementBridgeLease } from './management-bridge'
import { parseWorkflowDirective, type WorkflowRunner } from './workflow/runner'

type ActiveTurn = { id: string; execution: SwarmExecution; done: Promise<void> }
type Terminal = Omit<TurnCompletedEvent['payload'], 'turnId'>

function assignmentFailure(code: string, message: string): TurnResult {
  return { status: 'failed', text: '', items: [], error: { code, message, retryable: false, outcomeUnknown: false } }
}

export class SwarmSession implements BackendSession {
  readonly binding
  private active?: ActiveTurn
  private closing?: Promise<AhpResultMap['session/close']>
  private uncertain = false

  constructor(
    private readonly params: SessionOpenParams,
    private readonly sink: SessionEventSink,
    readonly capabilities: Capabilities,
    private readonly main: Session,
    private readonly members: BeeManager,
    private readonly bridge: ManagementBridgeLease,
    private readonly profiles: BeeProfileRegistry,
    private readonly onClosed: () => void,
    private readonly runner?: WorkflowRunner,
  ) {
    this.binding = params.binding
  }

  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    if (method === 'session/close') return await this.close() as AhpResultMap[M]
    if (method === 'turn/interrupt') {
      const { turnId } = params as AhpRequestMap['turn/interrupt']
      if (this.active?.id !== turnId) throw new HarnessSdkError('TURN_MISMATCH')
      this.active.execution.cancel()
      this.members.stop()
      return { accepted: true, turnId } as AhpResultMap[M]
    }
    if (method === 'input/submit') return await this.accept(params as AhpRequestMap['input/submit']) as AhpResultMap[M]
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
  }

  private async accept({ input, submissionId }: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (this.closing) throw new HarnessSdkError('SESSION_CLOSED')
    if (this.uncertain) throw new HarnessSdkError('SWARM_RECOVERY_REQUIRED', 'Close this session before starting another execution')
    if (this.active) throw new HarnessSdkError('SESSION_BUSY')
    const id = randomUUID()
    const execution = new SwarmExecution()
    const accepted = this.sink.emit({ type: 'turn/started', payload: { turnId: id } })
      .then(() => this.sink.bindSubmission(submissionId, id))
    const done = accepted
      .then(() => this.finish(id, execution, input))
      .catch(cause => {
        this.uncertain = true
        if (this.active?.id === id) this.active = undefined
        // SDK failure can dispose this backend, which awaits done.
        void this.sink.fail(cause).catch(() => {})
      })
    this.active = { id, execution, done }
    await accepted
    return { submissionId, disposition: 'dispatched' }
  }

  private async finish(id: string, execution: SwarmExecution, input: AhpRequestMap['input/submit']['input']) {
    const text = input.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    let terminal: Terminal
    try {
      const result = await this.run(id, execution, input, text)
      const error = result.status === 'completed' ? undefined : result.error
      terminal = {
        status: execution.stopped && !error?.outcomeUnknown ? 'interrupted' : result.status,
        ...(error ? { error } : {}),
      }
    } catch (cause) {
      const error = executionError(cause)
      terminal = execution.stopped && !error.outcomeUnknown ? { status: 'interrupted' } : { status: 'failed', error }
    }
    this.uncertain ||= terminal.error?.outcomeUnknown === true || this.members.uncertain
    await this.members.afterTurn(id, terminal.status)
    this.active = undefined
    await this.sink.emit({ type: 'turn/completed', payload: { turnId: id, ...terminal } })
  }

  private async run(id: string, execution: SwarmExecution, input: AhpRequestMap['input/submit']['input'], text: string): Promise<TurnResult> {
    this.members.begin(id)
    this.runner?.beginTurn()
    const directive = this.runner ? parseWorkflowDirective(text) : undefined
    try {
      if (directive === 'invalid') {
        return assignmentFailure('SWARM_INVALID_ARGUMENTS', 'Malformed /workflow directive; use /workflow list, /workflow run <id> [json] or /workflow resume <id> <runId>')
      }
      if (directive) {
        const result = await this.runner!.runHostDirective(directive)
        // The outer TurnResult text is derived from final items: publish the run payload as one.
        if (result.text !== undefined) {
          const item = { id: randomUUID(), type: 'agentMessage' as const, phase: 'final' as const, text: result.text }
          await this.sink.emit({ type: 'item/started', payload: { item: { ...item, text: '' } } }, { turnId: id })
          await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: id })
        }
        return result
      }
      const mention = /^\s*@(?:(user|project)\/)?([a-z][a-z0-9-]{0,39})(?=\s|$)/.exec(text)
      const request = mention ? text.slice(mention[0].length).trim() : text
      const registration = mention && this.profiles.resolve(mention[2], mention[1] as BeeProfileScope | undefined)
      const label = mention && `${mention[1] ? mention[1] + '/' : ''}${mention[2]}`
      if (mention && !registration) return assignmentFailure('SWARM_UNKNOWN_BEE', `Unknown fixed bee @${label}`)
      if (mention && !request) return assignmentFailure('SWARM_BEE_TASK_REQUIRED', `Provide a task after @${label}`)
      const result = await execution.submit(this.main, {
        input: mention ? `Delegate this request to fixed bee ${mention[2]}${registration?.source ? ` with profileScope=${registration.source.scope}` : ''} before answering.\n${request}` : input,
      }, relayMessages(this.sink, id))
      return result
    } finally {
      await this.settle(id)
    }
  }

  private async settle(id: string) {
    await this.members.settle()
    await this.runner?.settleTurn()
    if (this.members.uncertain) throw new HarnessSdkError('SWARM_MEMBER_OUTCOME_UNKNOWN', undefined, false, true)
  }

  private close() {
    return this.closing ??= (async () => {
      const active = this.active
      active?.execution.cancel()
      this.members.stop()
      await active?.done
      const cleanup = await Promise.allSettled([this.members.close(), this.runner ? this.runner.close() : Promise.resolve(), releaseSession(this.main), this.bridge.dispose()])
      this.onClosed()
      if (cleanup.some(result => result.status === 'rejected')) throw new HarnessSdkError('RESOURCE_RELEASE_FAILED')
      return {
        closed: true as const,
        observationClosed: true as const,
        executionStopped: (this.uncertain || this.members.uncertain) ? 'unconfirmed' as const : 'confirmed' as const,
      }
    })()
  }

  async dispose() {
    await this.close()
  }
}
