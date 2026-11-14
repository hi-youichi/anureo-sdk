import { setTimeout as delay } from 'node:timers/promises'
import { HarnessSdkError, type BackendSession, type SessionEventSink, type SessionMethod } from '@anureo/sdk'
import { assertRequest, type AhpRequestMap, type AhpResultMap, type Capabilities, type SessionBinding, type SessionOpenParams, type SessionState } from '@anureo/protocol'
import { attachGateway, type AttachMode } from './attach'
import { HermesRpc, type ServerRequest } from './rpc'
import { array, describe, event as nativeEvent, identity, integer, object, protocolError, publicReceipt, receipt, type Description, type NativeEvent, type NativeObject, type Receipt } from './native'
import { HermesTurn, sessionUsage } from './events'
import { HermesInteractions } from './interactions'
import type { HermesAdapterOptions } from './options'

/** Return a fresh native capability snapshot for HermesAdapter.initialize and each HermesSession. */
export function hermesCapabilities(): Capabilities {
  return {
    session: { resume: true, fork: [], revert: [], history: false },
    input: { delivery: ['native'], interrupt: { targets: ['turn'], reportsPendingInputs: false } },
    turn: { outputSchema: false, overrides: [], inputModalities: ['text'] },
    interactions: ['approval', 'userInput'], config: { options: [] },
  }
}
/**
 * Internal BackendSession owned by HermesAdapter.openSession and adopted by OutputSession.open.
 * Reconcile durable admissions and replay before releasing live traffic; native acceptance and turn
 * completion remain independent. The owner must dispose this observation, including after open fails.
 */
export class HermesSession implements BackendSession {
  readonly capabilities = hermesCapabilities()
  /** SDK identity augmented with the native reference after snapshot validation. */
  binding: SessionBinding

  /** Register lazy interaction callbacks; open must establish a description before they are invoked. */
  constructor({ params, sink, options, profileId, released }: {
    params: SessionOpenParams
    sink: SessionEventSink
    options: HermesAdapterOptions
    profileId: string
    /** Remove this handle from HermesAdapter's tracked sessions when local disposal finishes. */
    released: () => void
  }) {
    this.params = params; this.sink = sink; this.options = options; this.profileId = profileId; this.released = released
    this.binding = structuredClone(params.binding)
    this.model = params.model
    this.interactions = new HermesInteractions({ sessionId: () => this.nativeId, rpc: () => this.channel(), sink,
      turnId: generation => [...this.turns.values()].find(value => value.epoch === this.description?.epoch && value.generation === generation)?.id,
      epoch: () => this.description!.epoch, options })
  }
  /** Attachment snapshot consumed by Session.attach, including executions restored from native pending rows. */
  get state(): SessionState {
    return { binding: this.binding, status: this.disposed ? 'closed' : 'ready', config: {}, capabilities: this.capabilities,
      capabilityRevision: 0, activeTurnIds: [...this.turns.values()].filter(value => !value.terminal).map(value => value.id),
      ...(this.model ? { model: this.model } : {}), ...(this.title ? { metadata: { title: this.title } } : {}) }
  }
  /**
   * HermesAdapter.openSession awaits connection, creation/resume, snapshot projection and held events.
   * Reject native/validation/publication failures; the adapter disposes partial setup before rethrowing.
   */
  async open(): Promise<void> {
    await this.connect(this.options.startup ?? 'start')
    const rpc = this.channel()
    const snapshot = await this.openSnapshot(rpc)
    await this.snapshot(snapshot)
    this.cursor = { epoch: identity(snapshot.replay_epoch), sequence: integer(snapshot.last_sequence) }
    await this.flush('contiguous')
    this.holding = false
  }
  /**
   * OutputSession.execute awaits native receipts here, while sink events may arrive independently.
   * Close detaches observation without stopping execution; interrupt validates the active generation.
   * Reject unsupported requests and native failures, preserving unknown-outcome submission errors.
   */
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
  /** Idempotently abort local work, drop retained evidence and release adapter tracking; native execution is left running. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.abort.abort(); this.rpc?.dispose(); this.held = []; this.heldBytes = 0
    for (const input of this.submissions.values()) this.releaseInput(input)
    this.submissions.clear(); this.turns.clear(); this.retired.clear()
    this.released()
  }

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
  /** Build new-session configuration only after capability discovery; resume never replays editor configuration. */
  private async openSnapshot(rpc: HermesRpc): Promise<NativeObject> {
    if (this.params.mode === 'new') return object(await rpc.request('session.create', this.createParameters(), true))
    if (this.binding.nativeRef?.provider !== 'hermes') throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    return object(await rpc.request('session.resume', { session_id: identity(this.binding.nativeRef.value), omit_messages: true }))
  }
  /** Preserve omission of toolsets/model and opt into ACP only for explicitly supplied session MCP servers. */
  private createParameters(): NativeObject {
    if (this.options.toolsets !== undefined && !this.description!.createParameters.includes('toolsets')) throw new HarnessSdkError('HERMES_GATEWAY_UNSUPPORTED', 'Hermes gateway does not support explicit toolsets')
    const params: NativeObject = { request_id: this.params.requestId, source: 'tool', cwd: this.params.cwd }
    if (this.params.mcpServers !== undefined) {
      if (!this.description!.editorMcp) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
      // The gateway accepts session-scoped MCP only on its editor (ACP) surface.
      params.source = 'acp'
      params.editor = { edit_approval_policy: 'ask', mcp_servers: this.params.mcpServers.map(server => server.type === 'stdio'
        ? { name: server.name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) }
        : { type: 'http', name: server.name, url: server.url, headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })) }) }
    }
    if (this.options.toolsets !== undefined) params.toolsets = [...this.options.toolsets]
    if (this.params.model !== undefined) params.model = this.params.model
    if (this.description!.createParameters.includes('client')) params.client = { name: 'anureo-sdk', version: '0.2.0' }
    return params
  }
  /** Require local channel setup; connectedness and recovery are checked separately by ready. */
  private channel(): HermesRpc {
    if (!this.rpc) throw new HarnessSdkError('NOT_INITIALIZED')
    return this.rpc
  }
  /**
   * Attach and describe the expected profile. RPC invokes these serial event/request callbacks only
   * for the current channel; its failure callback either starts recovery or ends observation via sink.fail.
   * The session owns successful channels and disposes them on retry or teardown.
   */
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
  /** Bound live traffic held during setup/recovery; overflow throws rather than silently dropping correlation evidence. */
  private hold(value: NativeEvent | ServerRequest): void {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (this.held.length >= (this.options.maxEvents ?? 2048) || this.heldBytes + bytes > (this.options.maxBufferedBytes ?? 16 * 1024 * 1024)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    this.held.push(value); this.heldBytes += bytes
  }
  /** RPC's request callback buffers during reconciliation, otherwise registers a nonblocking interaction. */
  private async serverRequest(request: ServerRequest): Promise<void> {
    if (this.holding) { this.hold(request); return }
    await this.interactions.serverRequest(request)
  }
  /** RPC's event callback buffers during reconciliation, otherwise awaits ordered projection. */
  private async receive(event: NativeEvent): Promise<void> {
    if (this.holding) { this.hold(event); return }
    await this.apply(event)
  }
  /** Drain held batches, including traffic arriving during awaits; only snapshot recovery tolerates replay discontinuity. */
  private async flush(continuity: ReplayContinuity): Promise<void> {
    while (this.held.length) {
      const entries = this.held; this.held = []; this.heldBytes = 0
      for (const value of entries) {
        if ('method' in value) await this.interactions.serverRequest(value)
        else await this.apply(value, continuity)
      }
    }
  }
  /** Reuse an execution only with matching authority/generation; evict terminal turns only when unacknowledged inputs cannot need them. */
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
    const turn = new HermesTurn({ admissionId: admission, epoch, generation, sessionId: this.nativeId, sink: this.sink, options: this.options })
    this.turns.set(admission, turn); return turn
  }
  /**
   * Match receipt evidence to local inputs, publish bindings and project any supplied terminal result.
   * Receipts without an execution generation create no turn; unknown execution or transferred local input
   * rejects with outcome uncertainty. Snapshot, event, submit and recovery paths all use this rule.
   */
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
  /** Validate admission evidence against this observation's profile and native session. */
  private parseReceipt(value: unknown): Receipt { return receipt(value, this.profileId, this.nativeId) }
  /** Adopt validated attachment identity/metadata, then reconcile native pending rows and interactions before releasing held traffic. */
  private async snapshot(snapshot: NativeObject): Promise<void> {
    this.nativeId = identity(snapshot.session_id)
    const info = object(snapshot.info)
    if (integer(snapshot.authority_epoch) !== this.description!.epoch || info.profile_id !== undefined && info.profile_id !== this.profileId) throw new HarnessSdkError('SESSION_BINDING_MISMATCH')
    this.subscriptionId = identity(snapshot.subscription_id)
    this.binding = { ...this.binding, nativeRef: { provider: 'hermes', value: this.nativeId } }
    if (typeof info.title === 'string') this.title = info.title
    if (typeof info.model === 'string') this.model = info.model
    for (const value of array(snapshot.pending)) {
      await this.associatePending(value)
    }
    await this.interactions.snapshot(array(snapshot.prompts), snapshot.open_requests == null ? [] : array(snapshot.open_requests))
  }
  /** Keep another viewer's queue as native state, associating input ids only when this session submitted them. */
  private async associatePending(value: unknown): Promise<void> {
    const pending = this.parseReceipt(value)
    await this.associate(pending, pending.inputId && this.submissions.has(pending.inputId) ? pending.inputId : undefined)
  }
  /** Validate replay continuity before dispatch and advance the cursor only after all resulting publications succeed. */
  private async apply(event: NativeEvent, continuity: ReplayContinuity = 'contiguous'): Promise<void> {
    if (event.session_id !== this.nativeId) return
    if (event.type === 'session.replay_gap') throw new HarnessSdkError('HERMES_REPLAY_GAP', 'Hermes event replay is required', false, true)
    const epoch = identity(event.replay_epoch), sequence = integer(event.seq)
    if (epoch === this.cursor.epoch && sequence <= this.cursor.sequence) return
    if (epoch !== this.cursor.epoch || sequence !== this.cursor.sequence + 1) {
      if (continuity === 'contiguous') throw new HarnessSdkError('HERMES_REPLAY_GAP', 'Hermes event sequence changed', false, true)
      await this.reportProgressGap()
    }
    const payload = event.payload
    if (event.type === 'session.info') {
      if (Array.isArray(payload.pending)) for (const value of payload.pending) await this.associatePending(value)
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
      await this.applyTurnEvent(event)
    } else if (event.type === 'error') {
      // A bare error does not identify an execution's terminal state.
      throw new HarnessSdkError('HERMES_REPLAY_GAP', 'Hermes execution requires reconciliation', false, true)
    }
    this.cursor = { epoch, sequence }
  }
  /**
   * Associate native execution evidence before projecting progress. A terminal event waits only for
   * responders already delivering answers, so their ACK/settlement can precede turn completion.
   */
  private async applyTurnEvent(event: NativeEvent): Promise<void> {
    const payload = event.payload
    const admissionId = identity(event.admission_id ?? payload.admission_id)
    if (this.retired.has(admissionId)) return
    const generation = event.execution_generation
    if (generation === undefined) {
      // A cancelled FIFO row has a terminal frame but never had a native execution.
      if (event.type !== 'message.complete' || payload.outcome !== 'cancelled') throw protocolError()
      for (const [id, input] of this.submissions) if (input.admission?.id === admissionId) {
        await this.associate({ ...input.admission, status: 'terminal', outcome: 'cancelled' }, id)
      }
      return
    }
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
  /** Await any current recovery, or start one for a disconnected channel, before dispatching another request. */
  private async ready(): Promise<void> {
    if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
    if (this.recovery) await this.recovery
    else if (!this.channel().connected) await this.recover()
    if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
  }
  /** Share one recovery across RPC failure callbacks and request paths; keep live traffic held until reconciliation succeeds. */
  private recover(): Promise<void> {
    if (this.recovery) return this.recovery
    this.holding = true
    const old = this.channel(); old.dispose()
    const task = this.retryRecovery(old)
    this.recovery = task
    void task.finally(() => { if (this.recovery === task) this.recovery = undefined }).catch(() => {})
    return task
  }
  /** Finish the old serial reader before retrying; backoff is abortable and failed attempts dispose their channels. */
  private async retryRecovery(old: HermesRpc): Promise<void> {
    await old.finished
    let last: unknown = new HarnessSdkError('CONNECTION_CLOSED', 'Hermes connection lost', false, true)
    const attempts = this.options.reconnectAttempts ?? 3
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.disposed) throw new HarnessSdkError('SESSION_CLOSED')
      if (attempt) await delay((this.options.reconnectDelayMs ?? 100) * 2 ** (attempt - 1), undefined, { signal: this.abort.signal })
      try {
        const mode = this.recoveryMode(attempt)
        this.held = []; this.heldBytes = 0
        await this.connect(mode)
        const rpc = this.channel()
        const continuity = await this.replaySnapshot(rpc)
        await this.reconcileAdmissions(rpc)
        await this.flush(continuity)
        this.holding = false
        return
      } catch (cause) {
        this.rpc?.dispose(); last = cause
        if (!recoverable(cause)) throw cause
      }
    }
    throw last
  }
  /** Try attachment first; subsequent attempts may request owner recovery within the rolling per-session budget. */
  private recoveryMode(attempt: number): AttachMode {
    if (!attempt || this.options.startup === 'attach') return 'attach'
    while (this.ownerRecoveries.length && this.ownerRecoveries[0]! < Date.now() - 60_000) this.ownerRecoveries.shift()
    if (this.ownerRecoveries.length >= (this.options.maxOwnerRecoveriesPerMinute ?? 2)) throw new HarnessSdkError('HARNESS_UNAVAILABLE', 'Hermes owner recovery limit reached')
    this.ownerRecoveries.push(Date.now())
    return 'recover'
  }
  /** Replay available events, reconcile the resume snapshot and watermark, then select continuity for the final held batch. */
  private async replaySnapshot(rpc: HermesRpc): Promise<ReplayContinuity> {
    const replay = object(await rpc.request('session.events.since', { session_id: this.nativeId, replay_epoch: this.cursor.epoch, last_sequence: this.cursor.sequence }))
    if (typeof replay.snapshot_required !== 'boolean') throw protocolError()
    if (!replay.snapshot_required) for (const value of array(replay.events)) await this.apply(nativeEvent(value))
    const snapshot = object(await rpc.request('session.resume', { session_id: this.nativeId, omit_messages: true }))
    const gap = replay.snapshot_required || snapshot.replay_epoch !== this.cursor.epoch
    if (gap) {
      await this.reportProgressGap()
      this.cursor = { epoch: identity(snapshot.replay_epoch), sequence: 0 }
    }
    await this.snapshot(snapshot)
    const continuity = gap ? 'snapshot' : 'contiguous'
    await this.flush(continuity)
    const watermark = integer(snapshot.last_sequence)
    if (this.cursor.sequence < watermark) {
      await this.reportProgressGap()
      this.cursor = { epoch: identity(snapshot.replay_epoch), sequence: watermark }
    }
    return continuity
  }
  /** Recover terminal evidence for known admissions without resubmitting input or declaring missing results complete. */
  private async reconcileAdmissions(rpc: HermesRpc): Promise<void> {
    const admissions = new Set([...this.submissions.values()].filter(value => !value.rejected).map(value => value.admission?.id).filter((id): id is string => !!id))
    for (const turn of this.turns.values()) if (!turn.terminal) admissions.add(turn.admissionId)
    for (const id of admissions) {
      if (this.turns.get(id)?.terminal) continue
      const current = await this.resultReceipt(rpc, id)
      const turn = await this.associate(current)
      if (current.status === 'terminal' && turn && !turn.terminal) throw new HarnessSdkError('HERMES_RESULT_UNAVAILABLE', 'Hermes terminal result was unavailable', false, true)
    }
  }
  /** Fetch and validate result-bearing receipt evidence for both submit completion and recovery reconciliation. */
  private async resultReceipt(rpc: HermesRpc, admissionId: string): Promise<Receipt> {
    return this.parseReceipt(await rpc.request('prompt.receipt', { session_id: this.nativeId, admission_id: admissionId, include_result: true }))
  }
  /** Mark every retained live turn's intermediate progress incomplete; each turn emits at most one notice. */
  private async reportProgressGap(): Promise<void> {
    for (const turn of this.turns.values()) await turn.gap()
  }
  /** Retain input through acknowledgement/association, dispatch once, and release text after rejection or terminal evidence. */
  private async submit(params: AhpRequestMap['input/submit']): Promise<AhpResultMap['input/submit']> {
    if (params.delivery !== 'native' || params.outputSchema !== undefined || params.input.some(value => value.type !== 'text') || Object.keys(params.overrides ?? {}).length) throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    await this.ready()
    const input = this.retainInput(params)
    try {
      let native = await this.submitReceipt(params.submissionId, input)
      let turn = await this.associate(native, params.submissionId)
      if (native.status === 'terminal' && turn && !turn.terminal) {
        native = await this.resultReceipt(this.channel(), native.id)
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
  /** Enforce identity/count/byte budgets before native dispatch, evicting only acknowledged inputs with known outcomes. */
  private retainInput(params: AhpRequestMap['input/submit']): Submission {
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
    return input
  }
  /** On lost submit acknowledgement, recover existing evidence once; uncertain acceptance must never cause a resend. */
  private async submitReceipt(submissionId: string, input: Submission): Promise<Receipt> {
    try {
      return this.parseReceipt(await this.channel().request('prompt.submit', { session_id: this.nativeId, text: input.input, submission_id: submissionId }, true))
    } catch (cause) {
      if (!recoverable(cause) || (this.options.reconnectAttempts ?? 3) === 0) throw cause
      try { await this.recover() } catch (recovery) {
        const code = recovery instanceof HarnessSdkError ? recovery.code : 'CONNECTION_CLOSED'
        throw new HarnessSdkError(code, 'Hermes submission outcome is unknown after reconnect', false, true)
      }
      if (!input.admission) throw new HarnessSdkError('RESULT_UNKNOWN', 'Hermes submission outcome is unknown; do not resend', false, true)
      return input.admission
    }
  }
  /** Release retained text idempotently without discarding the admission's replay/correlation guard. */
  private releaseInput(input: Submission): void { this.submissionBytes -= Buffer.byteLength(input.input); input.input = '' }

  private readonly params: SessionOpenParams
  private readonly sink: SessionEventSink
  private readonly options: HermesAdapterOptions
  private readonly profileId: string
  private readonly released: () => void
}

interface Submission {
  input: string
  admission?: Receipt
  /** The submit call has settled, so terminal evidence may release its retained text. */
  acknowledged: boolean
  rejected: boolean
}
/** Snapshot reconciliation may bridge missing sequences, but still records incomplete turn progress. */
type ReplayContinuity = 'contiguous' | 'snapshot'

/** Retry only transport/replay failures; correlation, validation and terminal-evidence failures remain final. */
const recoverable = (cause: unknown): cause is HarnessSdkError => cause instanceof HarnessSdkError && ['CONNECTION_CLOSED', 'RPC_TIMEOUT', 'HARNESS_UNAVAILABLE', 'HERMES_REPLAY_GAP'].includes(cause.code)
