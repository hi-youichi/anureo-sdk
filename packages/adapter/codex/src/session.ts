/** Owns a native thread's binding, execution evidence, and projection into SDK state and events. */
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
 * Per-thread BackendSession created by CodexNativeAdapter.openSession. Attach its transport
 * before opening. Feed notifications in wire order while server requests settle concurrently.
 */
export class CodexBackendSession implements BackendSession {
  /** Native binding committed by open and adopted through OutputSession by the SDK session. */
  binding: SessionBinding
  /** Session-local capability copy; missing optional native methods revoke support through the sink. */
  readonly capabilities: Capabilities
  /** Live state used by OutputSession at SDK attachment. Clone it to retain an independent snapshot. */
  state: SessionState
  /** Seed ready state from validated open parameters. Binding and capability clones can throw before transport attachment. */
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
  /** CodexNativeAdapter.openSession supplies the session client before the handshake. Dispose releases it after a successful open. */
  attach(client: CodexJsonlClient): void { this.client = client }
  /** Return the native identity CodexNativeAdapter.resolveFork can use for a canonical boundary, or undefined if unseen. */
  resolveNativeTurn(canonical: string): string | undefined { return this.nativeTurnIdByCanonicalId.get(canonical) }
  /** Copy the source's observed turn identities for CodexNativeAdapter.openSession before the fork opens. */
  importTurnMap(source: CodexBackendSession): void {
    this.canonicalTurnIdByNativeId = new Map(source.canonicalTurnIdByNativeId)
    this.nativeTurnIdByCanonicalId = new Map(source.nativeTurnIdByCanonicalId)
  }
  /** Open the native thread after the handshake and await any restored metadata publication. CodexNativeAdapter.openSession registers the backend on success and disposes the client if policy, identity, native, or sink errors reject. */
  async open(): Promise<void> {
    const threadOptions = this.threadOptions()
    const result = await this.openNativeThread(threadOptions)
    await this.restoreThread(result)
  }
  /**
   * OutputSession.execute dispatches validated requests here and consumes their receipts or results.
   * Submission, steer, interrupt, and compaction receipts acknowledge their respective requests.
   * Native notifications carry execution evidence separately. Admission, unsupported methods,
   * native errors, and sink failures can reject. The SDK registry handles interaction answers.
   */
  async execute<M extends SessionMethod>(method: M, params: AhpRequestMap[M]): Promise<AhpResultMap[M]> {
    let result: AhpResultMap[SessionMethod]
    const p: AhpRequestMap[SessionMethod] = params
    switch (method) {
      case 'input/submit': return await this.submitInput({ method: 'input/submit', params: p as AhpRequestMap['input/submit'] }) as AhpResultMap[M]
      case 'review/start': return await this.submitInput({ method: 'review/start', params: p as AhpRequestMap['review/start'] }) as AhpResultMap[M]
      case 'turn/steer':
        result = await this.steer(p as AhpRequestMap['turn/steer'])
        break
      case 'turn/interrupt': {
        const interrupt = p as AhpRequestMap['turn/interrupt']
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.nativeTurn({ canonical: interrupt.turnId, missing: 'TURN_MISMATCH' }) })
        result = { accepted: true, turnId: interrupt.turnId }
        break
      }
      case 'session/config/set':
        result = await this.setConfig((p as AhpRequestMap['session/config/set']).patch)
        break
      case 'session/revert':
        result = await this.revert(p as AhpRequestMap['session/revert'])
        break
      case 'history/read':
        result = await this.readHistory(p as AhpRequestMap['history/read'])
        break
      case 'goal/set':
      case 'goal/clear': {
        const disableGoal = () => { this.capabilities.goal = { actions: [] } }
        let goal: GoalState
        if (method === 'goal/set') {
          const { goal: requested } = p as AhpRequestMap['goal/set']
          const nativeGoal = Object.fromEntries(Object.entries(requested).filter(([key]) => ['objective', 'status', 'tokenBudget'].includes(key)))
          const value = record(await this.optional('thread/goal/set', { ...nativeGoal, threadId: this.threadId }, disableGoal))
          goal = { goal: json(value.goal) as JsonObject, status: 'active' }
        } else {
          await this.optional('thread/goal/clear', { threadId: this.threadId }, disableGoal)
          goal = { goal: null, status: 'cleared' }
        }
        this.state.goal = goal
        result = goal
        break
      }
      case 'compact/start': {
        await this.optional('thread/compact/start', { threadId: this.threadId }, () => { this.capabilities.compact = false })
        result = { maintenanceId: p.requestId, status: 'accepted' }
        break
      }
      case 'session/close': {
        await this.client.request('thread/unsubscribe', { threadId: this.threadId })
        // Only terminal evidence can confirm execution stopped.
        this.closing = true
        result = { closed: true, observationClosed: true, executionStopped: 'unconfirmed' }
        break
      }
      default: throw new HarnessSdkError('CAPABILITY_UNSUPPORTED') // interaction actions are owned by SDK registry
    }
    return result as AhpResultMap[M]
  }
  /**
   * CodexNativeAdapter.openSession registers this handler with CodexJsonlClient. The reader awaits
   * it before dispatching the next frame. Foreign-thread notifications are ignored once the local
   * identity is known. Projection or publication failures reject and fail the reader.
   */
  async notification(method: string, params: NativeRecord): Promise<void> {
    if (typeof params.threadId === 'string' && this.threadId && params.threadId !== this.threadId) return
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
    if (method === 'item/started' || method === 'item/completed') {
      await this.observeItem({ params, phase: method === 'item/completed' ? 'completed' : 'started' })
      return
    }
    const turnId = this.scope(params)
    if (method === 'turn/completed') {
      await this.completeTurn(record(params.turn))
      return
    }
    const deltaKind = DELTA_KIND_BY_METHOD[method]
    if (deltaKind) {
      await this.projectDelta({ method, params, turnId, kind: deltaKind })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      await this.projectUsage(params, turnId)
      return
    }
    if (method === 'turn/plan/updated' && turnId) {
      await this.projectPlan(params, turnId)
      return
    }
    if ((method === 'hook/started' || method === 'hook/completed') && turnId) {
      await this.projectHook({ params, turnId, phase: method === 'hook/started' ? 'started' : 'completed' })
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
   * encoder, then await SDK settlement. CodexNativeAdapter.openSession registers this handler with
   * CodexJsonlClient, which keeps draining stdout. Invalid or unsupported requests receive wire
   * errors. Projection and error-write failures reject to the transport fallback. The SDK invokes
   * the responder for answer delivery and when cancellation requires a native reply. This handler
   * absorbs sink rejection.
   */
  async serverRequest(request: NativeRequest, reply: (result: unknown) => Promise<void>, reject: (code: number, message: string) => Promise<void>): Promise<void> {
    const { params } = request
    if (params.threadId !== this.threadId) {
      await reject(-32602, 'Unknown thread')
      return
    }
    const turnId = this.scope(params)
    const itemId = string(params.itemId)
    const id = `codex:${typeof request.id}:${request.id}`
    const scope = { interactionId: id, ...(turnId ? { turnId } : {}), ...(itemId ? { itemId } : {}) }
    const projected = projectInteraction(request, scope)
    if ('code' in projected) {
      await reject(projected.code, projected.message)
      return
    }
    const { interaction, encode } = projected
    try { await this.sink.requestInteraction(interaction, answer => reply(encode(answer))) }
    catch { /* The SDK owns interaction settlement, including any cancellation reply. */ }
  }

  /** Forward CodexJsonlClient's transport failure to the sink while observation is open. Await the sink's failure handling and propagate its rejection. */
  async failure(cause: HarnessSdkError): Promise<void> { if (!this.closing) await this.sink.fail(cause) }
  /** Release the client for OutputSession.dispose or adapter teardown. Discard retained history and output before awaiting transport disposal. Process release failures reject. Execution stop stays unconfirmed. */
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

  /**
   * execute awaits the steer receipt for the specified execution. Reject an unknown target before
   * dispatch, or report an uncertain TURN_MISMATCH if native names another turn. Method absence
   * revokes steer support before rejection.
   */
  private async steer(params: AhpRequestMap['turn/steer']): Promise<AhpResultMap['turn/steer']> {
    const native = this.nativeTurn({ canonical: params.expectedTurnId, missing: 'TURN_MISMATCH' })
    const response = record(await this.optional('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: native,
      input: nativeInput(params.input),
      clientUserMessageId: params.submissionId,
    }, () => { delete this.capabilities.input!.steer }))
    if (response.turnId !== native) throw new HarnessSdkError('TURN_MISMATCH', 'Native steer did not target the same turn', false, true)
    return { submissionId: params.submissionId, turnId: params.expectedTurnId, accepted: true }
  }

  /**
   * notification awaits correlation and item publication before the next frame. A matching
   * user-message client ID can bind a pending submission even if its receipt carries a different ID.
   * Publish the binding before item snapshots. Missing item scope or sink failure rejects.
   */
  private async observeItem({ params, phase }: { params: NativeRecord; phase: ItemPhase }): Promise<void> {
    const item = record(params.item)
    const submissionId = string(item.clientId)
    const native = string(params.turnId)
    if (item.type === 'userMessage' && submissionId && native && this.awaitingTurnSubmissionIds.has(submissionId)) {
      const actual = await this.ensureStarted(native)
      await this.sink.bindSubmission(submissionId, actual)
      this.awaitingTurnSubmissionIds.delete(submissionId)
      this.receiptTurnIdBySubmissionId.delete(submissionId)
    }
    const turnId = this.scope(params)
    if (!turnId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native item has no turn')
    await this.projectItem({ params, turnId, phase })
  }

  /**
   * notification awaits session usage publication and retains scoped last usage for completeTurn.
   * Sink rejection fails the notification after any scoped usage has been stored.
   */
  private async projectUsage(params: NativeRecord, turnId: string | undefined): Promise<void> {
    const tokenUsage = record(params.tokenUsage)
    const lastUsage = mapUsage(tokenUsage.last, 'turn')
    const usage = mapUsage(tokenUsage.total, 'session')
    if (turnId) this.nativeUsage.set(turnId, lastUsage)
    if (typeof tokenUsage.modelContextWindow === 'number') usage.contextWindow = tokenUsage.modelContextWindow
    await this.sink.emit({ type: 'usage/updated', payload: usage }, { turnId })
  }

  /** Publish notification's scoped hook snapshot when a hook ID exists. Output sanitization and sink failures reject. */
  private async projectHook({ params, turnId, phase }: { params: NativeRecord; turnId: string; phase: ItemPhase }): Promise<void> {
    const hook = record(params.hook ?? params)
    const id = string(hook.id) ?? string(params.hookId)
    if (!id) return
    const item: Item = {
      id,
      type: 'hook',
      name: string(hook.name) ?? 'hook',
      status: phase === 'started' ? 'running' : 'completed',
      output: safe(hook.output),
    }
    await this.sink.emit({ type: phase === 'started' ? 'item/started' : 'item/completed', payload: { item } }, { turnId, itemId: id })
  }
  /** Translate a copy of the configuration for open and record the selected permission mode in SDK state. An explicit config permission mode takes precedence. Invalid policy can throw before dispatch. */
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
  /** Dispatch open's mode using its translated settings. Resume records the requested identity before I/O as a reply fallback. Fork throws for missing native evidence before dispatch. Native request failures reject without retry. */
  private openNativeThread(options: NativeRecord): Promise<unknown> {
    if (this.params.mode === 'new') return this.client.request('thread/start', options)
    if (this.params.mode === 'resume') {
      // SDK validation requires nativeRef for resume and fork data for fork before adapter dispatch.
      this.threadId = this.params.binding.nativeRef!.value
      return this.client.request('thread/resume', { ...options, threadId: this.threadId })
    }
    const fork = this.params.fork!
    const nativeId = fork.boundary.nativeTurnId
    if (!nativeId) throw new HarnessSdkError('BOUNDARY_NATIVE_ID_REQUIRED', 'Fork requires a resolved native turn identity')
    const sourceNative = fork.nativeRef?.value ?? this.params.binding.nativeRef?.value
    if (!sourceNative) throw new HarnessSdkError('SESSION_NATIVE_REF_REQUIRED', 'Fork requires the source native reference')
    return this.client.request('thread/fork', {
      ...options,
      threadId: sourceNative,
      ...(fork.boundary.relation === 'before' ? { beforeTurnId: nativeId } : { lastTurnId: nativeId }),
    })
  }
  /** Commit open's native identity and restored title before publishing metadata. Missing identity or sink failure rejects the open; CodexNativeAdapter.openSession then disposes its client. */
  private async restoreThread(result: unknown): Promise<void> {
    const thread = record(record(result).thread)
    this.threadId = string(thread.id) ?? this.threadId
    if (!this.threadId) throw new HarnessSdkError('PROTOCOL_ERROR', 'Native thread identity missing')
    this.binding = { ...this.binding, nativeRef: { provider: 'codex', value: this.threadId } }
    this.state.binding = this.binding
    if (typeof thread.name === 'string' || thread.name === null) this.state.metadata = { title: thread.name }
    if (this.state.metadata) await this.sink.emit({ type: 'session/metadata', payload: this.state.metadata })
  }
  /** Resolve a native identity for steer, interrupt, or revert. A supplied boundary ID takes precedence over observed evidence. Throw the operation's missing-identity code before dispatch. */
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
  /**
   * Use start, matching user-message, or terminal evidence from notification, observeItem, or
   * completeTurn. Publish the first start before activating the turn, then bind matching receipts to
   * the returned canonical ID. Sink failure leaves prior mutations in place and stops further binding.
   */
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
  private scope(params: NativeRecord): string | undefined {
    const native = string(params.turnId)
    return native ? this.registerNativeTurnIdentity(native) : undefined
  }
  /**
   * execute awaits input or review acceptance here. Check pending capacity (128 by default)
   * and conflicts before the one-time version warning. Track the submission before dispatch
   * so early notifications can bind it. A definite dispatch or receipt failure releases its
   * pending ID. An unknown outcome keeps any pending slot available to later execution evidence.
   */
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
      // Native may return the submitted client ID. A receipt can bind only to an observed execution.
      if (this.started.has(id)) {
        await this.sink.bindSubmission(params.submissionId, id)
        this.awaitingTurnSubmissionIds.delete(params.submissionId)
        if (previousTurns.has(id)) return { submissionId: params.submissionId, accepted: true, disposition: 'joined', turnId: id }
      } else if (this.awaitingTurnSubmissionIds.has(params.submissionId)) {
        this.receiptTurnIdBySubmissionId.set(params.submissionId, id)
      }
      return { submissionId: params.submissionId, accepted: true, disposition: 'accepted', receipt: { nativeSubmissionId: id } }
    } catch (cause) {
      if (!sdkError(cause).outcomeUnknown) this.awaitingTurnSubmissionIds.delete(params.submissionId)
      throw cause
    }
  }
  /**
   * For native input delivery, read account status before applying settings and dispatching turn/start.
   * Request overrides take precedence over session settings. Return the raw receipt to submitInput,
   * which owns correlation and pending-ID cleanup. Unsupported delivery, required authentication,
   * invalid settings, and transport failures reject.
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
  /**
   * Return an optional native method's reply. On method-not-found, invoke the caller's synchronous
   * capability mutation and await revised state publication before rejecting as unsupported.
   * Mutation or publication failure replaces that rejection. Other native errors propagate.
   */
  private async optional(method: string, params: NativeRecord, disable: () => void): Promise<unknown> {
    try { return await this.client.request(method, params) }
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
  /**
   * execute returns the applied conversation boundary after native revert or rollback succeeds,
   * or after the turn list shows an empty suffix. Invalidate snapshots after either success.
   * Unsupported scope, missing identity or required turn, and native or sink failures reject.
   */
  private async revert(params: AhpRequestMap['session/revert']): Promise<AhpResultMap['session/revert']> {
    if (params.scope !== 'conversation') throw new HarnessSdkError('CAPABILITY_UNSUPPORTED')
    const native = this.nativeTurn({ canonical: params.boundary.turnId, provided: params.boundary.nativeTurnId })
    const disableRevert = () => { this.capabilities.session!.revert = [] }
    if (this.native.profile.revert === 'thread/revert' && params.boundary.relation === 'before') {
      await this.optional('thread/revert', { threadId: this.threadId, beforeTurnId: native }, disableRevert)
    } else {
      const turns = await this.turns()
      const suffix = revertSuffix({ turns, nativeTurnId: native, relation: params.boundary.relation })
      if (suffix) {
        const request = this.native.profile.revert === 'thread/revert'
          ? { method: 'thread/revert', params: { threadId: this.threadId, beforeTurnId: suffix.first.id } }
          : { method: 'thread/rollback', params: { threadId: this.threadId, numTurns: suffix.count } }
        await this.optional(request.method, request.params, disableRevert)
      }
    }
    this.history.clear()
    return { appliedScope: 'conversation', boundary: params.boundary }
  }
  /** Fetch turns in native thread/read order or ascending page order for revert and legacy history. Malformed responses, page-limit overflow, and transport errors reject. */
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
  /** Return a detached item page for execute (200 items by default). A cursor selects a snapshot and offset. An explicit nonempty snapshot token must agree with the cursor. Invalid cursors, expired snapshots, or history fetch errors reject. */
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
    const items = this.native.profile.history === 'thread/items/list'
      ? await this.pagedHistoryItems()
      : await this.turnHistoryItems()
    const snapshotToken = randomUUID()
    this.history.set(snapshotToken, items)
    // Size > 8 proves the insertion-ordered map has an oldest key.
    if (this.history.size > 8) this.history.delete(this.history.keys().next().value!)
    return { token: snapshotToken, items }
  }
  /** historySnapshot awaits ascending item pages before retaining a snapshot. Enforce maxHistoryItems after each page (10,000 by default). Malformed entries, overflow, and native or sink errors reject. Method absence revokes history support. */
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
  /** historySnapshot awaits legacy items flattened in native turn/item order. Skip turns without identity or items. Fetch or projection failures reject, with no separate limit on flattened items. */
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
  /** Publish notification's plan start or patch before storing the latest plan for completeTurn. If publication fails, reject and keep the previous plan. */
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
   * observeItem awaits these snapshots after any submission correlation. Publish in map order.
   * Keep the first known start time, patch repeated starts, and fill missing tool output from the buffer.
   * Clear buffered output on completion before publication. Projection and sink failures reject.
   */
  private async projectItem({ params, turnId, phase }: { params: NativeRecord; turnId: string; phase: ItemPhase }): Promise<void> {
    const completed = phase === 'completed'
    for (const sourceItem of mapItems(params.item, completed, false, { startedAtMs: completed ? undefined : params.startedAtMs })) {
      const key = `${turnId}\0${sourceItem.id}`
      // Completed snapshots omit the start time; repeated starts must not reset it.
      const startedAt = this.itemStartedAt.get(key) ?? sourceItem.startedAt
      if (startedAt !== undefined) this.itemStartedAt.set(key, startedAt)
      const timedItem = startedAt !== undefined ? { ...sourceItem, startedAt } : sourceItem
      const output = this.executionOutput.get(key)
      const item = timedItem.type === 'toolCall' && timedItem.output == null && output !== undefined
        ? { ...timedItem, output }
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
    kind: NativeDeltaKind
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
   * notification awaits start/binding and plan completion before publishing the terminal result.
   * Missing identity or sink failures reject. Diagnostics, timing, usage, and active state retire
   * after successful terminal publication.
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
    this.retireTurn(canonical)
  }

  /** After completeTurn publishes a result, free transient buffers and recompute active state. Keep start and identity evidence for later receipts and boundaries. */
  private retireTurn(turnId: string): void {
    this.nativeUsage.delete(turnId)
    const itemKeyPrefix = `${turnId}\0`
    for (const cache of [this.executionOutput, this.itemStartedAt]) {
      for (const key of cache.keys()) {
        if (key.startsWith(itemKeyPrefix)) cache.delete(key)
      }
    }
    this.state.activeTurnIds = this.state.activeTurnIds.filter(id => id !== turnId)
    this.state.status = this.state.activeTurnIds.length ? 'running' : 'ready'
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

/** Scope allocated by serverRequest. Including the native ID type distinguishes numeric and string IDs with the same text. */
type InteractionScope = { interactionId: string; turnId?: string; itemId?: string }

/** A request-local prompt/responder pair, or the native error serverRequest must send instead of registering an interaction. */
type InteractionProjection =
  | { interaction: InteractionRequested; encode: (answer: InteractionResponse | null) => unknown }
  | { code: number; message: string }

type ItemPhase = 'started' | 'completed'
type NativeDeltaKind = 'text' | 'reasoningSummary' | 'output' | 'patch'

/** Route native text and diagnostic delta methods to the corresponding SDK item delta. */
const DELTA_KIND_BY_METHOD: Partial<Record<string, NativeDeltaKind>> = {
  'item/agentMessage/delta': 'text',
  'item/reasoning/summaryTextDelta': 'reasoningSummary',
  'item/reasoning/textDelta': 'reasoningSummary',
  'item/commandExecution/outputDelta': 'output',
  'item/fileChange/outputDelta': 'output',
  'item/plan/delta': 'text',
}

/**
 * Find the suffix revert removes from the ascending native turn list. A through boundary
 * retains the named turn. Return undefined for an empty suffix and throw if the boundary is absent.
 */
function revertSuffix({ turns, nativeTurnId, relation }: {
  turns: NativeRecord[]
  nativeTurnId: string
  relation: AhpRequestMap['session/revert']['boundary']['relation']
}): { first: NativeRecord; count: number } | undefined {
  const index = turns.findIndex(turn => turn.id === nativeTurnId)
  if (index < 0) throw new HarnessSdkError('TURN_NOT_FOUND')
  const start = index + (relation === 'through' ? 1 : 0)
  const first = turns[start]
  if (first) return { first, count: turns.length - start }
}

/**
 * Build the prompt and its responder for serverRequest. Keep encoder state local to each
 * request so interactions can overlap independently. Return wire errors for unsupported methods
 * or unusable approvals. Serialization failures throw to the transport fallback.
 */
function projectInteraction({ method, params }: NativeRequest, scope: InteractionScope): InteractionProjection {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
      return projectApproval({ method, params, scope })
    case 'item/tool/requestUserInput':
      return projectUserInput(params, scope)
    case 'mcpServer/elicitation/request':
      return projectElicitation(params, scope)
    case 'item/tool/call':
      return projectDynamicTool(params, scope)
    default:
      return { code: -32601, message: 'Unsupported native request' }
  }
}

/**
 * Pair approval choices with the native values their encoder can return, using standard choices
 * when the server omits its decision array. Return a wire error for an empty supported set.
 * Prompt data is sanitized before publication, which can throw.
 */
function projectApproval({ method, params, scope }: {
  method: string
  params: NativeRecord
  scope: InteractionScope
}): InteractionProjection {
  const advertised = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel']
  const decisions = new Map<string, unknown>()
  const options = advertised.flatMap<ApprovalOption>(
    /** Advertise supported choices and retain their exact native values for this request's encoder; unsupported choices disappear without authorizing anything. */
    (decision, i) => {
      if (typeof decision === 'string' && ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) {
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
  const interaction: InteractionRequested = {
    ...scope,
    kind: 'approval',
    title: string(params.reason) ?? 'Approval required',
    options,
    input: safe({ command: params.command, permissions: params.permissions, cwd: params.cwd }),
  }
  /** Encode an SDK answer against this request's advertised decisions; absent/invalid answers cancel or grant no permissions, without I/O. */
  const encode = (answer: InteractionResponse | null) => {
    const decision = answer?.kind === 'approval' ? decisions.get(answer.optionId) : 'cancel'
    if (method === 'item/permissions/requestApproval') {
      return {
        permissions: decision === 'accept' || decision === 'acceptForSession' ? params.permissions : {},
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      }
    }
    return { decision: decision ?? 'cancel' }
  }
  return { interaction, encode }
}

/** Preserve question IDs and secret-input intent. The responder translates advertised choice IDs back to labels and passes free text through. */
function projectUserInput(params: NativeRecord, scope: InteractionScope): InteractionProjection {
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(
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
  const interaction: InteractionRequested = { ...scope, kind: 'userInput', questions }
  /** Translate SDK choice IDs back to this prompt's labels; cancellation returns no answers, with no I/O or mutation. */
  const encode = (answer: InteractionResponse | null) => ({
    answers: answer?.kind === 'userInput' ? Object.fromEntries(Object.entries(answer.answers).map(
      /** Encode one native question answer, preserving free text and selection order when no advertised label matches. */
      ([key, value]) => {
        const q = questions.find(question => question.id === key)
        const selected = Array.isArray(value) ? value : [value]
        return [key, { answers: selected.map(v => q?.options?.find(option => option.id === v)?.label ?? String(v)) }]
      },
    )) : {},
  })
  return { interaction, encode }
}

/** Keep URL-mode data private in the SDK prompt and return content only for accepted responses. Schema serialization can throw. */
function projectElicitation(params: NativeRecord, scope: InteractionScope): InteractionProjection {
  // Newer native schemas may carry mode-specific fields through anyOf branches.
  const mode = params.mode === 'url' || typeof params.url === 'string' ? 'url' : 'form'
  const interaction: InteractionRequested = {
    ...scope,
    kind: 'elicitation',
    mode,
    ...(params.requestedSchema ? { schema: json(params.requestedSchema) as JsonObject } : {}),
    message: string(params.message) ?? 'MCP input required',
    ...(mode === 'url' ? { privatePayload: { url: string(params.url) ?? '' } } : {}),
  }
  /** Encode only accepted elicitation content. Absent and wrong-kind answers cancel. */
  const encode = (answer: InteractionResponse | null) => ({
    action: answer?.kind === 'elicitation' ? answer.action : 'cancel',
    content: answer?.kind === 'elicitation' && answer.action === 'accept' ? answer.content ?? null : null,
  })
  return { interaction, encode }
}

/** Project native tool arguments into the prompt and encode text and image results in source order. Argument serialization can throw. */
function projectDynamicTool(params: NativeRecord, scope: InteractionScope): InteractionProjection {
  const interaction: InteractionRequested = {
    ...scope,
    kind: 'dynamicTool',
    toolName: string(params.tool) ?? string(params.name) ?? 'unknown',
    arguments: json(params.arguments ?? {}) as JsonObject,
  }
  /** Encode SDK tool success and native-compatible content in order; cancellation is unsuccessful with no output and no I/O. */
  const encode = (answer: InteractionResponse | null) => ({
    success: answer?.kind === 'dynamicTool' && !answer.isError,
    contentItems: answer?.kind === 'dynamicTool' ? answer.content.flatMap<NativeRecord>(block =>
      block.type === 'text' ? [{ type: 'inputText', text: block.text }]
        : block.type === 'image' ? [{ type: 'inputImage', imageUrl: block.url ?? `data:${block.mimeType};base64,${block.data}` }]
        : [],
    ) : [],
  })
  return { interaction, encode }
}
