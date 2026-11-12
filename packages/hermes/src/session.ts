import { setTimeout as delay } from 'node:timers/promises'
import { HarnessSdkError, type BackendSession, type SessionEventSink, type SessionMethod } from '@anureo/sdk'
import { assertRequest, type AhpRequestMap, type AhpResultMap, type Capabilities, type SessionBinding, type SessionOpenParams, type SessionState } from '@anureo/protocol'
import { attachGateway, type AttachMode } from './attach'
import { HermesRpc, type ServerRequest } from './rpc'
import { array, describe, event as nativeEvent, identity, integer, object, protocolError, publicReceipt, receipt, type Description, type NativeEvent, type NativeObject, type Receipt } from './native'
import { HermesTurn, sessionUsage } from './events'
import { HermesInteractions } from './interactions'
import type { HermesAdapterOptions } from './options'

export function hermesCapabilities(): Capabilities {
  return {
    session: { resume: true, fork: [], revert: [], history: false },
    input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { outputSchema: false, overrides: [], inputModalities: ['text'] },
    interactions: ['approval', 'userInput'], config: { options: [] },
  }
}
interface Submission { input: string; admission?: Receipt; acknowledged: boolean; rejected: boolean }
const recoverable = (cause: unknown): cause is HarnessSdkError => cause instanceof HarnessSdkError && ['CONNECTION_CLOSED', 'RPC_TIMEOUT', 'HARNESS_UNAVAILABLE', 'HERMES_REPLAY_GAP'].includes(cause.code)

export class HermesSession implements BackendSession {
  readonly capabilities = hermesCapabilities()
  binding: SessionBinding
  private nativeId = ''
  private rpc?: HermesRpc
  private description?: Description
  private subscriptionId = ''
  private cursor = { epoch: '', sequence: 0 }
  private readonly submissions = new Map<string, Submission>()
  private submissionBytes = 0
  private readonly turns = new Map<string, HermesTurn>()
  private readonly retired = new Set<string>()
  private readonly interactions: HermesInteractions
  private holding = true
  private held: Array<NativeEvent | ServerRequest> = []
  private heldBytes = 0
  private recovery?: Promise<void>
  private readonly ownerRecoveries: number[] = []
  private disposed = false
  private readonly abort = new AbortController()
  private title?: string
  private model?: string

  constructor(private readonly params: SessionOpenParams, private readonly sink: SessionEventSink, private readonly options: HermesAdapterOptions,
    private readonly profileId: string, private readonly released: () => void) {
    this.binding = structuredClone(params.binding)
    this.model = params.model
    this.interactions = new HermesInteractions(() => this.nativeId, () => this.channel(), sink,
      generation => [...this.turns.values()].find(value => value.epoch === this.description?.epoch && value.generation === generation)?.id,
      () => this.description!.epoch, options)
  }
  get state(): SessionState {
    return { binding: this.binding, status: this.disposed ? 'closed' : 'ready', config: {}, capabilities: this.capabilities,
      capabilityRevision: 0, activeTurnIds: [...this.turns.values()].filter(value => !value.terminal).map(value => value.id),
      ...(this.model ? { model: this.model } : {}), ...(this.title ? { metadata: { title: this.title } } : {}) }
  }
  async open(): Promise<void> {
    await this.connect(this.options.startup ?? 'start')
    const rpc = this.channel()
    let snapshot: NativeObject
    if (this.params.mode === 'new') {
      const params: NativeObject = { request_id: this.params.requestId, source: 'tool', cwd: this.params.cwd }
      if (this.params.model !== undefined) params.model = this.params.model
      if (this.description!.createParameters.includes('client')) params.client = { name: 'anureo-sdk', version: '0.2.0' }
      snapshot = object(await rpc.request('session.create', params, true))
    } else {
      if (this.binding.nativeRef?.provider !== 'hermes') throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
      snapshot = object(await rpc.request('session.resume', { session_id: identity(this.binding.nativeRef.value), omit_messages: true }))
    }
    await this.snapshot(snapshot)
    this.cursor = { epoch: identity(snapshot.replay_epoch), sequence: integer(snapshot.last_sequence) }
    await this.flush(false)
    this.holding = false
  }
  private channel(): HermesRpc {
    if (!this.rpc) throw new HarnessSdkError('NOT_INITIALIZED')
    return this.rpc
  }
  private async connect(mode: AttachMode): Promise<void> {
    const grant = await attachGateway(this.options, mode, this.abort.signal)
    if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
    if (grant.profileId !== this.profileId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    let channel: HermesRpc | undefined
    channel = await HermesRpc.connect(grant, {
      event: async value => { if (this.rpc === channel && !this.disposed) await this.receive(value) },
      request: async value => { if (this.rpc === channel && !this.disposed) await this.serverRequest(value) },
      failure: cause => {
        if (this.rpc !== channel || this.disposed) return
        if (!recoverable(cause) || (this.options.reconnectAttempts ?? 3) === 0) void this.sink.fail(cause)
        else void this.recover().catch(error => this.sink.fail(error))
      },
    }, this.options, this.abort.signal)
    if (this.disposed) { channel.dispose(); throw new HarnessSdkError('SESSION_CLOSED') }
    this.rpc = channel
    try { this.description = describe(await channel.request('runtime.describe'), grant) }
    catch (cause) { channel.dispose(); throw cause }
  }
  private hold(value: NativeEvent | ServerRequest): void {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.held.length >= (this.options.maxEvents ?? 2048) || this.heldBytes + bytes > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.held.push(value); this.heldBytes += bytes
  }
  private async serverRequest(request: ServerRequest): Promise<void> {
    if (this.holding) { this.hold(request); return }
    await this.interactions.serverRequest(request)
  }
  private async receive(event: NativeEvent): Promise<void> {
    if (this.holding) { this.hold(event); return }
    await this.apply(event)
  }
  private async flush(relaxed: boolean): Promise<void> {
    while (this.held.length) {
      const entries = this.held; this.held = []; this.heldBytes = 0
      for (const value of entries) {
        if ('method' in value) await this.interactions.serverRequest(value)
        else await this.apply(value, relaxed)
      }
    }
  }
  private turn(admission: string, epoch: number, generation: number): HermesTurn {
    const existing = this.turns.get(admission)
    if (existing) {
      if (existing.epoch !== epoch || existing.generation !== generation) throw protocolError()
      return existing
    }
    if (this.turns.size >= (this.options.maxExecutions ?? 128)) {
      const old = [...this.turns].find(([id, value]) => value.terminal && ![...this.submissions.values()].some(input => !input.acknowledged && (!input.admission || input.admission.id === id)))
      if (!old) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
      this.turns.delete(old[0]); this.retired.add(old[0])
      if (this.retired.size > 1024) this.retired.delete(this.retired.values().next().value!)
    }
    const turn = new HermesTurn(admission, epoch, generation, this.nativeId, this.sink, this.options)
    this.turns.set(admission, turn); return turn
  }
  private async associate(value: Receipt, submissionId?: string): Promise<HermesTurn | undefined> {
    const inputs = submissionId ? [[submissionId, this.submissions.get(submissionId)] as const]
      : [...this.submissions].filter(([, input]) => input.admission?.id === value.id)
    if (value.steering) {
      if (inputs.some(([, input]) => input)) throw new HarnessSdkError('HERMES_CORRELATION_UNSUPPORTED', 'A queued input was transferred by another viewer', false, true)
      return undefined
    }
    for (const [, input] of inputs) {
      if (!input) continue
      if (input.admission && input.admission.id !== value.id) throw protocolError()
      input.admission = value
    }
    if (value.status === 'unknown') throw new HarnessSdkError('HERMES_EXECUTION_UNKNOWN', 'Hermes execution outcome is unknown', false, true)
    if (value.generation === undefined) {
      if (value.status === 'terminal') for (const [id, input] of inputs) if (input && !input.rejected) {
        input.rejected = true
        await this.sink.emit({ type: 'submission/status', payload: { submissionId: id, status: 'rejected',
          error: { code: 'INPUT_CANCELLED', message: 'Hermes input cancelled before execution', retryable: false, outcomeUnknown: false } } })
      }
      return undefined
    }
    if (this.retired.has(value.id)) return undefined
    const turn = this.turn(value.id, value.epoch, value.generation)
    await turn.start()
    for (const [id, input] of inputs) if (input) await turn.bind(id, input.input)
    if (value.status === 'terminal' && !turn.terminal && value.result) await turn.fromReceipt(value.result, value.outcome)
    return turn
  }
  private parseReceipt(value: unknown): Receipt { return receipt(value, this.profileId, this.nativeId) }
  private async snapshot(snapshot: NativeObject): Promise<void> {
    this.nativeId = identity(snapshot.session_id)
    const info = object(snapshot.info)
    if (integer(snapshot.authority_epoch) !== this.description!.epoch || info.profile_id !== undefined && info.profile_id !== this.profileId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    this.subscriptionId = identity(snapshot.subscription_id)
    this.binding = { ...this.binding, nativeRef: { provider: 'hermes', value: this.nativeId } }
    if (typeof info.title === 'string') this.title = info.title
    if (typeof info.model === 'string') this.model = info.model
    for (const value of array(snapshot.pending)) {
      const pending = this.parseReceipt(value)
      // A second viewer's queue is native state, not a local SDK submission.
      await this.associate(pending, pending.inputId && this.submissions.has(pending.inputId) ? pending.inputId : undefined)
    }
    await this.interactions.snapshot(array(snapshot.prompts), snapshot.open_requests == null ? [] : array(snapshot.open_requests))
  }
  private async apply(event: NativeEvent, relaxed = false): Promise<void> {
    if (event.session_id !== this.nativeId) return
    if (event.type === 'session.replay_gap') throw new HarnessSdkError('HERMES_REPLAY_GAP', 'Hermes event replay is required', false, true)
    const epoch = identity(event.replay_epoch), sequence = integer(event.seq)
    if (epoch === this.cursor.epoch && sequence <= this.cursor.sequence) return
    if (epoch !== this.cursor.epoch || sequence !== this.cursor.sequence + 1) {
      if (!relaxed) throw new HarnessSdkError('HERMES_REPLAY_GAP', 'Hermes event sequence changed', false, true)
      for (const turn of this.turns.values()) await turn.gap()
    }
    const payload = event.payload
    if (event.type === 'session.info') {
      if (Array.isArray(payload.pending)) for (const value of payload.pending) {
        const pending = this.parseReceipt(value)
        await this.associate(pending, pending.inputId && this.submissions.has(pending.inputId) ? pending.inputId : undefined)
      }
      if (typeof payload.title === 'string') {
        this.title = payload.title
        await this.sink.emit({ type: 'session/metadata', payload: { title: payload.title } })
      }
    } else if (event.type === 'approval.request' || event.type === 'clarify.request') {
      await this.interactions.prompt({ ...payload, kind: event.type === 'approval.request' ? 'approval' : 'clarify', authority_epoch: event.authority_epoch ?? this.description!.epoch })
    } else if (event.type === 'approval.settled' || event.type === 'clarify.settled') {
      await this.interactions.settled(identity(payload.prompt_id), 'prompt', 'resolved', integer(payload.execution_generation))
    } else if (event.type === 'request.cancel') {
      await this.interactions.settled(identity(payload.id), 'request', identity(payload.reason))
    } else if (event.type === 'session.usage') {
      if (payload.usage != null) await sessionUsage(this.sink, object(payload.usage))
    } else if (['message.start', 'message.delta', 'message.interim', 'message.complete', 'reasoning.delta', 'tool.start', 'tool.complete'].includes(event.type)) {
      const admissionId = identity(event.admission_id ?? payload.admission_id)
      if (!this.retired.has(admissionId)) {
        const generation = event.execution_generation
        if (generation === undefined) {
          // A cancelled FIFO row has a terminal frame but never had a native execution.
          if (event.type !== 'message.complete' || payload.outcome !== 'cancelled') throw protocolError()
          for (const [id, input] of this.submissions) if (input.admission?.id === admissionId) {
            await this.associate({ ...input.admission, status: 'terminal', outcome: 'cancelled' }, id)
          }
        } else {
          const turn = this.turn(admissionId, integer(event.authority_epoch), generation)
          const submissionId = payload.persisted_turn == null ? undefined : object(payload.persisted_turn).submission_id
          if (typeof submissionId === 'string' && this.submissions.has(submissionId)) {
            const input = this.submissions.get(submissionId)!
            await this.associate({ id: admissionId, sequence: input.admission?.sequence ?? 0, status: 'started', outcome: null, epoch: turn.epoch, generation }, submissionId)
          }
          if (event.type === 'message.complete') await this.interactions.waitResponders()
          await turn.apply(event)
          if (turn.terminal) for (const input of this.submissions.values()) if (input.admission?.id === admissionId && input.acknowledged) this.releaseInput(input)
        }
      }
    } else if (event.type === 'error') {
      // A bare error does not identify an execution's terminal state.
      throw new HarnessSdkError('HERMES_REPLAY_GAP', 'Hermes execution requires reconciliation', false, true)
    }
    this.cursor = { epoch, sequence }
  }
  private async ready(): Promise<void> {
    if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
    if (this.recovery) await this.recovery
    else if (!this.channel().connected) await this.recover()
    if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
  }
  private recover(): Promise<void> {
    if (this.recovery) return this.recovery
    this.holding = true
    const old = this.channel(); old.dispose()
    const task = (async () => {
      await old.finished
      let last: unknown = new HarnessSdkError('CONNECTION_CLOSED', 'Hermes connection lost', false, true)
      const attempts = this.options.reconnectAttempts ?? 3
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
        if (attempt) await delay((this.options.reconnectDelayMs ?? 100) * 2 ** (attempt - 1), undefined, { signal: this.abort.signal })
        try {
          let mode: AttachMode = 'attach'
          if (attempt && this.options.startup !== 'attach') {
            while (this.ownerRecoveries.length && this.ownerRecoveries[0]! < Date.now() - 60_000) this.ownerRecoveries.shift()
            if (this.ownerRecoveries.length >= (this.options.maxOwnerRecoveriesPerMinute ?? 2)) throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes owner recovery limit reached')
            this.ownerRecoveries.push(Date.now()); mode = 'recover'
          }
          this.held = []; this.heldBytes = 0
          await this.connect(mode)
          const rpc = this.channel()
          const replay = object(await rpc.request('session.events.since', { session_id: this.nativeId, replay_epoch: this.cursor.epoch, last_sequence: this.cursor.sequence }))
          if (typeof replay.snapshot_required !== 'boolean') throw protocolError()
          if (!replay.snapshot_required) for (const value of array(replay.events)) await this.apply(nativeEvent(value))
          const snapshot = object(await rpc.request('session.resume', { session_id: this.nativeId, omit_messages: true }))
          const gap = replay.snapshot_required || snapshot.replay_epoch !== this.cursor.epoch
          if (gap) {
            for (const turn of this.turns.values()) await turn.gap()
            this.cursor = { epoch: identity(snapshot.replay_epoch), sequence: 0 }
          }
          await this.snapshot(snapshot)
          await this.flush(gap)
          const watermark = integer(snapshot.last_sequence)
          if (this.cursor.sequence < watermark) {
            for (const turn of this.turns.values()) await turn.gap()
            this.cursor = { epoch: identity(snapshot.replay_epoch), sequence: watermark }
          }
          const admissions = new Set([...this.submissions.values()].filter(value => !value.rejected).map(value => value.admission?.id).filter((id): id is string => !!id))
          for (const turn of this.turns.values()) if (!turn.terminal) admissions.add(turn.admissionId)
          for (const id of admissions) {
            if (this.turns.get(id)?.terminal) continue
            const current = this.parseReceipt(await rpc.request('prompt.receipt', { session_id: this.nativeId, admission_id: id, include_result: true }))
            const turn = await this.associate(current)
            if (current.status === 'terminal' && turn && !turn.terminal) throw new HarnessSdkError('HERMES_RESULT_UNAVAILABLE', 'Hermes terminal result was unavailable', false, true)
          }
          await this.flush(gap)
          this.holding = false; return
        } catch (cause) {
          this.rpc?.dispose(); last = cause
          if (!recoverable(cause)) throw cause
        }
      }
      throw last
    })()
    this.recovery = task
    void task.finally(() => { if (this.recovery === task) this.recovery = undefined }).catch(() => {})
    return task
  }
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    assertRequest(method, params)
    if (params.sessionId !== this.binding.sessionId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    if (method === 'input/submit') return await this.submit(params as AhpRequestMap['input/submit']) as AhpResultMap[M]
    if (method === 'session/close') {
      try {
        if (this.channel().connected) await this.channel().request('session.detach', { session_id: this.nativeId, subscription_id: this.subscriptionId })
      } catch { this.options.diagnostic?.('HERMES_DETACH_UNCONFIRMED') }
      await this.dispose()
      return { closed: true, observationClosed: true, executionStopped: 'unconfirmed' } as AhpResultMap[M]
    }
    if (method === 'turn/interrupt') {
      await this.ready()
      const request = params as AhpRequestMap['turn/interrupt']
      const turn = [...this.turns.values()].find(value => value.id === request.turnId)
      if (!turn || turn.terminal || turn.epoch !== this.description!.epoch) throw new HarnessSdkError('TURN_NOT_ACTIVE')
      const response = object(await this.channel().request('session.interrupt', { session_id: this.nativeId, execution_generation: turn.generation }, true))
      const ref = object(response.ref)
      if (ref.session_id !== this.nativeId || ref.profile_id !== this.profileId || response.execution_generation !== turn.generation || response.authority_epoch !== turn.epoch) throw protocolError()
      return { accepted: true, turnId: turn.id } as AhpResultMap[M]
    }
    throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
  }
  private async submit(params: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (params.delivery !== 'native' || params.outputSchema !== undefined || params.input.some(value => value.type !== 'text') || Object.keys(params.overrides ?? {}).length) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    await this.ready()
    if (this.submissions.has(params.submissionId)) throw new HarnessSdkError('SUBMISSION_ID_CONFLICT')
    if (this.submissions.size >= (this.options.maxSubmissions ?? 1024)) {
      const old = [...this.submissions].find(([, value]) => value.acknowledged && (value.rejected || value.admission && (this.turns.get(value.admission.id)?.terminal || this.retired.has(value.admission.id))))
      if (!old) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
      this.releaseInput(old[1])
      this.submissions.delete(old[0])
    }
    const input: Submission = { input: params.input.map(value => value.type === 'text' ? value.text : '').join('\n'), acknowledged: false, rejected: false }
    const bytes = Buffer.byteLength(input.input)
    if (this.submissionBytes + bytes > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.submissionBytes += bytes
    this.submissions.set(params.submissionId, input)
    try {
      let native: Receipt
      try {
        native = this.parseReceipt(await this.channel().request('prompt.submit', { session_id: this.nativeId, text: input.input, submission_id: params.submissionId }, true))
      } catch (cause) {
        if (!recoverable(cause) || (this.options.reconnectAttempts ?? 3) === 0) throw cause
        try { await this.recover() } catch (recovery) {
          const code = recovery instanceof HarnessSdkError ? recovery.code : 'CONNECTION_CLOSED'
          throw new HarnessSdkError(code, 'Hermes submission outcome is unknown after reconnect', false, true)
        }
        if (!input.admission) throw new HarnessSdkError('RESULT_UNKNOWN', 'Hermes submission outcome is unknown; do not resend', false, true)
        native = input.admission
      }
      let turn = await this.associate(native, params.submissionId)
      if (native.status === 'terminal' && turn && !turn.terminal) {
        native = this.parseReceipt(await this.channel().request('prompt.receipt', { session_id: this.nativeId, admission_id: native.id, include_result: true }))
        turn = await this.associate(native, params.submissionId)
        if (!turn?.terminal) throw new HarnessSdkError('HERMES_RESULT_UNAVAILABLE', 'Hermes terminal result was unavailable', false, true)
      }
      if (input.rejected) throw new HarnessSdkError('INPUT_CANCELLED')
      return turn ? { submissionId: params.submissionId, accepted: true, disposition: 'started', turnId: turn.id, receipt: publicReceipt(native) }
        : { submissionId: params.submissionId, accepted: true, disposition: 'queued', receipt: publicReceipt(native) }
    } catch (cause) {
      if (cause instanceof HarnessSdkError && !cause.outcomeUnknown) input.rejected = true
      throw cause
    } finally {
      input.acknowledged = true
      if (input.rejected || input.admission && this.turns.get(input.admission.id)?.terminal) this.releaseInput(input)
    }
  }
  private releaseInput(input: Submission): void { this.submissionBytes -= Buffer.byteLength(input.input); input.input = '' }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.abort.abort(); this.rpc?.dispose(); this.held = []; this.heldBytes = 0
    for (const input of this.submissions.values()) this.releaseInput(input)
    this.submissions.clear(); this.turns.clear(); this.retired.clear()
    this.released()
  }
}
