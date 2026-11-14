/** Owns native thread state, execution evidence and ordered SDK projection; discovery, transport scheduling and version policy belong elsewhere. */
import { randomUUID } from 'node:crypto'
import type { ApprovalOption, Capabilities, AhpRequestMap, AhpResultMap, GoalState, HistoryItem, HistoryPage, InteractionRequested, InteractionResponse, Item, JsonObject, SessionBinding, SessionOpenParams, SessionState, Usage } from '@anureo/protocol'
import { HarnessSdkError, sdkError, type BackendSession, type SessionEventSink, type SessionMethod } from '@anureo/sdk'
import { CodexJsonlClient, CodexRpcError, type NativeRequest } from './jsonl'
import { json, safe, record, string, type NativeRecord } from './native-values'
import { mapItems } from './mapping'
import { mapUsage } from './usage'
import { mapTurnError } from './turn-error'
import { nativeInput } from './input'
import { readAccountStatus } from './account'
import { PERMISSION_MODES, permissionSettings, serviceTierFor } from './settings'
import type { CodexProfile } from './profile'
import type { CodexAdapterOptions } from './options'

/**
 * Package-internal thread owner and BackendSession implementation for CodexNativeAdapter.openSession.
 * Attach before opening; transport must serialize notifications while allowing interactions to overlap.
 * Native/sink failures propagate from operations, and disposal closes observation without proving execution stopped.
 */
export class CodexBackendSession implements BackendSession {
  /** Native binding committed by open; the SDK adopts it when attaching this backend. */
  binding: SessionBinding
  /** Session-local capability copy; missing optional native methods revoke support through the sink. */
  readonly capabilities: Capabilities
  /** Attachment snapshot updated by native evidence and successful configuration; clone before retaining it independently. */
  state: SessionState
  /** Accept adapter-validated open parameters, clone binding/capabilities and seed ready state. No I/O; clone errors throw before the adapter attaches a transport. */
  constructor({ params, sink, native, capabilities, options }: SessionInputs) {
    this.params = params
    this.sink = sink
    this.native = native
    this.options = options
    this.binding = structuredClone(params.binding)
    this.capabilities = structuredClone(capabilities)
    const model = params.model ?? string(params.config?.model)
    this.state = { binding: this.binding, status: 'ready', activeTurnIds: [], config: params.config ?? {}, capabilities: this.capabilities, capabilityRevision: 1, ...(model ? { model } : {}) }
  }
  /** Called once by the adapter before open to transfer client cleanup ownership; stores the reference without I/O. */
  attach(client: CodexJsonlClient): void { this.client = client }
  /** Let adapter fork resolution look up an observed native identity; unknown canonical IDs return undefined without effects. */
  resolveNativeTurn(canonical: string): string | undefined { return this.nativeTurnIdByCanonicalId.get(canonical) }
  /** Let the adapter seed a fork before open with copies of source identity maps; no I/O or shared mutable maps. */
  importTurnMap(source: CodexBackendSession): void {
    this.canonicalTurnIdByNativeId = new Map(source.canonicalTurnIdByNativeId)
    this.nativeTurnIdByCanonicalId = new Map(source.nativeTurnIdByCanonicalId)
  }
  /** Open the adapter-validated mode on the attached client, commit native binding, then publish restored metadata. Reject policy, identity, native or sink failures; the adapter disposes failed opens. */
  async open(): Promise<void> {
    const common = this.threadOptions()
    const result = await this.openNativeThread(common)
    await this.restoreThread(result)
  }
  /** SDK BackendSession entry for validated requests: return the method's result after ordered native dispatch/local commit. Reject unsupported methods and native/sink failures; the SDK registry handles interaction answers. */
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    let result: AhpResultMap[SessionMethod]
    const p = params as AhpRequestMap[SessionMethod]
    switch (method) {
      case 'input/submit': return await this.submitInput({ method: 'input/submit', params: p as AhpRequestMap['input/submit'] }) as AhpResultMap[M]
      case 'review/start': return await this.submitInput({ method: 'review/start', params: p as AhpRequestMap['review/start'] }) as AhpResultMap[M]
      case 'turn/steer': {
        const steer = p as AhpRequestMap['turn/steer']
        const native = this.nativeTurn({ canonical: steer.expectedTurnId, missing: 'TURN_MISMATCH' })
        const response = record(await this.optional('turn/steer', { threadId: this.threadId, expectedTurnId: native, input: nativeInput(steer.input), clientUserMessageId: steer.submissionId }, () => { delete this.capabilities.input!.steer }))
        if (response.turnId !== native) throw new HarnessSdkError('TURN_MISMATCH', 'Native steer did not target the same turn', false, true)
        result = { submissionId: steer.submissionId, turnId: steer.expectedTurnId, accepted: true }; break
      }
      case 'turn/interrupt': {
        const interrupt = p as AhpRequestMap['turn/interrupt']
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.nativeTurn({ canonical: interrupt.turnId, missing: 'TURN_MISMATCH' }) })
        result = { accepted: true, turnId: interrupt.turnId }; break
      }
      case 'session/config/set': result = await this.setConfig((p as AhpRequestMap['session/config/set']).patch); break
      case 'session/revert': result = await this.revert(p as AhpRequestMap['session/revert']); break
      case 'history/read': result = await this.readHistory(p as AhpRequestMap['history/read']); break
      case 'goal/set': {
        const goal = (p as AhpRequestMap['goal/set']).goal
        const nativeGoal = Object.fromEntries(Object.entries(goal).filter(([key]) => ['objective','status','tokenBudget'].includes(key)))
        const value = record(await this.optional('thread/goal/set', { ...nativeGoal, threadId: this.threadId }, () => { this.capabilities.goal = { actions: [] } }))
        result = { goal: json(value.goal) as JsonObject, status: 'active' }
        this.state.goal = result as GoalState
        break
      }
      case 'goal/clear': {
        await this.optional('thread/goal/clear', { threadId: this.threadId }, () => { this.capabilities.goal = { actions: [] } })
        result = { goal: null, status: 'cleared' }
        this.state.goal = result as GoalState
        break
      }
      case 'compact/start': {
        await this.optional('thread/compact/start', { threadId: this.threadId }, () => { this.capabilities.compact = false })
        result = { maintenanceId: p.requestId, status: 'accepted' }; break
      }
      case 'session/close': {
        await this.client.request('thread/unsubscribe', { threadId: this.threadId })
        // Unsubscribing ends observation; only terminal evidence can confirm execution stopped.
        this.closing = true
        result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' }
        break
      }
      default: throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') // interaction actions are owned by SDK registry
    }
    return result as AhpResultMap[M]
  }
  /** Transport entry for wire-ordered notifications: filter thread scope, correlate evidence, then project events and state. Reject malformed data or sink errors; callers must serialize this independently of concurrent interactions. */
  async notification(method: string, params: NativeRecord): Promise<void> {
    if (typeof params.threadId === 'string' && this.threadId && params.threadId !== this.threadId) return
    if (method === 'item/started' || method === 'item/completed') {
      const item = record(params.item)
      const submissionId = string(item.clientId)
      const native = string(params.turnId)
      // A user message identifies its submission even when the receipt does not name an execution.
      if (item.type === 'userMessage' && submissionId && native && this.awaitingTurnSubmissionIds.has(submissionId)) {
        const actual = await this.ensureStarted(native)
        await this.sink.bindSubmission(submissionId, actual)
        this.awaitingTurnSubmissionIds.delete(submissionId)
        this.receiptTurnIdBySubmissionId.delete(submissionId)
      }
    }
    if (method === 'thread/started') return
    if (method === 'thread/name/updated') {
      const title = typeof params.threadName === 'string' ? params.threadName : null
      if (this.state.metadata?.title !== title) {
        this.state.metadata = { title }
        await this.sink.emit({ type: 'session/metadata', payload: { title } })
      }
      return
    }
    if (method === 'turn/started') {
      const id = string(record(params.turn).id)
      if (id) await this.ensureStarted(id)
      return
    }
    const turnId = this.scope(params)
    if (method === 'turn/completed') {
      await this.completeTurn(record(params.turn))
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (!turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native item has no turn')
      await this.projectItem({ params, turnId, phase: method === 'item/completed' ? 'completed' : 'started' })
      return
    }
    const deltaKinds: Record<string, 'text'|'reasoningSummary'|'output'|'patch'> = {
      'item/agentMessage/delta': 'text',
      'item/reasoning/summaryTextDelta': 'reasoningSummary',
      'item/reasoning/textDelta': 'reasoningSummary',
      'item/commandExecution/outputDelta': 'output',
      'item/fileChange/outputDelta': 'output',
      'item/plan/delta': 'text',
    }
    if (deltaKinds[method]) {
      await this.projectDelta({ method, params, turnId, kind: deltaKinds[method]! })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = record(params.tokenUsage)
      const lastUsage = mapUsage(tokenUsage.last, 'turn')
      const usage = mapUsage(tokenUsage.total, 'session')
      if (turnId) this.nativeUsage.set(turnId, lastUsage)
      if (typeof tokenUsage.modelContextWindow === 'number') usage.contextWindow = tokenUsage.modelContextWindow
      await this.sink.emit({ type: 'usage/updated', payload: usage }, { turnId })
      return
    }
    if (method === 'turn/plan/updated' && turnId) {
      await this.projectPlan(params, turnId)
      return
    }
    if ((method === 'hook/started' || method === 'hook/completed') && turnId) {
      const hook = record(params.hook ?? params)
      const id = string(hook.id) ?? string(params.hookId)
      if (id) await this.sink.emit({ type: method === 'hook/started' ? 'item/started' : 'item/completed', payload: { item: { id, type: 'hook', name: string(hook.name) ?? 'hook', status: method === 'hook/started' ? 'running' : 'completed', output: safe(hook.output) } } }, { turnId, itemId: id })
      return
    }
    if (method === 'thread/compacted') {
      await this.sink.emit({ type: 'notice', payload: { severity: 'info', code: 'CONTEXT_COMPACTED', message: 'Native context compaction completed' } }, { turnId })
      return
    }
    await this.sink.emit({ type: 'notice', payload: { severity: method === 'error' ? 'error' : 'info', code: 'NATIVE_NOTIFICATION', message: method, raw: safe(params) } }, { turnId })
  }
  /**
   * Transport entry for concurrent native requests: scope and translate each prompt with its answer
   * encoder, then await SDK answer delivery and settlement. CodexNativeAdapter.openSession registers
   * this callback with CodexJsonlClient, which keeps draining stdout while it waits. Invalid/unsupported
   * requests receive wire errors; projection/rejection failures reach transport fallback. Registry
   * failures are absorbed after its cancellation attempt when applicable.
   */
  async serverRequest(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void> {
    const p = request.params
    if (p.threadId !== this.threadId) {
      await reject(-32602, 'Unknown thread')
      return
    }
    const turnId = this.scope(p)
    const itemId = string(p.itemId)
    const id = `codex:${typeof request.id}:${request.id}`
    const common = { interactionId: id, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) }
    const projected = this.interactionFor(request, common)
    if ('code' in projected) {
      await reject(projected.code, projected.message)
      return
    }
    const { interaction, encode } = projected
    try { await this.sink.requestInteraction(interaction, answer => reply(encode(answer))) }
    catch { /* Registry has already attempted non-authorizing cancellation when applicable. */ }
  }

  /** Let transport failure close SDK observation unless already closing; return after sink acceptance or propagate its rejection. Process cleanup remains owned by dispose, without asserting execution stopped. */
  async failure(cause: HarnessSdkError): Promise<void> { if (!this.closing) await this.sink.fail(cause) }
  /** For adapter teardown, mark observation closing and drop retained history/output before disposing the client. Reject disposal failures; releasing transport resources cannot confirm native execution stopped. */
  async dispose(): Promise<void> {
    this.closing = true
    this.history.clear()
    this.executionOutput.clear()
    await this.client.dispose()
  }
  private readonly params: SessionOpenParams
  private readonly sink: SessionEventSink
  private readonly native: SessionInputs['native']
  private readonly options: CodexAdapterOptions
  // Submissions await execution evidence before binding; responses may supply a native turn ID receipt.
  // Observed turns or matching userMessage items allow binding and pending-state cleanup.
  // Definite failure removes the awaiting ID; outcomeUnknown retains it for later evidence.
  private readonly awaitingTurnSubmissionIds = new Set<string>()
  private readonly receiptTurnIdBySubmissionId = new Map<string, string>()
  private readonly nativeUsage = new Map<string, Usage>()
  private readonly nativePlans = new Map<string, Item>()
  private client!: CodexJsonlClient
  private threadId = ''
  private canonicalTurnIdByNativeId = new Map<string, string>()
  private nativeTurnIdByCanonicalId = new Map<string, string>()
  private started = new Set<string>()
  private items = new Set<string>()
  private executionOutput = new Map<string, string>()
  private itemStartedAt = new Map<string, string>()
  private history = new Map<string, HistoryItem[]>()
  private closing = false
  private unverifiedNoticed = false
  private capabilityRevision = 1
  /** Build open's native settings before dispatch, retaining normalized permission mode in SDK state. Policy translation can throw; caller configuration is copied so native-only fields never leak back into it. */
  private threadOptions(): NativeRecord {
    const config: NativeRecord = { ...(this.params.config ?? {}) }
    const mode = config.permissionMode ?? (PERMISSION_MODES.includes(this.params.permissionMode as typeof PERMISSION_MODES[number]) ? this.params.permissionMode : undefined)
    const permissions = permissionSettings(mode)
    if (typeof mode === 'string') this.state.config = { ...this.state.config, permissionMode: mode }
    delete config.permissionMode
    if (permissions) {
      config.sandbox_mode = permissions.sandbox
      config.approval_policy = permissions.approvalPolicy
    }
    if (this.params.mcpServers) {
      config.mcp_servers = Object.fromEntries(this.params.mcpServers.map(server => [
        server.name,
        server.type === 'stdio'
          ? { command: server.command, args: server.args ?? [], env: server.env ?? {} }
          : { url: server.url, http_headers: server.headers ?? {} },
      ]))
    }
    const fastMode = config.fastMode
    delete config.fastMode
    return {
      cwd: this.params.cwd,
      ...(fastMode !== undefined ? { serviceTier: serviceTierFor(fastMode) } : {}),
      ...(this.params.model ? { model: this.params.model } : {}),
      ...(this.params.instructions ? { developerInstructions: this.params.instructions } : {}),
      config,
      ...(this.params.permissionMode ? { approvalPolicy: this.params.permissionMode } : {}),
      ...(permissions ? { approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandbox } : {}),
    }
  }
  /** Dispatch open's mode using its translated settings. Resume records the requested identity before I/O as a fallback for replies without one. Fork throws for missing native evidence before dispatch; native request failures reject without retry. */
  private openNativeThread(common: NativeRecord): Promise<unknown> {
    if (this.params.mode === 'new') return this.client.request('thread/start', common)
    else if (this.params.mode === 'resume') {
      // SDK validation requires nativeRef for resume and fork data for fork before adapter dispatch.
      this.threadId = this.params.binding.nativeRef!.value
      return this.client.request('thread/resume', { ...common, threadId: this.threadId })
    } else {
      const fork = this.params.fork!
      const nativeId = fork.boundary.nativeTurnId
      if (!nativeId) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED', 'Fork requires a resolved native turn identity')
      const sourceNative = fork.nativeRef?.value ?? this.params.binding.nativeRef?.value
      if (!sourceNative) throw new HarnessSdkError('SESSION_NATIVE_REF_REQUIRED', 'Fork requires the source native reference')
      return this.client.request('thread/fork', { ...common, threadId: sourceNative, ...(fork.boundary.relation === 'before' ? { beforeTurnId: nativeId } : { lastTurnId: nativeId }) })
    }
  }
  /** Commit open's native identity and restored title before publishing metadata. Missing identity or sink failure rejects the open; CodexNativeAdapter.openSession then disposes its client. */
  private async restoreThread(result: unknown): Promise<void> {
    this.threadId = string(record(record(result).thread).id) ?? this.threadId
    if (!this.threadId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native thread identity missing')
    this.binding = { ...this.binding, nativeRef: { provider: 'codex', value: this.threadId } }
    this.state.binding = this.binding
    const thread = record(record(result).thread)
    if (typeof thread.name === 'string' || thread.name === null) this.state.metadata = { title: thread.name }
    if (this.state.metadata) await this.sink.emit({ type: 'session/metadata', payload: this.state.metadata })
  }
  /** For control/revert builders, prefer a supplied native boundary over the observed map; throw the caller's missing-identity code before I/O or mutation. */
  private nativeTurn({ canonical, provided, missing = 'BOUNDARY_NATIVE_ID_REQUIRED' }: { canonical: string; provided?: string; missing?: string }): string {
    const native = provided ?? this.nativeTurnIdByCanonicalId.get(canonical)
    if (!native) throw new HarnessSdkError(missing, 'Native turn identity is not known')
    return native
  }
  /** For native evidence and scope routing, establish both identity-map directions and return the canonical ID; no I/O or lifecycle publication. */
  private registerNativeTurnIdentity(native: string): string {
    // The adapter currently uses the same ID for native and canonical turn identities.
    this.nativeTurnIdByCanonicalId.set(native, native)
    this.canonicalTurnIdByNativeId.set(native, native)
    return native
  }
  /** For execution evidence, publish the first start before activating the turn and binding receipts. Return its canonical ID; sink rejection stops subsequent mutations, and receipt acknowledgements alone must never call this. */
  private async ensureStarted(nativeId: string): Promise<string> {
    const turnId = this.registerNativeTurnIdentity(nativeId)
    if (!this.started.has(turnId)) {
      // Reserve before publication so later evidence cannot publish a duplicate start.
      this.started.add(turnId)
      await this.sink.emit({ type: 'turn/started', payload: { turnId, nativeTurnId: nativeId } }, { turnId })
      this.state.activeTurnIds.push(turnId)
      this.state.status = 'running'
    }
    for (const [submissionId, receiptTurnId] of this.receiptTurnIdBySubmissionId) {
      if (receiptTurnId === nativeId) {
        await this.sink.bindSubmission(submissionId, turnId)
        this.receiptTurnIdBySubmissionId.delete(submissionId)
        this.awaitingTurnSubmissionIds.delete(submissionId)
      }
    }
    return turnId
  }
  /** Resolve notification/interaction scope from params.turnId, registering identity without proving a start; absent IDs return undefined without publication or I/O. */
  private scope(params: NativeRecord): string | undefined { const native = string(params.turnId); return native ? this.registerNativeTurnIdentity(native) : undefined }
  /** For execute, reserve pending capacity, dispatch the typed submission and return acceptance from its receipt. Bind only observed turns; reject admission/auth/native/sink failures, releasing IDs only for definite outcomes. */
  private async submitInput(submission: SubmissionRequest): Promise<import('@anureo/protocol').SubmissionAcceptance> {
    const { params } = submission
    if (this.awaitingTurnSubmissionIds.size >= (this.options.maxPending ?? 128)) throw new HarnessSdkError('BACKPRESSURE_EXCEEDED')
    if (this.awaitingTurnSubmissionIds.has(params.submissionId)) throw new HarnessSdkError('SUBMISSION_ID_CONFLICT')
    if (!this.native.verified && !this.unverifiedNoticed) {
      this.unverifiedNoticed = true
      await this.sink.emit({ type: 'notice', payload: { severity: 'warning', code: 'CODEX_VERSION_UNVERIFIED', message: `Codex ${this.native.profile.since}+ behaviour is used for this version; it has not been verified against the native schema.` } })
    }
    this.awaitingTurnSubmissionIds.add(params.submissionId)
    // Distinguish joining an already observed turn from a turn first observed during this submission.
    const previousTurns = new Set(this.started)
    try {
      const value = submission.method === 'input/submit'
        ? await this.startInput(submission.params)
        : record(await this.optional('review/start', { threadId: this.threadId, target: submission.params.target, delivery: 'inline' }, () => { this.capabilities.review = false }))
      const id = string(record(value.turn).id)
      if (!id) throw new HarnessSdkError('PROTOCOL_ERROR')
      // A turn/start response can contain a submission id; only observed execution facts bind it.
      if (this.started.has(id)) {
        await this.sink.bindSubmission(params.submissionId, id)
        this.awaitingTurnSubmissionIds.delete(params.submissionId)
        return previousTurns.has(id)
          ? { submissionId: params.submissionId, accepted: true, disposition: 'joined', turnId: id }
          : { submissionId: params.submissionId, accepted: true, disposition: 'accepted', receipt: { nativeSubmissionId: id } }
      }
      if (this.awaitingTurnSubmissionIds.has(params.submissionId)) this.receiptTurnIdBySubmissionId.set(params.submissionId, id)
      return { submissionId: params.submissionId, accepted: true, disposition: 'accepted', receipt: { nativeSubmissionId: id } }
    } catch (cause) {
      if (!sdkError(cause).outcomeUnknown) this.awaitingTurnSubmissionIds.delete(params.submissionId)
      throw cause
    }
  }
  /**
   * For admitted input submissions, authenticate and build turn settings before dispatching turn/start.
   * Return the untrusted receipt; reject auth, policy or transport errors without binding an execution.
   * submitInput owns pending-ID cleanup so uncertain dispatch failures retain their evidence slot.
   */
  private async startInput(start: AhpRequestMap['input/submit']): Promise<NativeRecord> {
    if (start.delivery !== 'native') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    if (await readAccountStatus(this.client) === 'required') throw new HarnessSdkError('AUTH_REQUIRED')
    const permissions = permissionSettings(this.state.config.permissionMode)
    const sessionOverrides = Object.fromEntries(
      Object.entries(this.state.config).filter(([key]) => this.capabilities.turn?.overrides?.includes(key)),
    )
    const permissionOverrides = permissions
      ? { approvalPolicy: permissions.approvalPolicy, sandboxPolicy: permissions.sandboxPolicy }
      : {}
    const serviceTierOverride = 'fastMode' in this.state.config
      ? { serviceTier: serviceTierFor(this.state.config.fastMode) }
      : {}
    const turnStartParams = {
      ...sessionOverrides,
      ...permissionOverrides,
      ...serviceTierOverride,
      ...start.overrides,
      threadId: this.threadId,
      input: nativeInput(start.input),
      clientUserMessageId: start.submissionId,
      ...(start.outputSchema !== undefined ? { outputSchema: start.outputSchema } : {}),
    }
    return record(await this.client.request('turn/start', turnStartParams))
  }
  /** Dispatch an optional native method for session operations. Return its reply; method-not-found invokes disable and publishes revised capabilities before rejecting unsupported. Other native/sink errors propagate. */
  private async optional<T>(method: string, params: NativeRecord, disable: () => void): Promise<T> {
    try { return await this.client.request<T>(method, params) }
    catch (cause) {
      if (cause instanceof CodexRpcError && cause.rpcCode === -32601) {
        disable()
        this.state.capabilityRevision = ++this.capabilityRevision
        this.state.capabilities = this.capabilities
        await this.sink.emit({ type: 'session/state', payload: structuredClone(this.state) })
        throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
      }
      throw cause
    }
  }
  /**
   * For config dispatch, validate and translate the patch, then commit local state after native success.
   * Older profiles retain settings for subsequent turns. Reject invalid values or native/sink errors;
   * method-not-found revokes config support through optional before any local config commit.
   */
  private async setConfig(patch: AhpRequestMap['session/config/set']['patch']): Promise<SessionState> {
    const permissions = permissionSettings(patch.permissionMode)
    const nativePatch: NativeRecord = { ...patch }
    delete nativePatch.permissionMode
    if (patch.fastMode !== undefined) {
      if (typeof patch.fastMode !== 'boolean') throw new HarnessSdkError('INVALID_PARAMS')
      nativePatch.serviceTier = serviceTierFor(patch.fastMode)
      delete nativePatch.fastMode
    }
    if (permissions) {
      nativePatch.approvalPolicy = permissions.approvalPolicy
      nativePatch.sandboxPolicy = permissions.sandboxPolicy
    }
    if (this.native.profile.settings === 'thread/settings/update') await this.optional('thread/settings/update', { ...nativePatch, threadId: this.threadId }, () => { this.capabilities.config = { options: [] } })
    // 0.148 has no thread/settings/update; its native per-turn settings apply to subsequent turns.
    this.state.config = { ...this.state.config, ...patch }
    this.state.capabilityRevision = this.capabilityRevision
    if (typeof patch.model === 'string') this.state.model = patch.model
    return structuredClone(this.state)
  }
  /** For execute, revert conversation at a supplied/observed boundary and invalidate snapshots only on success. Reject unsupported scope, missing turns/identities or native/sink errors; workspace files are outside this operation. */
  private async revert(params: AhpRequestMap['session/revert']): Promise<AhpResultMap['session/revert']> {
    if (params.scope !== 'conversation') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    const native = this.nativeTurn({ canonical: params.boundary.turnId, provided: params.boundary.nativeTurnId })
    if (this.native.profile.revert === 'thread/revert' && params.boundary.relation === 'before') {
      await this.optional('thread/revert', { threadId: this.threadId, beforeTurnId: native }, () => { this.capabilities.session!.revert = [] })
    } else {
      const turns = await this.turns()
      const index = turns.findIndex(turn => turn.id === native)
      if (index < 0) throw new HarnessSdkError('TURN_NOT_FOUND')
      const remove = turns.length - index - (params.boundary.relation === 'through' ? 1 : 0)
      if (remove > 0) {
        if (this.native.profile.revert === 'thread/revert') await this.optional('thread/revert', { threadId: this.threadId, beforeTurnId: turns[turns.length - remove]!.id }, () => { this.capabilities.session!.revert = [] })
        else await this.optional('thread/rollback', { threadId: this.threadId, numTurns: remove }, () => { this.capabilities.session!.revert = [] })
      }
    }
    this.history.clear()
    return { appliedScope: 'conversation', boundary: params.boundary }
  }
  /** Fetch native turns in ascending order for revert or legacy history. Reject malformed pages, paged-history overflow or transport errors; read-only requests never change thread execution. */
  private async turns(): Promise<NativeRecord[]> {
    if (this.native.profile.turns === 'thread/read') {
      const response = record(await this.client.request('thread/read', { threadId: this.threadId, includeTurns: true }))
      const turns = record(response.thread).turns
      if (!Array.isArray(turns)) throw new HarnessSdkError('PROTOCOL_ERROR')
      return turns.map(record)
    }
    const turns: NativeRecord[] = []
    let cursor: string | undefined
    do {
      const page = record(await this.client.request('thread/turns/list', { threadId: this.threadId, sortDirection: 'asc', limit: 200, ...(cursor ? { cursor } : {}) }))
      if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
      turns.push(...page.data.map(record))
      if (turns.length > (this.options.maxHistoryItems ?? 10000)) throw new HarnessSdkError('HISTORY_LIMIT_EXCEEDED')
      cursor = string(page.nextCursor)
    } while (cursor)
    return turns
  }
  /** For execute, decode a cursor, resolve a retained snapshot and return a cloned page. Reject cursor/cache/native/projection errors; snapshots retain order until eviction, revert or disposal. Cache insertion precedes offset validation. */
  private async readHistory(params: AhpRequestMap['history/read']): Promise<HistoryPage> {
    let token = params.snapshotToken
    let offset = 0
    if (params.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(params.cursor, 'base64url').toString()) as { token: string; offset: number }
        if (token && parsed.token !== token) throw new Error()
        token = parsed.token
        offset = parsed.offset
      } catch {
        throw new HarnessSdkError('CURSOR_INVALID')
      }
    }
    const snapshot = await this.historySnapshot(token)
    const { items } = snapshot
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new HarnessSdkError('CURSOR_INVALID')
    const limit = params.limit ?? 200
    const end = Math.min(offset + limit, items.length)
    return {
      items: structuredClone(items.slice(offset, end)),
      snapshotToken: snapshot.token,
      nextCursor: end < items.length ? Buffer.from(JSON.stringify({ token: snapshot.token, offset: end })).toString('base64url') : null,
      source: this.binding.nativeRef,
    }
  }
  /**
   * For readHistory, resolve an existing token or load and retain a new snapshot with a required token.
   * Reject expired tokens before fetching; native/projection failures leave the cache untouched.
   * Evict the oldest snapshot above eight entries before readHistory validates its page offset.
   */
  private async historySnapshot(token: string | undefined): Promise<{ token: string; items: HistoryItem[] }> {
    if (token) {
      const items = this.history.get(token)
      if (!items) throw new HarnessSdkError('CURSOR_EXPIRED')
      return { token, items }
    }
    const items = await this.loadHistoryItems()
    const snapshotToken = randomUUID()
    this.history.set(snapshotToken, items)
    // Size > 8 proves the insertion-ordered map has an oldest key.
    if (this.history.size > 8) this.history.delete(this.history.keys().next().value!)
    return { token: snapshotToken, items }
  }
  /**
   * For a new history snapshot, collect native pages in ascending order without publishing the cache.
   * Preserve per-entry timestamps and canonical identities; reject malformed item pages, native/sink errors
   * or configured paged-history overflow. Legacy turn snapshots keep their native item order.
   */
  private async loadHistoryItems(): Promise<HistoryItem[]> {
    return this.native.profile.history === 'thread/items/list'
      ? await this.pagedHistoryItems()
      : await this.turnHistoryItems()
  }
  /** For loadHistoryItems on modern profiles, map ascending item pages and enforce the item limit after each page. Method absence revokes history support; malformed entries, overflow and native/sink failures reject before snapshot retention. */
  private async pagedHistoryItems(): Promise<HistoryItem[]> {
    const items: HistoryItem[] = []
    let cursor: string | undefined
    do {
      const page = record(await this.optional('thread/items/list', { threadId: this.threadId, sortDirection: 'asc', limit: 200, ...(cursor ? { cursor } : {}) }, () => { this.capabilities.session!.history = false }))
      if (!Array.isArray(page.data)) throw new HarnessSdkError('PROTOCOL_ERROR')
      for (const entry of page.data) {
        const native = record(entry)
        const nativeTurnId = string(native.turnId)
        if (!nativeTurnId) throw new HarnessSdkError('PROTOCOL_ERROR')
        for (const item of this.historyEntryItems({ nativeItem: native.item, nativeTurnId, timing: { startedAtMs: native.startedAtMs } })) items.push(item)
      }
      if (items.length > (this.options.maxHistoryItems ?? 10000)) throw new HarnessSdkError('HISTORY_LIMIT_EXCEEDED')
      cursor = string(page.nextCursor)
    } while (cursor)
    return items
  }
  /** For loadHistoryItems on legacy profiles, flatten each native turn's items in source order, skipping turns without identity/items. Fetch/projection errors reject; this path adds no item limit beyond turns' own paging policy. */
  private async turnHistoryItems(): Promise<HistoryItem[]> {
    const items: HistoryItem[] = []
    for (const turn of await this.turns()) {
      const nativeTurnId = string(turn.id)
      if (!nativeTurnId || !Array.isArray(turn.items)) continue
      for (const nativeItem of turn.items) {
        for (const item of this.historyEntryItems({ nativeItem, nativeTurnId })) items.push(item)
      }
    }
    return items
  }
  /**
   * For either native history profile, expand one source item into SDK history envelopes in map order.
   * Preserve the source identity on every expanded item and use observed canonical identities when
   * available. Projection/JSON errors propagate; this reads identity maps without mutation or I/O.
   */
  private historyEntryItems({ nativeItem, nativeTurnId, timing = {} }: {
    nativeItem: unknown
    nativeTurnId: string
    timing?: { startedAtMs?: unknown }
  }): HistoryItem[] {
    return mapItems(nativeItem, true, true, timing).map(item => ({
      turnId: this.canonicalTurnIdByNativeId.get(nativeTurnId) ?? nativeTurnId,
      nativeTurnId,
      nativeItemId: string(record(nativeItem).id),
      item,
    }))
  }
  /** For turn/plan/updated notifications, publish a start or patch before retaining the latest plan for completeTurn. Keep the candidate local across publication; sink failures leave the retained plan unchanged. */
  private async projectPlan(params: NativeRecord, turnId: string): Promise<void> {
    const id = `plan:${turnId}`
    const item: Item = {
      id,
      type: 'plan',
      status: 'completed',
      steps: (Array.isArray(params.plan) ? params.plan : []).map(
        /** Project native plan steps in order with stable index IDs and conservative pending status; no effects. */
        (step, i) => {
          const value = record(step)
          return { id: `${i}`, text: string(value.step) ?? '', status: value.status === 'completed' ? 'completed' : value.status === 'inProgress' ? 'inProgress' : 'pending' }
        },
      ),
    }
    const previous = this.nativePlans.get(turnId)
    const plan: Item = previous ? item : { ...item, status: 'running' }
    if (!previous) {
      await this.sink.emit({ type: 'item/started', payload: { item: plan } }, { turnId, itemId: id })
    } else {
      await this.sink.emit({ type: 'item/delta', payload: { itemId: id, kind: 'patch', value: json(item) } }, { turnId, itemId: id })
    }
    this.nativePlans.set(turnId, plan)
  }
  /**
   * For scoped item notifications after submission correlation, publish snapshots in map order.
   * Keep the first start time, patch repeated starts and attach retained tool output only when absent.
   * Mutate caches at the original publication boundaries; projection and sink failures reject.
   */
  private async projectItem({ params, turnId, phase }: { params: NativeRecord; turnId: string; phase: 'started' | 'completed' }): Promise<void> {
    const completed = phase === 'completed'
    for (const sourceItem of mapItems(params.item, completed, false, { startedAtMs: completed ? undefined : params.startedAtMs })) {
      const key = `${turnId}\0${sourceItem.id}`
      // Completed snapshots omit the start time; repeated starts must not reset it.
      const startedAt = this.itemStartedAt.get(key) ?? sourceItem.startedAt
      if (startedAt !== undefined) this.itemStartedAt.set(key, startedAt)
      const timedItem = startedAt !== undefined ? { ...sourceItem, startedAt } : sourceItem
      const item = timedItem.type === 'toolCall' && timedItem.output == null && this.executionOutput.has(key)
        ? { ...timedItem, output: this.executionOutput.get(key)! }
        : timedItem
      if (completed) this.executionOutput.delete(key)
      if (!completed && this.items.has(key)) {
        await this.sink.emit({ type: 'item/delta', payload: { itemId: item.id, kind: 'patch', value: json(item) } }, { turnId, itemId: item.id })
        continue
      }
      this.items.add(key)
      await this.sink.emit({ type: completed ? 'item/completed' : 'item/started', payload: { item } }, { turnId, itemId: item.id })
    }
  }
  /**
   * For recognized delta notifications, require item/turn scope, synthesize a start if needed, then
   * emit the delta. Output fragments are bounded diagnostics, never file patch material. Reject
   * missing scope or sink failures at the publication boundary; notification owns wire ordering.
   */
  private async projectDelta({ method, params, turnId, kind }: {
    method: string
    params: NativeRecord
    turnId: string | undefined
    kind: 'text' | 'reasoningSummary' | 'output' | 'patch'
  }): Promise<void> {
    const itemId = string(params.itemId)
    if (!itemId || !turnId) throw new HarnessSdkError('PROTOCOL_ERROR')
    const key = `${turnId}\0${itemId}`
    if (!this.items.has(key)) {
      this.items.add(key)
      const item: Item = method === 'item/fileChange/outputDelta'
        ? { id: itemId, type: 'toolCall', kind: 'fileChange', title: 'File changes', status: 'running' }
        : method === 'item/commandExecution/outputDelta'
          ? { id: itemId, type: 'toolCall', kind: 'command', title: 'Command', status: 'running' }
          : { id: itemId, type: 'agentMessage', phase: 'commentary', text: '', status: 'running' }
      await this.sink.emit({ type: 'item/started', payload: { item } }, { turnId, itemId })
    }
    const deltaText = string(params.delta) ?? ''
    if (kind === 'output') {
      // Bound retained diagnostics independently; they never become patch material.
      const text = (this.executionOutput.get(key) ?? '') + deltaText
      this.executionOutput.set(key, text.length > 64 * 1024 ? text.slice(0, 64 * 1024) + '\n[Execution output truncated]\n' : text)
    }
    await this.sink.emit({ type: 'item/delta', payload: { itemId, kind, text: deltaText } }, { turnId, itemId })
  }
  /**
   * For terminal native evidence, ensure start/binding precedes plan and turn completion publication.
   * Retire diagnostics and active state only after the sink accepts completion; malformed identities
   * or sink errors reject at their original boundary rather than asserting successful cleanup.
   */
  private async completeTurn(turn: NativeRecord): Promise<void> {
    const native = string(turn.id)
    if (!native) throw new HarnessSdkError('PROTOCOL_ERROR')
    const canonical = await this.ensureStarted(native)
    const state = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed'
    const nativeError = turn.error ? mapTurnError(turn.error) : state === 'failed' ? mapTurnError({}) : undefined
    const plan = this.nativePlans.get(canonical)
    if (plan) {
      const item = { ...plan, status: 'completed' as const }
      this.nativePlans.delete(canonical)
      await this.sink.emit({ type: 'item/completed', payload: { item } }, { turnId: canonical, itemId: item.id })
    }
    const usage = this.nativeUsage.get(canonical)
    await this.sink.emit({ type: 'turn/completed', payload: { turnId: canonical, status: state, ...(nativeError ? { error: nativeError } : {}), ...(usage ? { usage } : {}) } }, { turnId: canonical })
    this.nativeUsage.delete(canonical)
    for (const key of this.executionOutput.keys()) if (key.startsWith(`${canonical}\0`)) this.executionOutput.delete(key)
    for (const key of this.itemStartedAt.keys()) if (key.startsWith(`${canonical}\0`)) this.itemStartedAt.delete(key)
    this.state.activeTurnIds = this.state.activeTurnIds.filter(id => id !== canonical)
    this.state.status = this.state.activeTurnIds.length ? 'running' : 'ready'
  }
  /** Build serverRequest's prompt and matching responder without I/O. Each encoder closes over only its own native choices; unsupported methods or an empty supported decision set return wire errors, while JSON projection failures throw to transport fallback. */
  private interactionFor(request: NativeRequest, common: InteractionScope): InteractionProjection {
    const p = request.params
    let interaction: InteractionRequested
    let encode: (answer: InteractionResponse | null) => unknown
    // Keep prompt data and its encoder in the same request closure: overlapping approvals and
    // questions must never consult mutable state from another pending interaction.
    if (['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(request.method)) {
      const permissions = request.method === 'item/permissions/requestApproval'
      const advertised = Array.isArray(p.availableDecisions) ? p.availableDecisions : ['accept','acceptForSession','decline','cancel']
      const decisions = new Map<string, unknown>()
      const options = advertised.flatMap<ApprovalOption>(
        /** Advertise supported choices and retain their exact native values for this request's encoder; unsupported choices disappear without authorizing anything. */
        (decision, i) => {
          if (typeof decision === 'string' && ['accept','acceptForSession','decline','cancel'].includes(decision)) {
            decisions.set(decision, decision)
            return [{
              id: decision,
              label: decision,
              semantic: decision === 'accept' ? 'allowOnce' as const
                : decision === 'acceptForSession' ? 'allowSession' as const
                : decision === 'cancel' ? 'cancel' as const : 'deny' as const,
            }]
          }
          if (record(decision).acceptWithExecpolicyAmendment || record(decision).applyNetworkPolicyAmendment) {
            const optionId = `rule:${i}`
            decisions.set(optionId, decision)
            return [{ id: optionId, label: 'Apply supplied policy rule', semantic: 'allowWithRule' as const }]
          }
          return []
        },
      )
      if (!options.length) {
        return { code: -32602, message: 'No supported approval decisions' }
      }
      interaction = { ...common, kind: 'approval', title: string(p.reason) ?? 'Approval required', options, input: safe({ command: p.command, permissions: p.permissions, cwd: p.cwd }) }
      /** Encode an SDK answer against this request's advertised decisions; absent/invalid answers cancel or grant no permissions, without I/O. */
      encode = answer => {
        const decision = answer?.kind === 'approval' ? decisions.get(answer.optionId) : 'cancel'
        if (permissions) return { permissions: decision === 'accept' || decision === 'acceptForSession' ? p.permissions : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
        return { decision: decision ?? 'cancel' }
      }
    } else if (request.method === 'item/tool/requestUserInput') {
      const questions = (Array.isArray(p.questions) ? p.questions : []).map(
        /** Preserve native question IDs and index choices for SDK answers; this pure projection retains secret-input intent. */
        value => {
          const q = record(value)
          return {
            id: string(q.id) ?? '',
            prompt: string(q.question) ?? '',
            secret: q.isSecret === true,
            options: Array.isArray(q.options) ? q.options.map((option, index) => ({ id: String(index), label: string(record(option).label) ?? '' })) : undefined,
          }
        },
      )
      interaction = { ...common, kind: 'userInput', questions }
      /** Translate SDK choice IDs back to this prompt's labels; cancellation returns no answers, with no I/O or mutation. */
      encode = answer => ({
        answers: answer?.kind === 'userInput' ? Object.fromEntries(Object.entries(answer.answers).map(
          /** Encode one native question answer, preserving free text and selection order when no advertised label matches. */
          ([key, value]) => {
            const q = questions.find(question => question.id === key)
            const selected = Array.isArray(value) ? value : [value]
            return [key, { answers: selected.map(v => q?.options?.find(option => option.id === v)?.label ?? String(v)) }]
          },
        )) : {},
      })
    } else if (request.method === 'mcpServer/elicitation/request') {
      // Newer native schemas may carry mode-specific fields through anyOf branches.
      const mode = p.mode === 'url' || typeof p.url === 'string' ? 'url' : 'form'
      interaction = { ...common, kind: 'elicitation', mode, ...(p.requestedSchema ? { schema: json(p.requestedSchema) as JsonObject } : {}), message: string(p.message) ?? 'MCP input required', ...(mode === 'url' ? { privatePayload: { url: string(p.url) ?? '' } } : {}) }
      /** Encode only accepted elicitation content; absent/wrong-kind answers cancel and expose no content, without effects. */
      encode = answer => ({ action: answer?.kind === 'elicitation' ? answer.action : 'cancel', content: answer?.kind === 'elicitation' && answer.action === 'accept' ? answer.content ?? null : null })
    } else if (request.method === 'item/tool/call') {
      interaction = { ...common, kind: 'dynamicTool', toolName: string(p.tool) ?? string(p.name) ?? 'unknown', arguments: json(p.arguments ?? {}) as JsonObject }
      /** Encode SDK tool success and native-compatible content in order; cancellation is unsuccessful with no output and no I/O. */
      encode = answer => ({
        success: answer?.kind === 'dynamicTool' && !answer.isError,
        contentItems: answer?.kind === 'dynamicTool' ? answer.content.flatMap<NativeRecord>(block =>
          block.type === 'text' ? [{ type: 'inputText', text: block.text }]
            : block.type === 'image' ? [{ type: 'inputImage', imageUrl: block.url ?? `data:${block.mimeType};base64,${block.data}` }]
            : [],
        ) : [],
      })
    } else {
      return { code: -32601, message: 'Unsupported native request' }
    }
    return { interaction, encode }
  }
}

/** Internal dispatch union keeps input-only fields out of review requests; only execute constructs it, without I/O. */
type SubmissionRequest =
  | { method: 'input/submit'; params: AhpRequestMap['input/submit'] }
  | { method: 'review/start'; params: AhpRequestMap['review/start'] }

/** Adapter-only construction inputs; CodexNativeAdapter.openSession supplies validated params and owns cleanup until open succeeds. */
type SessionInputs = {
  params: SessionOpenParams
  sink: SessionEventSink
  native: { profile: CodexProfile; verified: boolean }
  capabilities: Capabilities
  options: CodexAdapterOptions
}

/** Scope allocated by serverRequest before projection, preserving native request-ID type in the interaction identity. */
type InteractionScope = { interactionId: string; turnId?: string; itemId?: string }

/** A request-local prompt/responder pair, or the native error serverRequest must send instead of registering an interaction. */
type InteractionProjection =
  | { interaction: InteractionRequested; encode: (answer: InteractionResponse | null) => unknown }
  | { code: number; message: string }
